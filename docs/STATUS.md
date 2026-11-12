# Project status and how to resume

Living checkpoint, kept current by the lead. Read this first when picking the work up in a new session.
Last updated: 2026-11-11, 16:45 Pacific: end of the week's budget. Checkpoint: the original mission flies end to end in real Chrome.

## Where the project is

| Stage | State |
|---|---|
| Design v1 (`docs/ARCHITECTURE.md`, `docs/WORK_PACKAGES.json`) | Done; binding for everything built so far |
| Wave 1 (9 packages: render-core, terrain-core, bake-earth, bake-moon-sky, sim-orbits, sim-vessel, audio, flight-ui, map-view) | Done: built, independently reviewed, fixed. Hand-offs in `docs/handoff/` |
| Wave 2 (8 feature packages + core-support) | Built, reviewed and fixed. The headless mission flies pad to splashdown under real physics (`npm run test:mission`, about 77 s wall; touchdown 1.19 m from the lunar target, splashdown inside the recovery zone; `docs/handoff/sim-world-pilot.md`) |
| Visual close-out of wave 2 | **In progress** (see below). First critique scored every rendering package 3-5/10 against real photographs |
| App integration v1 (`src/app` wired against `createSim`, browser mission in real Chrome) | **Wired: the game is playable in the browser** (`npm run dev`, then `/`; the scripted test pilot flies inside the page at `/?pilot=1`). `docs/handoff/app-integration-v1.md` has the keys, the frame-time table and the pictures. **Browser mission flown** (commit 4917a66): the in-page test pilot flew lunar-direct pad to splashdown in real Chrome on the RTX 5090 through the player's controls in 44.9 minutes, all 17 milestones in order, every milestone gate met, `cheatCounter` 0, no page errors (touchdown 1.94 m from the target on level 12 of 12, 1.00 m/s down, tilt 0.35 deg; entry 11.0 km/s, peak 5.93 g; splashdown on water inside the Central Pacific zone, upright). GPU frame time within the 11 ms line in every phase (worst window 8.4 ms at lift-off, 2560x1440). The spec is still red on soft budget lines: rAF (the headless clock runs at about 57.5 Hz: request app-integration-8, blocking for those lines), main-thread p99 above 6 ms in 24 of 80 phase rows (near terrain: app-integration-7; during burns: not yet attributed), 2 frames of 33 ms or more in 153,167. Record: `docs/qa/mission/browser-mission-2026-11-11.json`; pictures in `out/screens/mission/` |
| Lead data change: eight-component swell (requests ocean-5/6) | Done: `docs/handoff/lead-swell.md`; headless mission re-passes, new golden `3f3a131cdd88eba7` |
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

| Package | Round 0 | Latest critique | State at the checkpoint (next step) |
|---|---|---|---|
| flight-ui | 5.5 / 6.5 | r5: 7.8 / 7.9 (0 blockers, 1 major) | nearly there: one more fix round on the r5 lists |
| map-view | 4 / 4.5 | r4: 6.5 / 7 (0 blockers, 2 + 2 majors) | round 5 fixes partly committed; critique r5 next |
| atmosphere-clouds | 4 / 4 | r1: 5.5 / 5.5 (0 blockers, 8 + 8 majors) | round 2 fixes in progress (uncommitted work in the tree); critique r2 next |
| ocean | 4 / 4 | r1: 5 / 5.5 (1 blocker, 10 + 10 majors) | fix round 2 on the r1 lists |
| vfx | 3.5 / 3.5 | r1: 4.5 / 5 (3 + 2 blockers) | round 2 fixes in progress (uncommitted work in the tree) |
| sky-lighting | 4.5 / 5 | r1: 6 / 6.5 | round 2 fixes committed; critique r2 next |
| cockpit | 3 / 3.5 | r1: 4 / 4 (3 + 1 blockers) | round 2 fixes partly committed; continue round 2 |
| terrain-render | 5 / 4.5 | r0: 5 / 4.5 (1 + 1 blockers) | round 1 fixes committed (trees to 7 km, ground colour, pad relief); critique r1 next |
| vehicle-pad | 4 / 4 | none since round 0 | round 1 fixes committed (parts 1-7, lights with shadows); critique r1 next |

The critique lists of every round are in git under `docs/qa/wave2/` (copies of `out/qa/wave2/`); the reference
library's index is `docs/qa/ref/INDEX.md` (the images themselves are only in `out/qa/ref/`, 51 MB, rebuildable
from the URLs in the index).

## What the browser mission showed (for the visual close-out)

From the milestone pictures (`docs/handoff/app-integration-v1.md`, "Browser mission"): ascent views look right
(max-q, separations, orbit with the limb); splashdown looks good (swell, foam ring, dawn clouds); the lunar touchdown
ground is believable. Biggest gaps: from TLI to entry no picture shows the Earth or the Moon (the vehicle is a few
pixels in black, or beside a frame-filling sun starburst) - the chase framing and the far bodies need work; both
cockpit pictures are nearly black; no flame at the nozzles at lift-off; separation particles are hard white
rectangles; the lander casts no visible shadow; at boot the land around the pad is drawn as sea for about 40 s at
1440p; the chute view has no horizon; HUD wording (title-cased banners "Tli Complete", resources "M-2 0 %" while
it holds 95 %, chute envelope "RISKY" while inside it, Mach shown in vacuum).

## Next steps, in order

1. Visual close-out to 8/8 for every package (table above), now also against the browser-mission pictures.
2. App integration: requests app-integration-7 (main-thread cost near terrain) and -8 (a real 60 Hz clock for the
   headless mission's rAF lines), attribute the main-thread cost during burns (the spec now records per-feature
   CPU; not yet run), and the boot-time sea around the pad; then the browser mission green on every line.
3. User feedback from playing the build (2026-11-11), for the next batch:
   - **Loading progress.** Entering the game takes a while (terrain tiles, LODs, the Milky Way cube, the sky probe)
     and the screen gives no sense of progress; for about 40 s at 1440p the land around the pad is even drawn as
     sea. Show a clear, honest progress indicator (what is loading, how far along) until the view at the pad is
     final, and do not show the scene before the ground under the camera is resident. In v2 this belongs to the
     shell's spawn flow (ARCHITECTURE_V2 section 23) and the boot pack (10.4); until then to `src/app`.
   - **Keyboard capture and automatic fullscreen are disorienting.** Today the first key or click requests
     fullscreen and the keyboard lock (`src/app/settings.ts`; `?capture=0` turns it off). Make it opt-in: start
     windowed and uncaptured, and offer fullscreen / keyboard lock as an explicit control (and a setting), with the
     key bindings working without it (the bindings already avoid Ctrl/Alt/Meta). Reflect it in the v2 menu and
     settings design.
4. v2: `MIGRATION_V2.md` section 2 is now met except for the visual sign-off; start with `lead-baseline-v2`
   (reference images from the signed-off tree), then waves 3-7.

## The 2026-11-11 15:35 crash and the git recovery

Bugcheck 0x119 (VIDEO_SCHEDULER_INTERNAL_ERROR, GPU scheduler/driver) while four WebGPU Chrome test runs ran at
once (373 W; memory was fine). The heavy gate is back to **two GPU slots** (`tools/dev/heavy.mjs`); keep it there
or update the NVIDIA driver (610.88) before raising it. The crash zeroed `.git/refs/heads/main`, the index and two
working files; main was restored to the last intact commit from the reflog (3762197), `git fsck --full` passed,
the index was rebuilt, and the two files were restored from HEAD. A copy of the damaged `.git` is in the session
scratchpad. Uncommitted work of the interrupted agents (atmosphere, vfx, flight-ui, app tests, two hand-offs) is
still in the working tree and also on the branch `wip/2026-11-11-crash` on GitHub: the next agent for each
package takes it over.

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
