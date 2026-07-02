import { randomUUID } from 'node:crypto';
import type {
  CapturedRequest,
  CapturedResponse,
  Exchange,
  JsonValue,
  RecorderOptions,
} from '../core/index.js';

/** Default max captured body size: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Default header names to redact. */
export const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

const REDACTED = '[redacted]';

/**
 * Normalize a raw node header bag into a flat Record<string,string> with
 * lowercased keys, array values joined with ', ', and sensitive headers
 * redacted to '[redacted]'.
 */
export function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
  redact: string[],
): Record<string, string> {
  const redactSet = new Set(redact.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (redactSet.has(lower)) {
      out[lower] = REDACTED;
      continue;
    }
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Parse the query portion of a URL into Record<string,string[]>, preserving
 * multiple values per key. Accepts a full URL or a path+query string.
 */
export function parseQuery(url: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return out;
  const search = new URLSearchParams(url.slice(qIndex + 1));
  for (const [key, value] of search.entries()) {
    const existing = out[key];
    if (existing) {
      existing.push(value);
    } else {
      out[key] = [value];
    }
  }
  return out;
}

/** Pathname only (strip query + hash). Input may be path or full URL. */
export function pathOnly(url: string): string {
  let end = url.length;
  const q = url.indexOf('?');
  if (q !== -1) end = Math.min(end, q);
  const h = url.indexOf('#');
  if (h !== -1) end = Math.min(end, h);
  return url.slice(0, end);
}

function contentTypeOf(headers: Record<string, string>): string | undefined {
  return headers['content-type'];
}

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('json');
}

/**
 * Decode a captured body Buffer into { text, json, truncated }. If the body
 * exceeds maxBodyBytes it is truncated and never JSON-parsed. JSON parsing is
 * only attempted when the content-type indicates JSON and the body is not
 * truncated. Binary/empty bodies yield no text.
 */
function decodeBody(
  body: Buffer,
  contentType: string | undefined,
  maxBodyBytes: number,
): { bodyText?: string; bodyJson?: JsonValue } {
  if (body.length === 0) return {};

  const truncated = body.length > maxBodyBytes;
  const sliced = truncated ? body.subarray(0, maxBodyBytes) : body;
  const text = sliced.toString('utf8');

  const result: { bodyText?: string; bodyJson?: JsonValue } = { bodyText: text };

  if (!truncated && isJsonContentType(contentType)) {
    try {
      result.bodyJson = JSON.parse(text) as JsonValue;
    } catch {
      // keep bodyText, omit bodyJson
    }
  }
  return result;
}

/**
 * Build an Exchange from raw request/response parts. Shared by the proxy and
 * the vite plugin. Headers are normalized + redacted, query parsed, JSON
 * bodies parsed when applicable.
 */
export function buildExchange(input: {
  method: string;
  url: string;
  reqHeaders: Record<string, string | string[] | undefined>;
  reqBody: Buffer;
  status: number;
  resHeaders: Record<string, string | string[] | undefined>;
  resBody: Buffer;
  startedAt: number;
  endedAt: number;
  opts?: RecorderOptions;
}): Exchange {
  const maxBodyBytes = input.opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const redact = input.opts?.redactHeaders ?? DEFAULT_REDACT_HEADERS;

  const reqHeaders = normalizeHeaders(input.reqHeaders, redact);
  const resHeaders = normalizeHeaders(input.resHeaders, redact);

  const reqBody = decodeBody(input.reqBody, contentTypeOf(reqHeaders), maxBodyBytes);
  const resBody = decodeBody(input.resBody, contentTypeOf(resHeaders), maxBodyBytes);

  const request: CapturedRequest = {
    method: input.method.toUpperCase(),
    url: input.url,
    path: pathOnly(input.url),
    query: parseQuery(input.url),
    headers: reqHeaders,
  };
  if (reqBody.bodyText !== undefined) request.bodyText = reqBody.bodyText;
  if (reqBody.bodyJson !== undefined) request.bodyJson = reqBody.bodyJson;

  const response: CapturedResponse = {
    status: input.status,
    headers: resHeaders,
    durationMs: input.endedAt - input.startedAt,
  };
  if (resBody.bodyText !== undefined) response.bodyText = resBody.bodyText;
  if (resBody.bodyJson !== undefined) response.bodyJson = resBody.bodyJson;

  return {
    id: randomUUID(),
    startedAt: input.startedAt,
    request,
    response,
  };
}

/** true when path passes include/exclude prefix filters. */
export function shouldRecord(path: string, opts?: RecorderOptions): boolean {
  const include = opts?.includePrefixes;
  const exclude = opts?.excludePrefixes;

  if (include && include.length > 0) {
    if (!include.some((prefix) => path.startsWith(prefix))) return false;
  }
  if (exclude && exclude.length > 0) {
    if (exclude.some((prefix) => path.startsWith(prefix))) return false;
  }
  return true;
}
