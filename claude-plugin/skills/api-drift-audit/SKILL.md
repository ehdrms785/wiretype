---
name: api-drift-audit
description: >
  Audit a codebase's API assumptions against reality using wiretype recordings.
  Compares hand-written TS types / zod schemas / MSW mock data at API call
  sites with the schema actually observed on the wire, using wiretype's
  deterministic drift engine as the sole judge. Produces a severity-graded
  report (breaking / risky / info) mapping every finding to code locations,
  and optionally fixes the code. Trigger when the user says things like
  "API drift audit", "check my types against the real API", "are my mocks
  stale", "API 구조 일치하는지 확인", "실서버랑 타입 맞는지 검사", "drift 리포트",
  "mock 데이터 실서버랑 비교", or asks whether code matches actual API responses.
---

# API Drift Audit

You audit "what the code believes" against "what the wire returned".
The core rule of this skill: **you never judge schema equality yourself.**
You discover, translate, and explain; the verdict comes exclusively from
`wiretype diff` (a deterministic engine). If you catch yourself writing
"this looks compatible" without a diff output backing it — stop and run the
engine.

## Prerequisites

1. `wiretype` available: `npx wiretype --help` (else `npm i -D wiretype`).
2. A recording of real traffic. Check `npx wiretype list --dir .wiretype`
   (also try `--dir apps/<app>/.wiretype` in monorepos). If none exists,
   stop and tell the user how to record (`WIRETYPE=1` dev-server session with
   the Vite plugin, or `npx wiretype record --target <api>`), then resume.

## Step 1 — Observed model (reality)

```bash
npx wiretype gen --name <recording> --dir <dir> --targets model --out /tmp/drift-audit
```

Read `/tmp/drift-audit/model.json`. This is the reality side. Note per
endpoint: pattern, statuses, and sample counts (fewer than ~3 samples per
endpoint → mark the endpoint LOW-CONFIDENCE in the final report; optionality
inferences may be premature).

## Step 2 — Call-site discovery (your judgment, labeled as such)

For each endpoint pattern in the model, find where the codebase calls it:

- Grep for literal path fragments (longest static segments first:
  `/api/users` before `/users`), template literals assembling them, and the
  project's HTTP layer (axios instances, fetch wrappers, react-query hooks,
  generated clients). Follow baseURL/prefix configuration in interceptors —
  a call to `client.get('/users/' + id)` with `baseURL: '/api'` maps to
  `GET /api/users/:userId`.
- Classify every mapping: **certain** (literal match incl. prefix),
  **probable** (assembled/indirect), **unmapped** (endpoint observed on the
  wire but no call site found — dead traffic or missed discovery; report,
  don't guess).

## Step 3 — Claims extraction (translate, don't judge)

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

## Step 4 — Deterministic verdict

```bash
npx wiretype diff /tmp/drift-audit/claims.json /tmp/drift-audit/model.json \
  --ignore-unmatched --json > /tmp/drift-audit/report.json
```

Direction matters: claims = side "a" (belief), observed = side "b" (reality);
**breaking** = the code will break against reality. `--ignore-unmatched`
suppresses noise from endpoints you couldn't claim.

Also diff mock freshness when MSW handlers exist: record a short session in
mock mode (or translate handler mock literals as a second claims model) and
diff it against the observed model the same way.

## Step 5 — Report

Write `api-drift-report.md` in the project (show it to the user):

1. **Verdict summary** — counts by severity, one-line risk statement.
2. **Findings table** — severity | endpoint | path | before → after |
   **code location(s)** (file:line from Step 2) | mapping confidence.
   Findings come verbatim from report.json; you add locations and confidence.
3. **Not auditable** — endpoints excluded in Step 3 and why.
4. **Unmapped traffic** — observed endpoints with no call site found.
5. **Low-confidence endpoints** — sample count < 3.
6. **Recommended actions** — concrete edits per breaking/risky finding.

Redact obviously sensitive sample values (tokens, emails, personal data)
when quoting samples.

## Step 6 — Fix (only with explicit user approval)

Offer three tiers; apply only what the user picks:

- **Types**: edit the hand-written interfaces/zod schemas to match observed
  reality (or replace with generated `types.ts`/`schemas.ts` imports).
- **Mocks**: regenerate MSW handlers (`npx wiretype gen --targets msw`) and
  update `src/mocks/` data to the captured responses.
- **Guards**: add generated zod schemas at response boundaries so the next
  drift fails loudly in dev.

After edits, run the project's typecheck and tests and report results.
Never mark the audit complete while either fails.
