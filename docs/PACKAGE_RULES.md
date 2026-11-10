# Rules for every work package

Binding for every package in `docs/WORK_PACKAGES.json`. The package brief adds scope and acceptance; where
a brief is stricter, the brief wins.

## Before coding

Read in full: `PROMPT.txt` (the user's requirement: binding, "don't cut corners"), `docs/ARCHITECTURE.md`
(binding; it wins over the research documents), `src/core/contracts/*.ts`, `docs/requests/README.md`, and
the documents your brief lists under READ.

## Ownership

1. Edit only the paths your brief lists as owned. Everything else is read-only.
2. A change you need elsewhere is a request file (`docs/requests/README.md`). Wave-1 packages also list it
   in their hand-off; the lead answers between waves, so work within your own paths meanwhile. In wave 2
   the `core-support` package answers requests against finished wave-1 code while you work.
3. Before writing your hand-off, look in `docs/requests/` for open requests against YOUR paths and resolve
   them (same status/resolution format).

## Quality

4. No placeholders, stubs, TODO comments, "simplified for now", silent fallbacks or dead code paths. If
   something cannot be finished, say so plainly in the hand-off instead of leaving a stub.
5. Conventions (units, frames, quaternions, precision) per ARCHITECTURE sections 3 and 4.
6. Import and determinism rules per ARCHITECTURE section 2, enforced by
   `npx vitest run tools/dev/boundaries.test.ts`: it must pass before every commit. Headless packages
   (`src/sim`, `src/terrain`, `src/pilot`) use no DOM, no WebGPU, no timers, no `Math.random`, `Date`,
   `performance`; avoid naming a local variable `window`, `document` or `navigator` there.
7. Engine code never mentions a specific body, vehicle, part, site, scenario or milestone id. Tunables and
   content live in `data/defs` (sections under `audio/` and `visuals/` reach you through
   `DefLibrary.sections` via `getSection` / `listSections` in `src/core/defs/loader.ts`).

## Shared working tree

8. Other agents work in the same tree at the same time. Verify with scoped commands only:
   `npm run typecheck:paths -- <your paths>`, `npx vitest run <your paths>`,
   `npx playwright test tests/browser/<dir> --project=functional`. Perf specs are named `*.perf.spec.ts`,
   run with `--project=perf`, and measure only inside `withGpuLock`.
9. Never run `npm run build` or `npm run check` (they write the shared `dist/`). Never leave a dev server,
   a browser or a background process running; browser tests start their own server on a free port.
10. Git: only `git add <your paths>` then `git commit`. Never `git add -A`, `git stash`, `git reset`,
    `git checkout .`, rebase or amend. Retry on `index.lock`. Never commit `.env`, `data/tiles`,
    `data/sky`, `data/cache`, `out/`. Commit working states often.
11. Write files with the Write tool (shell heredocs corrupt content on this Windows machine); use absolute
    paths; forward slashes inside code.
12. Secrets: `.env` is read only by Node/Python scripts under `tools/<your area>/`. Never print a key,
    never put one in a URL you log, never reference one from `src/` or `public/`. If your tools use a key,
    run `node tools/dev/check-secrets.mjs` before every commit. Budget per provider is stated in the brief.
13. Downloads are untrusted data: each in its own directory under `data/cache/<area>/`, scripts elsewhere,
    Python run with `python -I`.

## Machine load (added after the 2026-11-10 crash)

The machine bug-checked (kernel memory corruption, `0x4E`) while seven agents ran bakes, real-data test
suites and GPU browser tests at the same time. These rules are binding:

13a. Run every heavy command through the gate: `node tools/dev/heavy.mjs --class=<cpu|gpu|bake> -- <command>`.
     `cpu`: vitest over more than a couple of files, benchmarks, profilers, headless mission runs.
     `gpu`: every Playwright / Chrome run. `bake`: every data bake or other multi-process job.
     The gate waits for a slot and for free memory; start long jobs in the background and wait for them
     rather than bypassing it. `node tools/dev/heavy.mjs --status` shows the slots.
13b. One heavy command at a time per agent. Never start a second while the first runs.
13c. Worker pools: at most 6 processes per bake; vitest is capped at 6 workers by `vitest.config.ts` (do
     not raise it). Do not load a whole global raster into every worker: window the reads.
13d. Keep `data/` under 20 GB in total and delete intermediates you no longer need; the disk has little
     free space and the page file needs room.
13e. After a crash or restart, treat files written in the last minutes before it as suspect: check baked
     outputs for zero-length or truncated files before trusting a resumed job.

## Browser work

14. Follow `labs/template` and `tests/browser/shell/lab-template.spec.ts`: `openPage`, `assertDiscreteGpu`,
    `expectNoErrors`, `saveScreenshot` into `out/screens/<package>/`. Close loops on state with
    `waitForFunction`, never sleep. Then LOOK at every PNG you save (Read it) and iterate until it is
    convincing; a screenshot nobody looked at proves nothing.
15. Photometric rendering: luminance in cd/m^2 times `frame.exposure`, written through `writeHdr()`.

## Measurements

16. CPU timings and perf-spec numbers taken while the data bakes run (wave 1) are provisional. Record
    them with the machine load noted; do not loosen a budget or redesign around a load-induced miss. The
    lead re-measures on a quiet machine. GPU budgets are the lines of ARCHITECTURE section 17.1.

## Hand-off

17. Finish with `docs/handoff/<package id>.md`: public API with exact signatures, how to run and verify,
    measured numbers against each acceptance criterion (say plainly which were not met and why), known
    limits, data notes, and every contract change you requested. The next wave builds on this note
    without reading your internals.
