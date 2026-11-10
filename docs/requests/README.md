# Change requests against code you do not own

Every directory has one owner (docs/ARCHITECTURE.md section 2). When your package needs a change in a path
it does not own - a bug in the render core, a missing helper, a contract field, a defect in baked data -
you do not edit that path. You file a request here and the current maintainer of that path makes the change.

Who maintains what:

| When | Paths | Maintainer |
|---|---|---|
| Wave 1 | `src/core`, `tests/browser/harness.ts`, `tools/dev`, `tools/server`, `tools/bake/common` | the lead, between waves: put the request in your hand-off note as well |
| Wave 2 | `src/core`, `src/render/core`, `src/terrain`, `src/ui`, `src/input`, `src/camera`, `src/map`, `src/audio`, `tools/**` (bakes included), shared docs | the `core-support` package, live, while you work |
| Wave 2 | `src/sim/**`, `src/pilot`, part/vehicle/scenario data | `sim-world-pilot` |

## How to file

Create `docs/requests/<your-package>-<n>.md` (n = 1, 2, ...) with exactly this shape and commit it
(`git add docs/requests/<file>` only):

```
Status: open
From: <package id>
Owner path: <path the change is needed in>
Blocking: yes | no        (yes = you cannot meet an acceptance criterion without it)

## Problem
What is wrong or missing, in two or three sentences.

## Evidence
The smallest reproduction: a failing command, a lab URL with query string, an error message, a screenshot
path under out/, or the lines of the contract that contradict each other.

## Requested change
The exact API or behaviour you need (signature, units, default). Say what must NOT change.
```

Then keep working. Use a workaround inside your own paths if one exists and say so in the request; never
copy the foreign code into your package. To wait for an answer without burning turns:

```
node tools/dev/wait-requests.mjs --resolved docs/requests/<your-package>-<n>.md --timeout 540
```

## How a request is answered

The maintainer edits the first line and appends a section:

```
Status: resolved (commit <hash>)        or        Status: declined
...
## Resolution
What changed (files, new signatures), how to use it, what to re-run. For a declined request: why, and
what to do instead.
```

Rules for the maintainer: changes are additive wherever possible; a changed signature is announced in the
resolution with a migration line; `npm run typecheck`, `npx vitest run` and the owning package's browser
specs stay green; `docs/RENDER_API.md` and the affected hand-off note are updated in the same commit.
Requests are handled blocking first, then in file order.
