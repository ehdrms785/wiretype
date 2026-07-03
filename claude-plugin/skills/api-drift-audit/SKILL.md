---
name: api-drift-audit
description: >
  Audit a codebase's API assumptions against reality using wiretype
  recordings. Scopes the audit to the folder/file the user picks (e.g.
  src/apis), compares hand-written TS types / zod schemas / MSW mock data at
  API call sites with the schema actually observed on the wire, and uses
  wiretype's deterministic drift engine as the sole judge. Produces a
  severity-graded report (breaking / risky / info) in the user's conversation
  language (via `wiretype diff --md --lang`), mapping every finding to
  code locations, then offers fixes behind an explicit approval gate.
  Trigger when the user says things like "API drift audit", "check my types
  against the real API", "are my mocks stale", "audit src/apis against the
  server", "API 구조 일치하는지 확인", "실서버랑 타입 맞는지 검사",
  "drift 리포트", "이 폴더 타입 실서버랑 비교", "mock 데이터 실서버랑 비교",
  or asks whether code matches actual API responses.
---

# API Drift Audit

You audit "what the code believes" against "what the wire returned".
The core rule of this skill: **you never judge schema equality yourself.**
You discover, translate, and explain; the verdict comes exclusively from
`wiretype diff` (a deterministic engine). If you catch yourself writing
"this looks compatible" without a diff output backing it — stop and run the
engine.

Two conventions apply to everything below:

- **Language**: write all human-facing output (questions, report prose,
  fix proposals) in the language the user is conversing in. Machine fields
  (endpoint, path, `before → after`, file paths, code) are never translated.
- **Redaction**: when quoting sample values from recordings, redact
  obviously sensitive data (tokens, emails, phone numbers, personal data).

## Prerequisites

1. `wiretype` available: `npx wiretype --help` (else `npm i -D wiretype`).
2. A recording of real traffic. Check `npx wiretype list --dir .wiretype`
   (also try `--dir apps/<app>/.wiretype` in monorepos). If none exists,
   stop and tell the user how to record, then resume:
   - **Vite projects** with `wiretypeRecorder(...)` in the plugins array:
     run `vite --mode record` (no env var needed) and click through the app
     against the real backend.
   - **Anything else**: `npx wiretype record --target <api-url> --port <p>
     --name <n> --dir <d>` and point the app/requests at the proxy port.

## Step 1 — Scope (ask before you scan)

Do NOT audit the whole repository by default. First, infer a sensible
default scope: quickly scan for the API layer (imports of `axios`,
`@tanstack/react-query`, fetch wrappers, generated clients — e.g. a
`src/apis`, `src/api`, `src/services` directory). Then ask the user:

> "Which folder or file holds the API layer to audit? I'd suggest
> `<inferred-default>`."

- If they name a folder/file, that is the audit scope — discover call
  sites and claims only inside it.
- Only if they decline or don't know: scan the whole repo, then present a
  table of `observed endpoint | discovered call site | confidence` and let
  them pick rows to audit.
- **Bias to GET endpoints** as the primary audit target. Mention that
  mutations (POST/PUT/PATCH/DELETE request bodies) are included only if the
  user asks for them.

## Step 2 — Observed model (reality)

```bash
npx wiretype gen --name <recording> --dir <dir> --targets model --out /tmp/drift-audit
```

Read `/tmp/drift-audit/model.json`. This is the reality side. Note per
endpoint: pattern, statuses, and sample counts (fewer than ~3 samples per
endpoint → mark the endpoint LOW-CONFIDENCE in the final report; optionality
inferences may be premature).

**Enum false-positive caveat**: wiretype freezes a string field into an enum
when samples repeat a small value set. Repeated identical responses can
therefore freeze incidental values (e.g. filenames, a lone username) into an
enum. When an enum finding looks suspicious, say so in the report and note
that only re-recording the same endpoint with genuinely different data can
resolve it — do not overrule the engine, just flag confidence.

## Step 3 — Call-site discovery (your judgment, labeled as such)

For each endpoint pattern in the model, find where the scoped code calls it:

- Grep for literal path fragments (longest static segments first:
  `/api/users` before `/users`), template literals assembling them, and the
  project's HTTP layer (axios instances, fetch wrappers, react-query hooks,
  generated clients). Follow baseURL/prefix configuration in interceptors —
  a call to `client.get('/users/' + id)` with `baseURL: '/api'` maps to
  `GET /api/users/:userId`.
- Classify every mapping: **certain** (literal match incl. prefix),
  **probable** (assembled/indirect), **unmapped** (endpoint observed on the
  wire but no call site found in scope — dead traffic, out-of-scope code, or
  missed discovery; report, don't guess).

## Step 4 — Claims extraction (translate, don't judge)

For each mapped call site, find the schema the code believes: the TS
interface/type used for the response, the zod schema parsing it, or the MSW
handler mock shaped like it. Translate each into wiretype's Shape AST and
assemble a partial ApiModel (**claims model**) with the same JSON structure
as model.json.

Translation table (TS → Shape):

| TS construct | Shape |
|---|---|
| `string` / `number` / `boolean` | `{ "kind": "primitive", "type": "string" \| "number" \| "boolean" }` |
| number known to be int (zod `.int()`) | `"type": "integer"` |
| `X \| null` | `{ "kind": "union", "variants": [X, { "kind": "null" }] }` |
| `field?: X` | field entry `{ "shape": X, "optional": true }` |
| `"a" \| "b"` literal union | primitive with `"enum": ["a", "b"]` |
| zod `.uuid()/.datetime()/.email()/.url()` | `"formats": ["uuid"]` etc. |
| `X[]` | `{ "kind": "array", "element": X }` |
| `Record<string, X>` | `{ "kind": "record", "value": X }` |
| `unknown` / `any` | `{ "kind": "unknown" }` |

Claims model skeleton (one endpoint):

```json
{
  "name": "claims", "target": "source-code", "generatedAt": 0,
  "endpoints": [{
    "method": "GET", "pattern": "/api/users/:userId",
    "params": [], "queryShape": null,
    "requestBodyShape": null,
    "responses": [{ "status": 200, "bodyShape": { ... }, "count": 1 }],
    "exchangeIds": [], "operationId": "getApiUsersByUserId",
    "typeName": "GetApiUsersByUserId"
  }]
}
```

Pattern strings must EXACTLY match the observed model's patterns (same
`:paramName`s) or the diff will treat them as different endpoints.
If a claim is ambiguous (type assembled from generics you can't resolve,
`any`-typed response), EXCLUDE the endpoint from claims and list it under
"not auditable" in the report — never guess a claim.

Write the result to `/tmp/drift-audit/claims.json`.

## Step 5 — Deterministic verdict

```bash
npx wiretype diff /tmp/drift-audit/claims.json /tmp/drift-audit/model.json \
  --ignore-unmatched --json > /tmp/drift-audit/report.json
```

Direction matters: claims = side "a" (belief), observed = side "b" (reality);
**breaking** = the code will break against reality. `--ignore-unmatched`
suppresses noise from endpoints you couldn't claim.

When the conversation is in Korean or English, also generate a localized
findings skeleton to build the human report on:

```bash
npx wiretype diff /tmp/drift-audit/claims.json /tmp/drift-audit/model.json \
  --ignore-unmatched --md --lang ko   # or --lang en
```

For any other conversation language, translate the section headings and
prose yourself, and still embed the findings from the machine
`--json` output. In every case the JSON report is the source of truth.

Also diff mock freshness when MSW handlers exist: translate handler mock
literals as a second claims model (or record a short mock-mode session) and
diff it against the observed model the same way.

## Step 6 — Report

Write `api-drift-report.md` in the project and show it to the user, in the
conversation language (use the `--md --lang` skeleton when ko/en):

1. **Verdict summary** — counts by severity, one-line risk statement.
2. **Findings table** — severity | endpoint | path | before → after |
   **code location(s)** (file:line from Step 3) | mapping confidence.
   Findings come verbatim from report.json; you add locations and confidence.
3. **Not auditable** — endpoints excluded in Step 4 and why.
4. **Unmapped traffic** — observed endpoints with no call site in scope.
5. **Low-confidence endpoints** — sample count < 3, and suspected enum
   false positives (see Step 2 caveat).
6. **Proposed fixes** — see Step 7; do not apply anything yet.

## Step 7 — Fix gate (explicit approval, item by item)

After presenting the report, **STOP**. Present a numbered list of proposed
fixes ordered by severity (breaking first), each entry containing:

- the finding it resolves (severity + endpoint + path),
- the exact file:line to change,
- the exact change (before → after snippet or generated-import swap).

Typical fix shapes: edit hand-written interfaces/zod schemas to match
observed reality; replace with generated `types.ts`/`schemas.ts` imports
(`npx wiretype gen --targets ts,zod`); refresh MSW mocks (prefer the
dedicated `msw-refresh` skill for that); add generated zod schemas at
response boundaries so the next drift fails loudly in dev.

Apply ONLY the numbered items the user selects. Never auto-fix, never bundle
unselected items in. After applying, run the project's typecheck and tests
and report the results. Never claim the audit or the fixes are complete
while either fails.
