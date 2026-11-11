# Project status and how to resume

Living checkpoint, kept current by the lead. Read this first when picking the work up in a new session.
Last updated: 2026-11-11, early afternoon (Pacific), during the visual close-out on Opus 5.5.

## Where the project is

| Stage | State |
|---|---|
| Design v1 (`docs/ARCHITECTURE.md`, `docs/WORK_PACKAGES.json`) | Done; binding for everything built so far |
| Wave 1 (9 packages: render-core, terrain-core, bake-earth, bake-moon-sky, sim-orbits, sim-vessel, audio, flight-ui, map-view) | Done: built, independently reviewed, fixed. Hand-offs in `docs/handoff/` |
| Wave 2 (8 feature packages + core-support) | Built, reviewed and fixed. The headless mission flies pad to splashdown under real physics (`npm run test:mission`, about 77 s wall; touchdown 1.19 m from the lunar target, splashdown inside the recovery zone; `docs/handoff/sim-world-pilot.md`) |
| Visual close-out of wave 2 | **In progress** (see below). First critique scored every rendering package 3-5/10 against real photographs |
| App integration v1 (`src/app` wired against `createSim`, browser mission in real Chrome) | **Next / in progress**. `src/app/main.ts` is still the 78-line boot shell: nobody can play the game yet |
| Design v2 for the expanded scope (`docs/ARCHITECTURE_V2.md`, `MIGRATION_V2.md`, `WORK_PACKAGES_V2.json`, `OPEN_QUESTIONS_V2.md`) | Done, critiqued and revised twice (cost floor, local stack). Not started: 29 packages in waves 3-7 |

User decisions that bind v2 are in `docs/research/v2/user-decisions.md` (anonymous identity, Railway Hobby at
about 50 USD/month for 5 players and about 30 USD idle, local end-to-end stack, Docker allowed, no alerts, GitHub
App and the larger load tests later). Lead decisions on escalated requests are recorded in the request files
themselves (`docs/requests/*.md`, "Lead decision" sections).

## Visual close-out

Every rendering package goes through fix round -> two independent critics (a photograph lens and an artifact
lens) -> next fix round, until both lenses give 8/10 with no blocker, at most two more rounds per package this week.

- Real reference photographs: `out/qa/ref/` (144 images, 12 subjects) with `out/qa/ref/INDEX.md` (sources,
  licences, what to learn, measured ratios). `out/` is git-ignored; the index is copied to `docs/qa/` at each
  checkpoint so the library can be rebuilt.
- Critique lists: `out/qa/wave2/<package>.md` (first critique) and `out/qa/wave2/<package>.r<n>.<lens>.json`
  (later rounds); copied to `docs/qa/wave2/` at each checkpoint.
- Scores so far (photo / artifact, out of 10):

| Package | Round 0 | Round 1 | Later |
|---|---|---|---|
| atmosphere-clouds | 4 / 4 | fix round 1 in progress | |
| sky-lighting | 4.5 / 5 | 6 / 6.5 | fix round 2 in progress |
| ocean | 4 / 4 | fix round 1 in progress | |
| vehicle-pad | 4 / 4 | fix round 1 in progress | |
| cockpit | 3 / 3.5 | 4 / 4 | fix round 2 in progress |
| vfx | 3.5 / 3.5 | fix round 1 in progress | |
| terrain-render | 5 / 4.5 | fix round 1 in progress | |
| flight-ui | 5.5 / 6.5 | 6.8 / 7 | rounds 2-3 fixed without critics; critique pending |
| map-view | 4 / 4.5 | 6 / 6.5 | rounds 2-3 fixed without critics; critique pending |

## How to resume

1. **Look at the tree first.** `git status --short`, `git log --oneline -30`, `node tools/dev/heavy.mjs --status`.
   Uncommitted changes under a package's paths are an interrupted agent's work in progress: the next agent for
   that package takes them over (keep what is right, finish what is half done). Never `git add -A`.
2. **Start the resource logger** for the session: `node tools/dev/sysmon.mjs` in the background (logs to
   `out/sysmon/`). All heavy commands go through `node tools/dev/heavy.mjs --class=cpu|gpu|bake -- <cmd>`
   (`docs/PACKAGE_RULES.md`, "Machine load"): the machine bug-checked once under unthrottled agent load.
3. **Finish the visual close-out** for every package below 8/8 or with blockers: the workflow script used this
   week is `~/.claude/projects/C--dev-fable-space-game/<session>/workflows/scripts/spacesim-visual-closeout-resume-*.js`
   (args: per package `start` = `takeover` | `critique`, `nextRound`, `list` = the latest critique files, and
   the score history). Open requests: `grep -l "^Status: open" docs/requests/*.md`.
4. **Finish app integration v1** if it is not done: `docs/handoff/app-integration-v1.md` says where it stands.
   Done means: a human can fly the original mission in the browser, and the Playwright `mission` project flies it
   end to end through the controls API (about 45 minutes).
5. **Then v2.** `MIGRATION_V2.md` section 2 is the starting point (wave 2 committed and reviewed, `src/app` wired,
   browser mission run); then the lead step `lead-baseline-v2` of `docs/WORK_PACKAGES_V2.json`, then waves 3-7.
   The design-critical v2 packages (`suggestedModel: fable`) were written for the strongest model: keep the
   designs as written; do not simplify them to fit a weaker model.

## Machine and accounts

- Windows 11, RTX 5090, 62 GB RAM, Ryzen 9950X3D. One kernel bugcheck (0x4E, 2026-11-10) under seven agents'
  unthrottled load; one Windows Update restart (2026-11-11 00:29). Pause updates during long runs.
- GitHub: `sshh12/fable-space-program` (private), remote `origin`; push at every checkpoint after
  `node tools/dev/check-secrets.mjs`.
- Railway (Hobby, logged in), Modal (logged in; never touch existing apps), Docker Desktop installed (may be used
  for the local stack). `.env` holds OpenAI, Hugging Face and ElevenLabs keys: never print, commit or ship them.
- Model budget: the week's Fable allowance ran out on 2026-11-11 (resets 2026-11-16); work continued on Opus 5.5.
