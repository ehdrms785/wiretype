---
name: msw-refresh
description: >
  Refresh a project's MSW mock data from real recorded API traffic —
  reconciling with the existing mock structure instead of dumping new files.
  Uses `wiretype gen --targets msw --msw-fixtures` to turn a recording into
  thin handlers plus fixture JSON, maps each generated endpoint to the
  project's existing handlers, shows a data diff per endpoint, and applies
  only user-approved updates (preferring fixture JSON edits over handler
  code churn). Trigger when the user says things like "refresh msw mocks",
  "update mock data from real API", "sync mocks with the server",
  "my mock data is outdated", "MSW mock 갱신", "목 데이터 실서버로 최신화",
  "msw 핸들러 최신화", "mock 데이터 새로 따줘", "실서버 응답으로 mock
  업데이트", or wants mock responses to reflect what the API actually
  returns today.
---

# MSW Refresh

You refresh a project's MSW mock DATA from real recorded traffic while
**preserving the project's existing handler code and structure**. You never
judge what changed by eyeballing — the fresh fixtures come from
`wiretype gen`, and you present a literal data diff before touching anything.

This skill complements (does not replace) the `api-drift-audit` skill:
`api-drift-audit` answers "are my types/schemas wrong about reality?";
this skill answers "is my mock data stale?" and updates it. If the user
wants schema-level verdicts, hand off to `api-drift-audit`.

Conventions:

- **Language**: all human-facing output (questions, diff summary, report)
  in the user's conversation language. Never translate machine fields
  (endpoints, paths, JSON keys/values, file paths).
- **Redaction**: recorded fixtures contain real response data. Before
  quoting samples in chat, redact obviously sensitive values (tokens,
  emails, phone numbers, personal data). Also warn the user if fixtures
  about to be written into the repo contain such values.

## Step 1 — Ensure a recording exists

`npx wiretype --help` to confirm availability (else `npm i -D wiretype`).
Then `npx wiretype list --dir .wiretype` (also try
`--dir apps/<app>/.wiretype` in monorepos). If no suitable recording exists,
stop and guide the user to record real traffic, then resume:

- **Vite projects** with `wiretypeRecorder(...)` in the plugins array:
  run `vite --mode record` (no env var needed) and click through the flows
  whose mocks should be refreshed, against the real backend.
- **Anything else**: `npx wiretype record --target <api-url> --port <p>
  --name <n> --dir <d>` and drive traffic through the proxy port.

Prefer a recent recording — ask the user if the newest one is fresh enough
for "current reality".

## Step 2 — Generate fresh handlers + fixtures into a temp dir

```bash
npx wiretype gen --name <recording> --dir <dir> \
  --targets msw --msw-fixtures --out /tmp/msw-refresh
```

This produces a thin `handlers.ts` plus `fixtures/<operationId>.<status>.json`
— the real captured responses as plain JSON data files. These fixtures are
your "reality" side. Do not copy anything into the project yet.

## Step 3 — Locate the project's existing MSW setup

Grep the project for `http.` (msw v2 handlers), `HttpResponse`,
`setupServer`, `setupWorker`, `rest.` (msw v1), and conventional locations
(`mocks/handlers`, `src/mocks/`, `test/mocks/`). Identify:

- where handlers live and how they're structured (one file, per-domain
  files, factory functions),
- whether mock data is **inlined** in handler bodies or kept in separate
  data/fixture modules,
- the msw version (v1 `rest`/`ctx` vs v2 `http`/`HttpResponse`).

Map each generated endpoint handler to an existing handler by **method +
path pattern** (normalize base URLs and `*` origin prefixes; `:param`
segments match msw path params). Label each mapping certain / probable.

## Step 4 — Reconcile (diff data, preserve structure)

Build a three-part reconciliation:

1. **Matched endpoints**: for each, diff the existing mock response DATA
   against the freshly recorded fixture — show which values drifted
   (added/removed keys, changed values, changed array shapes), with
   redaction applied. The project's handler code/structure is NOT part of
   the diff; only data is.
2. **Unmatched observed endpoints** (fixture exists, no project handler):
   offer to add new handlers, written in the project's existing style —
   not by pasting the generated thin handler verbatim unless the project
   already uses the fixtures layout.
3. **Existing handlers with no matching traffic**: flag as
   "not covered by this recording" — the recording just didn't exercise
   them. Do NOT delete or modify them.

## Step 5 — Present and STOP (explicit approval gate)

Present the diff summary as a numbered list: per matched endpoint the data
drift, per unmatched endpoint the proposed addition, plus the not-covered
list. Then **STOP** and let the user select which numbered items to apply.
Never auto-apply.

## Step 6 — Apply only approved updates, minimal churn

- **Preferred**: write/refresh fixture JSON files (data) and leave handler
  code untouched. If the project already separates data from handlers, only
  the data files change. If the user wants to migrate to the fixtures
  layout, the generated thin `handlers.ts` + `fixtures/` from Step 2 shows
  the target shape — adapt paths/imports to the project.
- **If the project inlines data** in handler bodies: edit the inline
  literals in place with minimal churn — change only the drifted values,
  keep formatting, comments, helper wrappers, and delay/`ctx` logic intact.
- New handlers (approved from the unmatched list): add them in the
  project's existing file/style conventions and register them where the
  project aggregates handlers.

## Step 7 — Verify and report

Run the project's typecheck and test suite (mock-based tests are the ones
most likely to be affected). Report results in the conversation language:
what was updated, what was added, what was flagged as not covered, and the
typecheck/test outcome. Never claim the refresh is complete while typecheck
or tests fail — report the failure and propose next steps instead.
