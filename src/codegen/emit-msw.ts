/**
 * wiretype codegen — MSW v2 handler emitter (`handlers.ts`).
 */

import type { ApiModel, Endpoint, EndpointResponse, JsonValue } from '../core/index.js';
import type { CodegenOptions, GeneratedFile } from './options.js';
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

/** Stable default-import identifier for a fixture, e.g. `getApiUsersResponse200`. */
export function fixtureImportName(operationId: string, status: number): string {
  return `${operationId}Response${status}`;
}

/** GeneratedFile path of a fixture, e.g. `fixtures/getApiUsers.200.json`. */
export function fixturePath(operationId: string, status: number): string {
  return `fixtures/${operationId}.${status}.json`;
}

/** Response variants in deterministic (ascending status) order. */
function orderedResponses(ep: Endpoint): EndpointResponse[] {
  return [...ep.responses].sort((a, b) => a.status - b.status);
}

/** Render a single MSW handler expression for a specific response variant. */
function renderHandler(
  ep: Endpoint,
  base: string,
  resp: EndpointResponse,
  indent: number,
  useFixtures: boolean,
): string {
  const method = mswMethod(ep.method);
  const url = handlerUrl(base, ep.pattern);
  const bodyIndent = indent + 2;
  if (resp.sampleBody === undefined) {
    return `${pad(indent)}http.${method}('${url}', () => new HttpResponse(null, { status: ${resp.status} }))`;
  }
  const body = useFixtures
    ? fixtureImportName(ep.operationId, resp.status)
    : jsonLiteral(resp.sampleBody, bodyIndent);
  return (
    `${pad(indent)}http.${method}('${url}', () =>\n` +
    `${pad(indent + 1)}HttpResponse.json(${body}, { status: ${resp.status} }),\n` +
    `${pad(indent)})`
  );
}

/**
 * One fixture file per response variant that has a sampleBody, at
 * `fixtures/<operationId>.<status>.json`, pretty-printed with 2 spaces.
 * Deterministic: model endpoint order, then ascending status.
 */
export function generateMswFixtures(model: ApiModel): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const ep of model.endpoints) {
    for (const resp of orderedResponses(ep)) {
      if (resp.sampleBody === undefined) continue;
      files.push({
        path: fixturePath(ep.operationId, resp.status),
        content: `${JSON.stringify(resp.sampleBody, null, 2)}\n`,
      });
    }
  }
  return files;
}

export function generateMsw(model: ApiModel, opts: CodegenOptions = {}): string {
  const banner = opts.banner ?? DEFAULT_BANNER;
  const base = opts.mswBaseUrl ?? '*';
  const useFixtures = opts.mswFixtures === true;

  const entries: string[] = [];

  for (const ep of model.endpoints) {
    const successStatus = pickSuccessStatus(ep);
    const success = ep.responses.find((r) => r.status === successStatus);
    const others = ep.responses.filter((r) => r.status !== successStatus);

    const block: string[] = [];
    block.push(`${pad(1)}// ${endpointKey(ep)}`);
    if (success) {
      block.push(`${renderHandler(ep, base, success, 1, useFixtures)},`);
    }
    // Non-success variants as commented alternatives.
    for (const resp of others) {
      const alt = renderHandler(ep, base, resp, 1, useFixtures);
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

  // Thin mode: import every fixture (same order as the fixture files).
  // Consumers may need `resolveJsonModule: true` for the .json imports.
  const imports: string[] = [];
  if (useFixtures) {
    for (const ep of model.endpoints) {
      for (const resp of orderedResponses(ep)) {
        if (resp.sampleBody === undefined) continue;
        imports.push(
          `import ${fixtureImportName(ep.operationId, resp.status)} from './${fixturePath(ep.operationId, resp.status)}';`,
        );
      }
    }
  }
  const head =
    imports.length > 0
      ? `import { http, HttpResponse } from 'msw';\n${imports.join('\n')}\n\n`
      : `import { http, HttpResponse } from 'msw';\n\n`;

  return `${bannerComment(banner)}${head}${list}\n`;
}
