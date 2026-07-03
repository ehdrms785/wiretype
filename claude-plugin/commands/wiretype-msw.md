---
description: Refresh MSW mock data from freshly recorded real API responses (diff first, apply on approval)
argument-hint: "[optional: recording name or mocks folder]"
---

Run the **msw-refresh** skill.

Optional hint from the user: $ARGUMENTS

Follow the msw-refresh skill: generate fresh MSW output (with `--msw-fixtures`)
from a wiretype recording, reconcile it against the project's existing MSW mock
data, show the user a diff of what would change per endpoint, and apply only the
changes they approve. Never overwrite existing mocks without showing the diff
first.
