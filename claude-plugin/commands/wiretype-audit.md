---
description: Audit code's API types/zod/mocks against real recorded traffic (wiretype drift audit)
argument-hint: "[folder or file to audit, e.g. src/apis]"
---

Run the **api-drift-audit** skill.

Audit scope from the user: $ARGUMENTS

If a scope was provided above, use it as the folder/file to audit and skip the
scope question. If it is empty, follow the skill's Step 1 to infer a default
scope and ask the user before scanning.

Follow the api-drift-audit skill end to end: build the observed model from a
wiretype recording, discover call sites in scope, extract what the code
believes into a claims model, get the verdict from `wiretype diff` (the sole
judge), write a severity-graded report in the user's language with code
locations, then offer fixes behind an explicit approval gate.
