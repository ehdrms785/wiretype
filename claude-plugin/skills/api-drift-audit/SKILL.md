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
  fix proposals) in the language the user is conversing in. When the skill
  is invoked as a bare slash command with NO prior user prose in the
  session, do not default to English — infer the user's language from
  context first (system/CLAUDE.md language, user preferences, README/commit
  language of the project); if still ambiguous, ask the very first question
  bilingually (English + 한국어) and lock onto whichever language the user
  answers in. Machine fields (endpoint, path, `before → after`, file paths,
  code) are never translated.
- **Redaction**: when quoting sample values from recordings, redact
  obviously sensitive data (tokens, emails, phone numbers, personal data).

## Prerequisites

1. `wiretype` available: `npx wiretype --help` (else `npm i -D wiretype`).
2. `typescript` available in the project (needed by `wiretype claims`;
   virtually every TS project has it). If missing, fall back to the manual
   translation table in Step 4.
3. A recording of real traffic. Check `npx wiretype list --dir .wiretype`
   (also try `--dir apps/<app>/.wiretype` in monorepos; a `wiretype.config.*`
   file may set `dir`). If none exists, offer the following paths IN ORDER —
   each behind an explicit approval gate. Never generate traffic without the
   user's go-ahead: it hits a real backend.

   **(a) E2E / integration tests exist (Cypress, Playwright, ...)** — offer
   to run them yourself in record mode: start the dev server recording
   (`vite --mode record`, or `WIRETYPE=1 vite` when the app depends on
   `.env.development`), run the suite against it, stop the server. Tests
   were written and reviewed by humans, so auth AND side effects are already
   vetted — this is the only fully-unattended path. Report how many
   exchanges were captured.

   **(b) No E2E suite, header-based auth (Bearer token / API key)** — offer
   to GENERATE a GET-only seed-traffic script instead of asking the user to
   click around. You will discover call sites in Step 3 anyway; use the same
   knowledge to write `wiretype-traffic.seed.mjs` in the project:
   - GET endpoints only — mutations are excluded BY CONSTRUCTION, so the
     script is safe to run against a shared dev backend. List the skipped
     non-GET endpoints so the user knows the coverage gap.
   - Path params: fill ids from list-endpoint responses when discoverable
     (fetch the list first, reuse returned ids), otherwise leave a marked
     `TODO` the user fills in.
   - Auth: read a header from the `AUTH_HEADER` env var (e.g.
     `AUTH_HEADER='authorization: Bearer …'`). Never hardcode tokens, never
     ask the user to paste a token into chat — they set the env var when
     running the script.
   - The script targets the recording proxy
     (`npx wiretype record --target <api-url> --port 5050`) or the record-
     mode dev server, drains every response body, and prints per-request
     status lines.
   Show the script, let the user review it (it is all-GET and auditable),
   then run it on approval and clean it up afterwards (or leave it if the
   team wants to keep it as a fixture).
   This path only works when auth travels in a header the user can hand
   over. Cookie/session-based apps (SSO redirects, httpOnly session
   cookies) cannot be driven this way — use (c).

   **(c) Browser tooling available with a logged-in session** (Claude in
   Chrome, a Playwright/browser MCP, etc.) — offer to drive the app
   YOURSELF through the record-mode dev server using the user's existing
   logged-in session. This is the right path for cookie/session auth where
   no header can be extracted.

   When NO browser tooling is connected to the session, do not silently
   drop this path — tell the user how to enable it and offer to resume:
   - **Claude Code (CLI/VSCode)**: add a browser MCP, e.g.
     `claude mcp add playwright -- npx @playwright/mcp@latest`, then
     restart the session. A Playwright-spawned browser starts with a FRESH
     profile (no SSO session) — ask the user to perform the login once in
     that browser, then you navigate read-only from there.
   - **Cowork / Claude desktop**: connect the Claude in Chrome extension —
     it drives the user's real Chrome, so the existing logged-in session
     (SSO cookies included) just works.

   Strict rules, because a live session on a
   shared backend can mutate real data:
   - Get explicit approval first, and say clearly which app/URL you will
     drive and that you will only READ.
   - Navigate; don't operate. Visit routes and list/detail pages (URL
     navigation, pagination, tabs, opening records). NEVER submit forms,
     never click buttons whose labels imply writes (save, delete, create,
     update, acknowledge, approve, send, ...). When in doubt, don't click —
     add the page to a "not covered" list instead.
   - Prefer the route list you discovered in the code (router config) over
     free exploration; report which routes you visited and which you
     skipped, so coverage is explicit.
   - Stop when `wiretype list` shows the endpoints in scope have samples
     (a handful per endpoint is enough for a first audit; more can be
     recorded later).

   **(d) Fallback — manual click-through**: start record mode for the user
   (`vite --mode record` / `WIRETYPE=1 vite`, or the standalone proxy) and
   ask them to click through the app; their session, their control over
   side effects. Resume the audit once `wiretype list` shows exchanges.

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

## Step 4 — Claims extraction (deterministic: point, don't translate)

Your job here is only to POINT at the right types — the translation into
Shape AST is done deterministically by the TypeScript compiler via
`wiretype claims`. You never hand-translate a type when the command is
available.

1. For each mapped call site, identify the exported TS type the code uses
   for the response (and request/query when auditing mutations).
2. Write a claims map at `/tmp/drift-audit/claims.map.json`:

```json
{
  "entries": [
    {
      "method": "GET",
      "pattern": "/api/users/:userId",
      "status": 200,
      "response": "src/apis/user/types.ts#UserDetail"
    },
    {
      "method": "POST",
      "pattern": "/api/users",
      "status": 201,
      "response": "src/apis/user/types.ts#UserDetail",
      "request": "src/apis/user/types.ts#CreateUserBody"
    }
  ]
}
```

   - Refs are `path/to/file.ts#ExportedTypeName`, resolved relative to the
     map file's directory — place the map in the project (e.g. repo/app
     root) or use absolute paths.
   - Pattern strings must EXACTLY match the observed model's patterns (same
     `:paramName`s) or the diff will treat them as different endpoints.
   - **Generic wrappers** (`ApiResponse<UserDetail>` etc.): add a shim file
     in the project, e.g. `/tmp/drift-audit` won't work for imports — put
     `wiretype-claims.shim.ts` next to the API code:
     `export type GetUserClaim = ApiResponse<UserDetail>;`
     and reference `...shim.ts#GetUserClaim`. The shim is code — reviewable
     and deterministic. Delete it after the audit.

3. Run the extractor:

```bash
npx wiretype claims --map /tmp/drift-audit/claims.map.json \
  --out /tmp/drift-audit/claims.json
```

The command translates every referenced type with the TypeScript compiler
and REFUSES anything it cannot translate faithfully (unresolved generics,
`Date`, functions, recursion...) — refusals are listed in the output's
`notAuditable` array and in stdout. Report them under "not auditable";
never re-translate a refused type by hand to force a verdict.

Check the `tsconfig:` line in the output: it names the config the compiler
options came from (solution-style monorepo configs are auto-resolved to the
referenced project, and strictNullChecks is always forced on so `| null`
unions survive). If the named tsconfig looks wrong for the audited code,
pass `--tsconfig` explicitly.

Manual fallback (ONLY when `typescript` is unavailable or the command
fails): translate types yourself with the table below into a partial
ApiModel with `"name": "claims", "target": "source-code", "generatedAt": 0`,
and endpoints entries with `params: [], exchangeIds: []` and
`responses: [{ status, bodyShape, count: 1 }]`. Label the audit as
"manual claims translation — not deterministic" in the report.

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

## Step 5 — Deterministic verdict

```bash
npx wiretype diff --claims /tmp/drift-audit/claims.json \
  --observed /tmp/drift-audit/model.json \
  --ignore-unmatched --json > /tmp/drift-audit/report.json
```

Always use the named `--claims`/`--observed` flags — swapping positional
sides silently flips every severity. **breaking** = the code will break
against reality. `--ignore-unmatched` suppresses noise from endpoints you
couldn't claim.

Findings carry a `bSamples` field (observed samples backing the finding);
the reports mark anything under 3 samples with ⚠ — surface those as
low-confidence rather than actionable.

When the conversation is in Korean or English, also generate a localized
findings skeleton to build the human report on:

```bash
npx wiretype diff --claims /tmp/drift-audit/claims.json \
  --observed /tmp/drift-audit/model.json \
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
3. **Not auditable** — the `notAuditable` refusals from claims.json (ref +
   reason, verbatim), plus endpoints you could not map in Step 3.
4. **Unmapped traffic** — observed endpoints with no call site in scope.
5. **Low-confidence findings** — findings the engine marked ⚠ (bSamples < 3),
   and suspected enum false positives (see Step 2 caveat).
6. **Proposed fixes** — see Step 7; do not apply anything yet.

## Step 7 — Fix gate (explicit approval, item by item)

After presenting the report, **STOP**. Present a numbered list of proposed
fixes ordered by severity (breaking first), each entry containing:

- the finding it resolves (severity + endpoint + path),
- the exact file:line to change,
- the exact change (before → after snippet or generated-import swap).

Typical fix shapes, in order of preference: EDIT the hand-written
interfaces/zod schemas in place to match observed reality (the team's names
and structure stay intact); refresh MSW mocks (prefer the dedicated
`msw-refresh` skill); add generated zod schemas from
`npx wiretype gen --targets zod` as runtime guards at response boundaries so
the next drift fails loudly in dev.

Positioning note: wiretype's generated `types.ts` uses mechanical names
(`GetApiUsersByUserIdResponse`) — it is a VERIFICATION and MOCK artifact,
not a replacement for the team's domain types. Do not propose wholesale
"replace your types with generated imports" fixes; propose targeted edits
to the team's own types instead.

Apply ONLY the numbered items the user selects. Never auto-fix, never bundle
unselected items in. After applying, run the project's typecheck and tests
and report the results. Never claim the audit or the fixes are complete
while either fails.
