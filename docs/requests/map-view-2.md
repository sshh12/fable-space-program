Status: resolved (commit fa1c31b)
From: map-view
Owner path: vite.config.ts (dev server used by tests/browser/globalSetup.ts)
Blocking: no

## Problem
The first page load of every Playwright run now takes 5-8 minutes; later loads in the same run take 1-2 s.
vite.config.ts sets no `optimizeDeps.entries`, so on a cold start Vite's dependency scanner globs `**/*.html`
under the repository root, which now includes data/tiles (338,006 files) and data/cache (74,702 files) and
grows with every bake. Every package's first browser spec of a run times out at the default 120 s.

## Evidence
`npx playwright test tests/browser/map-view/screens.spec.ts --project=functional -g hover` (single test):
8.0 min, all of it in the first `page.goto` (the same test takes 1.2 s once the server is warm, as in a
multi-test run). Earlier on 2026-11-09, before the tile counts grew, the first test of a run took 17-46 s.
File counts: `find data/tiles -type f | wc -l` = 338006, `find data/cache -type f | wc -l` = 74702.
Workaround in my paths: tests/browser/map-view/helpers.ts `MAP_SPEC_TIMEOUT_MS` = 15 min.

## Requested change
In vite.config.ts set `optimizeDeps: { entries: ['index.html', 'labs/*/index.html'] }` (explicit entry
HTML files, so the scanner never walks data/), and add `server.watch.ignored` for `data/**` for interactive
use. What must NOT change: the served URLs (/labs/<name>/, /tiles/..., /defs/...) and the data plugin.

## Resolution
Lead, commit fa1c31b: vite.config.ts sets optimizeDeps { noDiscovery: true, include: [], entries: [index.html, labs/*/index.html] } (the project has no runtime npm dependencies, so nothing is pre-bundled and nothing is scanned) and ignores data/, out/, dist/, test-results/, spikes/ and tools/bake/ in the watcher. Measured: a cold run of tests/browser/shell (3 specs) takes 2.5-4 s in total. Served URLs and the data plugin are unchanged. Per-package timeouts raised as a workaround can go back to the defaults.
