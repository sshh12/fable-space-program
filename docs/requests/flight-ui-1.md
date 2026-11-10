Status: resolved
From: flight-ui
Owner path: vite.config.ts (dev server used by tests/browser/globalSetup.ts)
Blocking: no

## Problem
The first page load of every Playwright run now takes about 7 minutes, so the first test of a run fails at the
120 s test timeout (later tests of the same run are fast). The likely cause: Vite's dependency scanner has
no `optimizeDeps.entries`, so on a cold server it crawls the whole repository for `*.html` entry points,
which now includes `data/` (about 628,000 files) and a Python virtualenv under `data/cache/earth/venv` that
ships its own HTML templates; module requests are held until that scan finishes. (Not verified by profiling
the server; the timing and the file counts below are measured.)

## Evidence
`npx playwright test tests/browser/flight-ui/screens.spec.ts --project=functional -g "720p scene pad"` fails
with `page.goto: Test timeout of 120000ms exceeded ... waiting until "load"`; the same command with
`--timeout 600000` passes after 7.2 min, nearly all of it inside the first `page.goto`. `find data -type f | wc -l`
= 628402; `find . -name "*.html" -not -path "./node_modules/*"` lists files under `data/cache/earth/venv`,
`dist/` and `spikes/harness/node_modules`.

## Requested change
In `vite.config.ts`, restrict the scan to the real entry points, e.g.
`optimizeDeps: { entries: ['index.html', 'labs/*/index.html'] }`, and keep the dev-server watcher out of the
data trees (`server.watch.ignored: ['**/data/**', '**/out/**', '**/dist/**', '**/spikes/**']`). Nothing else
changes (served paths, the data plugin and the isolation headers stay as they are).

Workaround meanwhile: flight-ui verification runs pass `--timeout 600000` on the command line.

## Resolution
Lead, commit fa1c31b: vite.config.ts sets optimizeDeps { noDiscovery: true, include: [], entries: [index.html, labs/*/index.html] } (the project has no runtime npm dependencies, so nothing is pre-bundled and nothing is scanned) and ignores data/, out/, dist/, test-results/, spikes/ and tools/bake/ in the watcher. Measured: a cold run of tests/browser/shell (3 specs) takes 2.5-4 s in total. Served URLs and the data plugin are unchanged. Per-package timeouts raised as a workaround can go back to the defaults.
