Status: resolved (commit 37932b8)
From: app-integration-v1
Owner path: tests/browser/shell/shell.spec.ts (lead harness; shared-code maintainer)
Blocking: no

## Problem
The first test of `tests/browser/shell/shell.spec.ts` ("boots on the discrete GPU, loads definitions and presents
frames") asserts the pre-integration boot shell: `window.__test.page` equal to
`{ kind: 'app', name: 'main', scenarioId: null }` and a uniform dark blue-grey frame (`stats.center[2] >
stats.center[0]`). Since app integration v1 the page at `/` is the game: it flies the default mission scenario
(`scenarioId: 'lunar-direct'`, chosen from the definitions) and shows the pad, so both assertions fail by design.
The rest of that test (adapter features, `crossOriginIsolated`, `dataset.bodies`) and the second test (isolation
headers, 404 for unknown tiles) still hold.

## Evidence
`src/app/main.ts` (commit of app integration v1); `tests/browser/app/app.spec.ts` "boots on the pad with every
feature, the real sim and no error" covers the boot of the real app (page id, scenario, features, pad picture,
no console error).

## Requested change
In `shell.spec.ts`, open `/?capture=0` with a boot timeout of a few minutes (the game waits for the pad terrain,
every feature's start-up and the sound assets: `openPage(page, '/?capture=0', { timeoutMs: 240_000 })`), expect
`page` to be `{ kind: 'app', name: 'main', scenarioId: <a scenario id in /defs/index.json> }`, and replace the
uniform-clear check by `assertRealImage`. Keep the adapter, isolation and data-plugin checks as they are.

## Resolution

Done as requested (`37932b8`): the first test opens `/?capture=0` with a 240 s boot timeout (test timeout 6
minutes), expects `page` to be `{ kind: 'app', name: 'main' }` with a `scenarioId` that is one of the
`scenarios/*.json` of `/defs/index.json`, and checks the frame with `assertRealImage`; the adapter, isolation
and data-plugin checks are unchanged. `npx playwright test tests/browser/shell --project=functional`: 2 of 2
(with the game at `/`).
