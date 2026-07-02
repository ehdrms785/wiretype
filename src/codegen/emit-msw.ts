/**
 * wiretype codegen — MSW v2 handler emitter (`handlers.ts`).
 */

import type { ApiModel, Endpoint, EndpointResponse, JsonValue } from '../core/index.js';
import type { CodegenOptions } from './options.js';
import { DEFAULT_BANNER, bannerComment, endpointKey, pad, pickSuccessStatus } from './naming.js';

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);

/** MSW `http[method]` accessor for an endpoint method, defaulting to `all`. */
function mswMethod(method: string): string {
  const m = method.toLowerCase();
  return HTTP_METHODS.has(m) ? m : 'all';
}

/**
 * Pretty-print a JSON value with 2-space indentation, then re-indent every
 * line after the first by `baseIndent` levels so it nests cleanly inside the
 * generated source.
 */
function jsonLiteral(value: JsonValue, baseIndent: number): string {
  const raw = JSON.stringify(value, null, 2);
  const lines = raw.split('\n');
  return lines
    .map((line, i) => (i === 0 ? line : `${pad(baseIndent)}${line}`))
    .join('\n');
}

/** Full URL pattern for a handler (mswBaseUrl prefix + endpoint pattern). */
function handlerUrl(base: string, pattern: string): string {
  return `${base}${pattern}`;
}

/** Render a single MSW handler expression for a specific response variant. */
function renderHandler(
  ep: Endpoint,
  base: string,
  resp: EndpointResponse,
  indent: number,
): string {
  const method = mswMethod(ep.method);
  const url = handlerUrl(base, ep.pattern);
  const bodyIndent = indent + 2;
  if (resp.sampleBody === undefined) {
    return `${pad(indent)}http.${method}('${url}', () => new HttpResponse(null, { status: ${resp.status} }))`;
  }
  const body = jsonLiteral(resp.sampleBody, bodyIndent);
  return (
    `${pad(indent)}http.${method}('${url}', () =>\n` +
    `${pad(indent + 1)}HttpResponse.json(${body}, { status: ${resp.status} }),\n` +
    `${pad(indent)})`
  );
}

export function generateMsw(model: ApiModel, opts: CodegenOptions = {}): string {
  const banner = opts.banner ?? DEFAULT_BANNER;
  const base = opts.mswBaseUrl ?? '*';

  const entries: string[] = [];

  for (const ep of model.endpoints) {
    const successStatus = pickSuccessStatus(ep);
    const success = ep.responses.find((r) => r.status === successStatus);
    const others = ep.responses.filter((r) => r.status !== successStatus);

    const block: string[] = [];
    block.push(`${pad(1)}// ${endpointKey(ep)}`);
    if (success) {
      block.push(`${renderHandler(ep, base, success, 1)},`);
    }
    // Non-success variants as commented alternatives.
    for (const resp of others) {
      const alt = renderHandler(ep, base, resp, 1);
      const commented = alt
        .split('\n')
        .map((line) => `${pad(1)}// ${line.slice(pad(1).length)}`)
        .join('\n');
      block.push(`${commented},`);
    }
    entries.push(block.join('\n'));
  }

  const list =
    entries.length > 0
      ? `export const handlers = [\n${entries.join('\n\n')}\n];`
      : 'export const handlers = [];';

  return `${bannerComment(banner)}import { http, HttpResponse } from 'msw';\n\n${list}\n`;
}
