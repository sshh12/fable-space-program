# Rules for every work package

Binding for every package in `docs/WORK_PACKAGES_V2.json` (waves 3-7), and for the packages still closing
out wave 2. The package brief adds scope and acceptance; where a brief is stricter, the brief wins. The
RULES paragraph at the end of every v2 brief is this document in short.

## Which documents bind whom (2026-11-11: the v2 design is swapped in)

- `PROMPT.txt` binds everyone, both halves (the original scope and the section headed `--- expansion ---`).
- `docs/ARCHITECTURE.md` is the v2 architecture. It binds every package of `docs/WORK_PACKAGES_V2.json` and
  wins over the research documents and proposals. `docs/MIGRATION_V2.md` says how the code moves to it.
- The wave-2 close-out (the visual close-out of the rendering packages, app integration v1 and their
  maintainers) keeps its own briefs and v1: `docs/research/ARCHITECTURE_V1.md`, with the briefs in
  `docs/research/WORK_PACKAGES_V1.json`. Section numbers in code comments written before the swap refer to
  that file. Close-out packages do not implement expansion features and do not report their absence as a
  finding; they make no choice that would block the expansion where the generic choice costs the same (no
  code that assumes exactly two bodies, one vessel, one player, one launch pad or one vehicle).
- The user's decisions (`docs/research/v2/user-decisions.md`) override any research recommendation.

## Before coding

Read in full: `PROMPT.txt`, `docs/ARCHITECTURE.md` (or `docs/research/ARCHITECTURE_V1.md` for a wave-2
close-out package), `src/core/contracts/*.ts`, `docs/requests/README.md`, and the documents your brief lists.

## Ownership

1. Edit only the paths your brief lists as owned; an entry starting with `!` is excluded. Everything else
   is read-only. The lead owns `src/core/contracts` (except the parts a brief names), the root
   configuration (`package.json`, the lockfile, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`,
   `playwright.config.ts`, `.gitignore`), `tools/dev`, `src/core/math`, `src/core/testing`, `labs/template`,
   `tests/browser/{harness,globalSetup,chromeArgs}.ts`, `tests/browser/shell`,
   `tests/browser/baselines.manifest.json`, `tests/unit/terrain-core/terrain-guard.*`,
   `tests/mission/baseline-v1.json` and `docs/` outside hand-offs and capacity reports.
   **Never run `npm install`**: the dependencies and configuration entries you need are listed under
   PROVIDED BY THE LEAD in your brief, or are a request.
2. A change you need elsewhere is a request file (`docs/requests/README.md`). The lead answers contract and
   configuration requests during a wave; work within your own paths meanwhile.
3. Before writing your hand-off, look in `docs/requests/` for open requests against YOUR paths and resolve
   them (same status/resolution format).

## Quality

4. No placeholders, stubs, TODO comments, "simplified for now", silent fallbacks or dead code paths. If
   something cannot be finished, say so plainly in the hand-off instead of leaving a marker in the code.
   `node tools/dev/check-stubs.mjs` scans for `TODO`, `FIXME`, `stub` and `placeholder` (CI runs it); its
   allow-list `tools/dev/check-stubs.allow.json` is the lead's, and a legitimate use of one of the words
   (the simple bodies' permitted placeholder visuals, the HTML attribute) is a request to add an entry.
5. Conventions (units, frames, quaternions, precision, ticks, ids) per ARCHITECTURE sections 3 and 4.
6. Import and determinism rules per ARCHITECTURE section 2, enforced by
   `npx vitest run tools/dev/boundaries.test.ts`: it must pass before every commit. Headless packages
   (`src/sim`, `src/universe`, `src/session`, `src/terrain`, `src/pilot`) use no DOM, no WebGPU, no timers,
   no `Math.random`, `Date`, `performance`, no sockets and no storage (the tile I/O modules of `src/terrain`
   may fetch and use the origin-private file system); avoid naming a local variable `window`, `document` or
   `navigator` there. `server/`, `bots/`, `deploy/` and the headless directories are also type-checked
   without the DOM library (`tsconfig.node.json`).
7. Engine code never mentions a specific body, vehicle, part, site, scenario, milestone or rule value.
   Tunables and content live in `data/defs` (sections under `audio/` and `visuals/` reach you through
   `DefLibrary.sections`). Every number of the time model, contact, docking, pads, expiry and the rate
   limits is a field of `UniverseRules` (`src/core/contracts/net.ts`), read from the rules document in
   force, never written into code.
7a. Until the tighten step after sub-wave 3.2, no field of a vehicle, part, body, site or rules definition
    that the state hash or the codec's vehicle reference covers may change; any edit under
    `data/defs/{vehicles,parts,bodies,sites,rules}` is followed, before its commit, by `npx vitest run
    tests/unit/sim-vessel/codec.test.ts tools/dev/guard-pins.test.ts` and `npm run test:mission` through the
    gate. (The corpus of `tests/unit/sim-vessel/corpus` holds vessel blobs written by earlier codec versions
    against the definitions as they were; they cannot be re-written, and the mission alone does not show the
    break. MIGRATION_V2 principle 5 has the episode; from the tighten step on, presentation fields such as
    cameras, seats, names and references to visuals are outside the hash and free to change.)

## Shared working tree

8. Other agents work in the same tree at the same time, and they compile against the working tree as it
   is, not against the last commit: never leave a shared or exported file in a state that does not compile,
   and commit working states often. Verify with scoped commands only:
   - `npm run typecheck:paths -- <your paths>` (both TypeScript configurations);
   - `npx vitest run <your paths>`. The unit suite collects `*.test.ts` under `src/`, `tests/unit/`,
     `tests/universe/`, `tests/load/`, `tools/`, `server/` and `bots/`; `tests/mission/` runs only as
     `npm run test:mission`; `tests/net/` only as `npm run test:net`, inside a stack (rule 9);
   - `npx playwright test tests/browser/<dir> --project=functional`; perf specs are named
     `*.perf.spec.ts`, run with `--project=perf` and measure only inside `withGpuLock`; `tests/acceptance/`
     is the project `acceptance`, run inside a stack; `tests/browser/mission/` is the project `mission`.
9. Never run `npm run build` or `npm run check` (they write the shared `dist/`). The only client build a
   package may run is `npm run stack:client` (the lead's; it writes `data/stack/client/<source hash>/`,
   never `dist/`). Never leave a dev server, a browser, a database, a container or a background process
   running; browser tests start their own server on a free port.
   **The local stack** (host Node processes and an embedded PostgreSQL 18, no Docker; ARCHITECTURE 16.4)
   **never runs in the background.** Start it only as
   `npm run stack -- [options] -- <your suite command>` with `STACK_NAME=fsp-<package id>`: the script takes
   the ONE `stack` slot of the gate, brings the stack up, runs your command with `STACK_URL`,
   `STACK_ENDPOINTS` and `STACK_STATE` set, and stops the stack when the command exits. A command inside it
   that needs the GPU is itself wrapped in `node tools/dev/heavy.mjs --class=gpu`. Hold the slot for one
   suite at a time and give it up between suites: other packages wait for it. The docker compose form (the
   pinned Linux image) is the same command with `--compose`, in the same slot, only for the suites your
   brief names; it stops what it started, a Docker daemon included.
10. Git: only `git add <your paths>` then `git commit`. Never `git add -A`, `git stash`, `git reset`,
    `git checkout .`, rebase, amend or push (releases are tags the lead moves). Retry on `index.lock`. Never
    commit `.env`, `data/tiles`, `data/sky`, `data/cache`, `data/packs`, `data/baselines`, `data/stack`,
    `out/`. Commit working states often.
    **The index is shared too.** A plain `git commit` takes everything that is staged, whoever staged it
    (on 2026-11-11 one agent's commit carried another's staged renames). So: stage and commit in ONE
    command line and name your paths in the commit, `git add <your paths> && git commit -m "..." -- <your
    paths>`; never leave anything staged; `git mv` and `git rm` stage at once, so commit them in the same
    command line.
11. Write files with the Write tool (shell heredocs corrupt backslashes and quotes on this Windows
    machine); use absolute paths; forward slashes inside code.
12. Secrets (`.env`, provider tokens) are read only at run time by tools under `tools/`, `server/`, `bots/`
    or `deploy/`. Never print a key, never put one in a URL you log, never reference one from `src/` or
    `public/`, never commit one, never ship one to the client. If you touch them, run
    `node tools/dev/check-secrets.mjs` before every commit. Budget per provider is stated in the brief.
13. Downloads are untrusted data: each in its own directory under `data/cache/<area>/`, scripts elsewhere,
    Python run with `python -I`.

## Cloud

13f. Never touch existing Modal apps or volumes or the existing Railway project. Create cloud resources only
     when your brief names them, only in the Railway project `fable-space-program` and the Modal environment
     `fsp` (both approved by the user: `docs/OPEN_QUESTIONS_V2.md`, Answered), on the Railway HOBBY plan and
     inside the stage-0 limits of ARCHITECTURE 16.2. Anything that needs the Pro plan, raises the standing
     spend or is a rehearsal beyond what the Hobby plan allows is the lead's to announce to the user first:
     stop and ask the lead. Never build alert routing and never ask for a webhook.
13g. Everything else is built and verified on the local stack, which needs no cloud resource. A local-stack
     result is never reported as a deployed or measured-capacity result.

## Machine load (added after the 2026-11-10 crash)

The machine bug-checked (kernel memory corruption, `0x4E`) while seven agents ran bakes, real-data test
suites and GPU browser tests at the same time. It bug-checked twice more on 2026-11-11 (`0x119`,
VIDEO_SCHEDULER_INTERNAL_ERROR, in the GPU driver): at 15:35 with four WebGPU Chrome runs at once, and at
22:16 with two. These rules are binding:

13a. Run every heavy command through the gate:
     `node tools/dev/heavy.mjs --class=<cpu|gpu|bake|stack> -- <command>`.
     `cpu` (3 slots): vitest over more than a couple of files, benchmarks, profilers, headless mission runs,
     the client build. `gpu` (**ONE slot** since the third crash; do not raise it without a new NVIDIA
     driver): every Playwright / Chrome run. `bake` (1 slot): every data bake or other multi-process job.
     `stack` (ONE slot, no override): the local stack and the docker compose suites; the launcher is the
     wrapped command and holds the slot for as long as a stack is up (rule 9).
     The gate waits for a slot and for free memory; with one GPU slot shared by every agent a browser run
     may wait many minutes: start it in the background and wait for it rather than bypassing the gate.
     `node tools/dev/heavy.mjs --status` shows the slots and their holders.
13b. One heavy command at a time per agent. Never start a second while the first runs.
13c. Worker pools: at most 6 processes per bake; vitest is capped at 6 workers by `vitest.config.ts` (do
     not raise it). Do not load a whole global raster into every worker: window the reads.
13d. Disk: keep the baked data under `data/` (tiles, sky, staged, defs) under 22 GB, `data/packs` under
     20 GB in its own directory, and at least 25 GB of the disk free; delete intermediates you no longer
     need (the page file needs room). `data/stack` holds only the current stack's state and the two most
     recent client builds.
13e. After a crash or restart, treat files written in the last minutes before it as suspect: check baked
     outputs for zero-length or truncated files before trusting a resumed job.

## Browser work

14. Follow `labs/template` and `tests/browser/shell/lab-template.spec.ts`: `openPage`, `assertDiscreteGpu`,
    `expectNoErrors`, `saveScreenshot` into `out/screens/<package>/`. Real Chrome, real GPU; assert the
    adapter. Close loops on state with `waitForFunction`, never sleep. Then LOOK at every PNG you save (Read
    it) and iterate until it is convincing; a screenshot nobody looked at proves nothing.
15. Photometric rendering: luminance in cd/m^2 times `frame.exposure`, written through `writeHdr()`.
15a. Reference images (ARCHITECTURE 31.3): where your brief names them, open a checkpoint with
     `openCheckpoint(page, name)` (its page and its setup steps, at the manifest's viewport) and compare with
     `expectBaseline` / `compareToBaseline` of `tests/browser/harness.ts`; never re-record one yourself:
     re-recording needs a note signed by the lead. The comparison captures a lead-in frame and then two
     that must be identical to the bit (request core-7): a `NotFrameExactError` means your page still
     changes when every feature reports idle, which is a finding, not a tolerance to raise. A checkpoint
     marked `exact` in the manifest (most are) passes only when NO pixel differs from its reference; the
     few that are not exact say why and name the request that would make them so. They were
     recorded before sub-wave 3.2 on the tree as it stood: a change that is MEANT to move pixels says which
     checkpoints it moves and asks the lead to re-record them. To find WHAT moves in a page that is not
     frame-exact: `BASELINE_EXACT_PROBE=<checkpoint>` with `tests/browser/shell/baseline-exact-probe.spec.ts`
     (several captures, where each pair differs, a picture with the pixels marked). A feature with a clock,
     a history or a phase of its own restarts it in `resetTemporal()` (RENDER_API section 13).
15b. Frame pacing: perf numbers are taken inside `withGpuLock`, which also keeps the display awake (Chrome
     paces frames at about 57.5 Hz while the monitor sleeps). A spec that asserts a requestAnimationFrame
     line measures the harness clock (`measureHarnessClock`) and asserts on a nominal one
     (`expectNominalClock`); a pacing line is never judged against a slower clock with a wider number.

## Measurements

16. CPU timings and perf-spec numbers taken while other heavy jobs run are provisional. Record them with
    the machine load noted; do not loosen a budget or redesign around a load-induced miss. The lead
    re-measures on a quiet machine. GPU budgets are the lines of ARCHITECTURE section 29.1 (v1: 17.1).

## Hand-off

17. Finish with `docs/handoff/<package id>.md`: public API with exact signatures, how to run and verify,
    measured numbers against each acceptance criterion (say plainly which were not met and why), known
    limits, data notes, and every contract change you requested. The next wave builds on this note
    without reading your internals.
