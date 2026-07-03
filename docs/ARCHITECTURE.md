# wiretype — Architecture & Module Contracts

> Record real API traffic through a proxy → infer a typed model → generate
> TypeScript types, zod schemas, MSW v2 handlers, and OpenAPI 3.1.

This document is the **binding contract** between modules. Implementations
may add internal helpers freely, but the exported signatures below must match
exactly. Shared data types live in `src/core/types.ts` (single source of
truth — read it first).

## Package layout

`wiretype` is a single publishable npm package. Source lives under `src/`,
compiled with `tsc` to `dist/`:

```
wiretype/
  src/
    core/     shape inference, merging, endpoint model, recording store
    codegen/  4 emitters: ts / zod / msw / openapi
    proxy/    zero-dependency recording HTTP proxy + shared capture helpers
    cli/      `wiretype` CLI (record / gen / ui / list) + viewer server
    vite/     Vite dev-server integration
    index.ts  public library entry
  viewer/     single-file HTML viewer served by `wiretype ui`
  examples/
    demo-api/ zero-dep Node demo API to record against
  docs/
```

ESM (`"type": "module"`), TypeScript strict, Node >= 20. Built with `tsc`.
Tests: vitest, colocated as `src/**/*.test.ts`. The only runtime dependency is
`commander` (CLI); `vite` is an optional peer used only by the Vite plugin and
imported type-only in source. Use `node:` builtin imports (`node:http`,
`node:fs/promises`, `node:crypto`, ...).

Import rules inside `src/`:

- Relative imports must use the `.js` extension (NodeNext resolution),
  e.g. `import { inferShape } from './infer.js'`.
- Cross-module imports use relative paths, e.g. from `src/codegen` import core
  via `import type { ApiModel } from '../core/index.js'`.

### package.json wiring

- `bin`: `{ "wiretype": "./dist/cli/index.js" }` — `src/cli/index.ts` keeps the
  `#!/usr/bin/env node` shebang first.
- `exports`:
  - `"."` → `./dist/index.js` (types `./dist/index.d.ts`) — the library entry
    re-exporting core + codegen + proxy.
  - `"./vite"` → `./dist/vite/index.js` — the Vite plugin.
- `tsconfig` excludes `src/**/*.test.ts` and `src/codegen/fixture.ts` from the
  build; the fixture is used by tests only.

---

## Core — exported API (`src/core`)

```ts
// re-export everything from types.ts
export * from './types.js';

/** Infer the Shape of a single JSON value. Never returns a union with duplicates. */
export function inferShape(value: JsonValue, opts?: BuildModelOptions): Shape;

/** Merge two shapes into one that accepts both. Commutative, associative-enough. */
export function mergeShapes(a: Shape, b: Shape, opts?: BuildModelOptions): Shape;

/** Structural equality (order-insensitive for union variants and object keys). */
export function shapesEqual(a: Shape, b: Shape): boolean;

/**
 * Group a recording's exchanges into endpoints:
 *  - normalize paths (numeric / uuid / long-hash segments -> :params)
 *  - merge request/response body shapes per endpoint per status
 *  - infer query shape, detect enums & string formats
 */
export function buildApiModel(recording: Recording, opts?: BuildModelOptions): ApiModel;

/** Derive operationId + typeName from method and normalized pattern. */
export function operationName(method: string, pattern: string): { operationId: string; typeName: string };

/**
 * NDJSON-backed store. Layout on disk:
 *   <dir>/<name>/meta.json          RecordingMeta
 *   <dir>/<name>/exchanges.ndjson   one Exchange per line
 */
export class RecordingStore {
  constructor(dir: string);               // dir default used by callers: ".wiretype"
  init(name: string, target: string): Promise<void>;   // create or open recording
  append(name: string, exchange: Exchange): Promise<void>; // appends + updates meta
  load(name: string): Promise<Recording>;               // throws if missing
  list(): Promise<RecordingMeta[]>;
  remove(name: string): Promise<void>;
}
```

### Inference rules (normative)

- Numbers with `Number.isInteger` -> `integer`, else `number`. Merging
  integer+number -> number.
- String formats (`uuid`, `date-time`, `date`, `email`, `uri`): a format is
  kept only while **every** merged sample matches it.
- Merging two objects: union of keys; a key missing on either side becomes
  `optional: true`. Field shapes merge recursively.
- Merging different kinds (e.g. string vs object) -> union. Unions are
  flattened, deduped via `shapesEqual`, and `null` stays a separate variant.
- Array elements: merge all element shapes into one. Empty array -> `element: null`;
  merging with a non-empty array adopts the element shape.
- Enum detection (in buildApiModel): only for token-like strings matching
  `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/`; requires samples >= `enumMinSamples`
  (4), distinct values <= `enumMaxValues` (8), and repetition
  (distinct <= ceil(samples / 2)). Never for numbers, booleans, or when a
  string format was detected. (Emitters still render numeric enums when a
  hand-built model supplies them.)
- Record detection: an object with >= `recordMinKeys` (12) keys whose value
  shapes are all equal -> `RecordShape`.
- Path normalization: a segment becomes a param when it is all-digits
  (`format: 'integer'`, name from previous segment: `/users/42` -> `:userId`...
  use singular previous segment + "Id"; fallback `param<i>`), a UUID
  (`format: 'uuid'`), or a hex/base64-ish token of length >= 16. Two exchanges
  belong to the same endpoint when method matches and normalized patterns match.

## Codegen — exported API (`src/codegen`)

```ts
import type { ApiModel, Shape } from '../core/index.js';

export interface CodegenOptions {
  /** Header comment banner. Default: "Generated by wiretype — do not edit." */
  banner?: string;
  /** Base URL used in MSW handlers. Default: "*" (match any origin) + pattern. */
  mswBaseUrl?: string;
}

export interface GeneratedFile { path: string; content: string; }

export function renderShapeAsTs(shape: Shape, indent?: number): string;   // inline TS type text
export function renderShapeAsZod(shape: Shape, indent?: number): string;  // inline zod expression text

export function generateTypes(model: ApiModel, opts?: CodegenOptions): string;    // -> types.ts content
export function generateZod(model: ApiModel, opts?: CodegenOptions): string;      // -> schemas.ts content
export function generateMsw(model: ApiModel, opts?: CodegenOptions): string;      // -> handlers.ts content
export function generateOpenApi(model: ApiModel, opts?: CodegenOptions): Record<string, unknown>; // OpenAPI 3.1 doc

/** All targets. paths: types.ts, schemas.ts, handlers.ts, openapi.json */
export function generateAll(model: ApiModel, targets?: Array<'ts'|'zod'|'msw'|'openapi'>, opts?: CodegenOptions): GeneratedFile[];
```

### Emitter requirements

- **types.ts**: for each endpoint emit (when applicable)
  `export interface {TypeName}Response` (or `type` for non-objects; for multi-status
  endpoints, suffix non-2xx as `{TypeName}Response{Status}`), `{TypeName}Request`,
  `{TypeName}Query`, `{TypeName}Params` (params always `string` values).
  Also emit a summary `export interface ApiEndpoints` mapping
  `"GET /api/users/:userId"` keys to `{ params, query, request, response }`.
  Optional fields use `?:`. Formats/enums render as comments or literal unions
  (enums -> literal union types).
- **schemas.ts**: zod v3. `import { z } from 'zod'`. One
  `export const {operationId}ResponseSchema = z.object({...})` per variant, plus
  request/query schemas when present. `date-time`/`uuid`/`email`/`uri` formats map to
  `z.string().datetime()` / `.uuid()` / `.email()` / `.url()`. Enums -> `z.enum([...])`
  or `z.union([z.literal(...)])` for numbers. Optional -> `.optional()`,
  null variant -> `.nullable()`. `integer` -> `z.number().int()`.
- **handlers.ts**: MSW v2 (`import { http, HttpResponse } from 'msw'`).
  One handler per endpoint using the 2xx (or lowest) status variant's
  `sampleBody` as mock data: `http.get('*/api/users/:userId', () => HttpResponse.json(sample, { status: 200 }))`.
  Path params in MSW syntax (`:userId` works as-is). Export
  `export const handlers = [ ... ]`. Include a commented alternative for each
  non-2xx variant.
- **openapi.json**: valid OpenAPI 3.1 (info/servers/paths). Shapes -> JSON
  Schema (integer -> `{type:"integer"}`, formats -> `format`, enums -> `enum`,
  optional -> omitted from `required`, unions -> `anyOf`, null variant ->
  include `"null"` in type union per 3.1 style). Path params as `{userId}`
  with `parameters`. Query params from queryShape fields.

Output must be deterministic (stable key ordering: endpoints sorted as in
model; object fields in first-seen order preserved by core).

## Proxy — exported API (`src/proxy`)

```ts
import type { RecorderOptions, Exchange } from '../core/index.js';

export interface ProxyServerOptions extends RecorderOptions {
  target: string;                       // upstream base URL
  port: number;                         // listen port
  onExchange: (ex: Exchange) => void | Promise<void>;  // called for every recorded exchange
  onError?: (err: Error) => void;
  /** Also print a compact line per request to stdout. Default true. */
  quiet?: boolean;
}

export interface RunningProxy { port: number; close(): Promise<void>; }

/** Zero-dependency reverse proxy on node:http. Streams bodies, captures up to maxBodyBytes. */
export function startProxy(opts: ProxyServerOptions): Promise<RunningProxy>;

/** Shared capture helper (used by proxy AND the vite plugin): build an Exchange from raw parts. */
export function buildExchange(input: {
  method: string; url: string;
  reqHeaders: Record<string, string | string[] | undefined>;
  reqBody: Buffer; status: number;
  resHeaders: Record<string, string | string[] | undefined>;
  resBody: Buffer; startedAt: number; endedAt: number;
  opts?: RecorderOptions;
}): Exchange;

/** true when path passes include/exclude prefix filters. */
export function shouldRecord(path: string, opts?: RecorderOptions): boolean;
```

Proxy behavior: forward method/headers/body to `target`, stream response back
unchanged (support gzip/br passthrough — capture the *decoded* body when
content-encoding is gzip/deflate/br using node:zlib, but forward raw bytes).
Never crash on upstream errors: respond 502 and call onError. WebSocket
upgrade requests: pass through without recording (or reject cleanly) — must
not crash.

## CLI — commands (`src/cli`)

Binary name: `wiretype` (package.json `bin`). Uses `commander`.

```
wiretype record  --target <url> [--port 5050] [--name <recording>] [--dir .wiretype]
                 [--include <prefix...>] [--exclude <prefix...>]
      Starts proxy, appends every exchange to the store via RecordingStore.
      Prints per-request lines: "GET /api/users 200 12ms (34 exchanges)".
      Graceful Ctrl-C: close proxy, print summary.

wiretype gen     [--name <recording>] [--dir .wiretype] [--out wiretype-generated]
                 [--targets ts,zod,msw,openapi]
      Loads recording -> buildApiModel -> generateAll -> writes files.
      Prints a per-endpoint summary table (method, pattern, statuses, samples).

wiretype list    [--dir .wiretype]
      Table of recordings (name, target, exchanges, updated).

wiretype ui      [--dir .wiretype] [--port 5099]
      Serves the viewer (single HTML file at <package root>/viewer/index.html,
      resolved at runtime via new URL('../../viewer/index.html', import.meta.url)
      from dist/cli/) plus a JSON API (below). Opens no browser automatically;
      prints the URL. The env var WIRETYPE_VIEWER_HTML overrides the HTML path.
```

### Viewer JSON API (served by `wiretype ui`)

```
GET /api/recordings                      -> RecordingMeta[]
GET /api/recordings/:name                -> Recording          (full exchanges)
GET /api/recordings/:name/model         -> ApiModel
GET /api/recordings/:name/generated/:target  -> text/plain content
      :target = ts | zod | msw | openapi
```

CORS: allow *. 404 as `{ "error": "..." }`. Static: `GET /` -> viewer HTML.

## Vite plugin — exported API (`src/vite`, exposed as `wiretype/vite`)

```ts
import type { Plugin } from 'vite';
import type { RecorderOptions } from '../core/index.js';

export interface WiretypePluginOptions extends RecorderOptions {
  /** Upstream API base URL, e.g. "http://localhost:8080". */
  target: string;
  /** Path prefixes to intercept+forward, e.g. ["/api"]. Required. */
  prefixes: string[];
  /** Recording name. Default "vite". */
  name?: string;
  /** Store directory. Default ".wiretype". */
  dir?: string;
  /**
   * Master switch. When omitted (the recommended setup), recording
   * auto-enables if the Vite dev server runs in mode "record"
   * (`vite --mode record`) OR the WIRETYPE env var is set. Set an explicit
   * boolean to override. This is what lets users avoid `WIRETYPE=1`: they
   * add the plugin unconditionally and run `vite --mode record`.
   */
  enabled?: boolean;
}

export default function wiretypeRecorder(options: WiretypePluginOptions): Plugin;
```

Implementation: `configResolved(config)` captures `config.mode`; the effective
enabled flag is `options.enabled ?? (config.mode === 'record' || !!process.env.WIRETYPE)`.
`configureServer(server)` adds a middleware BEFORE vite's internals; when
enabled, requests matching `prefixes` are forwarded to `target` with node:http,
recorded via `buildExchange` + `RecordingStore`, and the response is written
back (replacing the user's `server.proxy` entry for those prefixes). When
disabled the plugin is inert (calls `next()`), so it is safe to leave in the
plugins array permanently. `vite` is an optional peer dependency.

## v0.2 additions — MSW fixtures + localized reports

### MSW fixture separation (codegen)

`CodegenOptions` gains `mswFixtures?: boolean` (default false). `emit-msw.ts`
and `generateAll` honor it:

- false (current behavior): `handlers.ts` inlines each mock body literal.
- true: `handlers.ts` becomes thin — each handler imports its mock from
  `./fixtures/<operationId>.<status>.json` (relative import with
  `assert { type: 'json' }` omitted; use `import x from './fixtures/..json' with { type: 'json' }`? NO — for portability emit `import x from './fixtures/<...>.json'` and let the bundler resolve; document that consumers may need resolveJsonModule). `generateAll` additionally returns one `GeneratedFile` per fixture at path
  `fixtures/<operationId>.<status>.json` containing the pretty-printed sample
  body. This keeps mock DATA in JSON files so refreshing data never touches
  handler code — the key enabler for `msw-refresh`.

CLI: `wiretype gen --msw-fixtures` sets the flag. Deterministic output.

### Localized markdown report (diff)

`wiretype diff` gains `--md` and `--lang <en|ko>` (default en):

- `--md`: emit a Markdown drift report to stdout instead of the plain table:
  a title, a summary line, and one `##` section per severity with a Markdown
  findings table (Kind | Endpoint | Path | Change). Deterministic.
- `--lang`: localize the human-facing strings (severity headings, kind labels,
  summary sentence, "no drift detected") via an internal message catalog
  covering `en` and `ko`. Machine fields (endpoint, path, before→after) are not
  translated. Unknown lang → fall back to `en`. `--json` output is never
  localized. Skills pass `--lang` to match the conversation language and layer
  code locations on top of the `--md` output.

Add a `src/drift/i18n.ts` with a typed catalog `Record<'en'|'ko', {...}>` and a
`renderMarkdownReport(report, lang)` function exported from `src/drift/index.ts`.

## examples/demo-api

Zero-dep `server.mjs` (node:http, port 8080, `PORT` env respected) with
realistic data — enough variety to exercise ALL inference features:

- `GET /api/users?page=&limit=&role=`  paginated list; users have uuid ids,
  ISO dates, optional `avatarUrl`, `role` enum (admin|editor|viewer),
  nullable `lastLoginAt`.
- `GET /api/users/:id`   200 for known ids, 404 `{error, code}` otherwise.
- `POST /api/users`      201 echo with generated id; body: name/email/role.
- `GET /api/posts/:id`   post with nested `author`, `tags: string[]`,
  `stats: {views, likes}`, and `comments` array of objects.
- `PATCH /api/posts/:id` 200 partial update echo.
- `GET /api/health`      plain text "ok" (non-JSON — must not break inference).
- The extra experimental field on `GET /api/users` appears deterministically
  when `page` is even, so optional detection is observable.

`traffic.mjs` fires a scripted set of requests against the recording proxy to
drive an end-to-end capture.

## Drift — deterministic schema drift detection (`src/drift`)

Shared types live in `src/drift/types.ts` (read first — it defines the
semantics: side "a" = what consumers believe, side "b" = observed reality,
BREAKING = code written against "a" breaks under "b").

```ts
export * from './types.js';

/** Compare two models endpoint-by-endpoint. Deterministic, pure. */
export function diffModels(a: ApiModel, b: ApiModel, opts?: DiffOptions): DriftReport;

/**
 * Compare two shapes, reporting findings rooted at basePath.
 * Exposed so agent tooling can compare a single claimed shape against an
 * observed one without building full models.
 */
export function diffShapes(
  a: Shape | null,
  b: Shape | null,
  ctx: { endpoint: string; status?: number; basePath?: string },
): DriftFinding[];
```

### Normative severity rules (diff from a → b)

Endpoint level: endpoint in a but not b → `endpoint-removed` / breaking;
in b but not a → `endpoint-added` / info (both suppressed by
`ignoreUnmatchedEndpoints`). Response status in a but not b →
`status-removed` / risky; new status in b → `status-added` / risky.

Shape level (recursive walk; null variants handled as nullability):

- field present in a, absent in b → `field-removed` / **breaking**
- field present in b only → `field-added` / info
- primitive type changed → `type-changed`; integer→number widening is info,
  number→integer is info, anything else **breaking**
- became nullable (b allows null, a didn't) → `nullability-changed` / **breaking**;
  became non-nullable → `nullability-changed` / info
- field became optional in b → `optionality-changed` / **risky**;
  became required → `optionality-changed` / info
- enum: values added in b → `enum-values-changed` / **risky** (unhandled cases);
  values removed → `enum-values-changed` / info; enum in a but plain primitive
  in b → treat as risky `enum-values-changed` (closed set became open)
- format lost or changed (uuid → none/other) → `format-changed` / risky;
  format gained → info
- array element / record value / nested object: recurse with path suffixes
  `[]`, `{}` (record), `.field`
- kind mismatch not covered above (object→array etc.) → `type-changed` / **breaking**
- `unknown` in a vs anything in b → info (a knew nothing); concrete in a vs
  `unknown` in b → risky
- request body / query drift: same shape rules; when the whole shape
  appears/disappears use endpoint-level `request-changed` / `query-changed`
  (request required in b but absent in a → breaking; removed → info)
- `params-changed` only for param format changes (integer→uuid etc.) → risky

Report ordering: breaking, risky, info; within a group by endpoint then path.
Everything deterministic — this is a CI gate.

### CLI

```
wiretype diff <a> <b> [--dir .wiretype] [--json] [--fail-on breaking|risky|info]
              [--ignore-unmatched]
```

`<a>`/`<b>` resolve in order: (1) a path to a model.json file (an ApiModel),
(2) a recording name in --dir (model built on the fly via buildApiModel).
Human output: summary line + severity-grouped table
(SEVERITY | KIND | ENDPOINT | PATH | A → B). `--json` prints the DriftReport
JSON instead. `--fail-on <level>` exits 1 when any finding at that severity
or higher exists (breaking > risky > info) — the CI gate.

`wiretype gen` additionally accepts target `model` (allowed in --targets and
included in the default set) writing `model.json` — the raw ApiModel,
pretty-printed. model.json doubles as the claims interchange format: agent
tooling that extracts "what the code believes" emits a partial ApiModel and
diffs it against an observed model with --ignore-unmatched.

## Quality bar

- `npm run build` clean, `npm test` green, no `any` leaks in public APIs.
- Every core inference rule covered by unit tests; codegen emitters
  snapshot-style tested with a handcrafted ApiModel fixture; proxy tested
  against an in-process upstream server.
