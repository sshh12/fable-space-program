# Project status and how to resume

Living checkpoint, kept current by the lead. Read this first when picking the work up in a new session.
Last updated: 2026-11-12, 10:30 Pacific, by the lead: sub-wave 3.1 of v2 built (five packages), the visual
close-out two to five rounds further on, the stage-0 hosting skeleton deployed on Railway.
Checkpoint that still holds: the original mission flies end to end in real Chrome (2026-11-11).

## Where the project is

| Stage | State |
|---|---|
| Design v1 (`docs/research/ARCHITECTURE_V1.md`, `docs/research/WORK_PACKAGES_V1.json`; moved there on 2026-11-11) | Done; binding for everything built so far and for the wave-2 close-out |
| Wave 1 (9 packages: render-core, terrain-core, bake-earth, bake-moon-sky, sim-orbits, sim-vessel, audio, flight-ui, map-view) | Done: built, independently reviewed, fixed. Hand-offs in `docs/handoff/` |
| Wave 2 (8 feature packages + core-support) | Built, reviewed and fixed. The headless mission flies pad to splashdown under real physics (`npm run test:mission`, about 77 s wall; touchdown 1.19 m from the lunar target, splashdown inside the recovery zone; `docs/handoff/sim-world-pilot.md`) |
| Visual close-out of wave 2 | **In progress** (see below). First critique scored every rendering package 3-5/10 against real photographs |
| App integration v1 (`src/app` wired against `createSim`, browser mission in real Chrome) | **Wired: the game is playable in the browser** (`npm run dev`, then `/`; the scripted test pilot flies inside the page at `/?pilot=1`). `docs/handoff/app-integration-v1.md` has the keys, the frame-time table and the pictures. **Browser mission flown** (commit 4917a66): the in-page test pilot flew lunar-direct pad to splashdown in real Chrome on the RTX 5090 through the player's controls in 44.9 minutes, all 17 milestones in order, every milestone gate met, `cheatCounter` 0, no page errors (touchdown 1.94 m from the target on level 12 of 12, 1.00 m/s down, tilt 0.35 deg; entry 11.0 km/s, peak 5.93 g; splashdown on water inside the Central Pacific zone, upright). GPU frame time within the 11 ms line in every phase (worst window 8.4 ms at lift-off, 2560x1440). The spec is still red on soft budget lines: rAF (the headless clock runs at about 57.5 Hz: request app-integration-8, blocking for those lines), main-thread p99 above 6 ms in 24 of 80 phase rows (near terrain: app-integration-7; during burns: not yet attributed), 2 frames of 33 ms or more in 153,167. Record: `docs/qa/mission/browser-mission-2026-11-11.json`; pictures in `out/screens/mission/` |
| Lead data change: eight-component swell (requests ocean-5/6) | Done: `docs/handoff/lead-swell.md`; headless mission re-passes, new golden `3f3a131cdd88eba7` |
| Design v2 for the expanded scope (`docs/ARCHITECTURE.md` since the swap of 2026-11-11, `MIGRATION_V2.md`, `WORK_PACKAGES_V2.json`, `OPEN_QUESTIONS_V2.md`, `PACKAGE_RULES.md` with the v2 rules) | Done, critiqued and revised twice (cost floor, local stack); swapped in. 28 packages in waves 3-7 not started |
| v2 lead step `lead-baseline-v2` (MIGRATION_V2 step 3.0) | **Done except the reference images** (`docs/handoff/lead-baseline-v2.md`). The v2 contracts are in, additive (`session.ts`, `net.ts` with `UniverseRules`, `vehicle.ts`, `src/core/math/frame.ts`, optional fields everywhere else); the root configuration, the dependencies, the boundary rules, the stub scan, the `stack` class of the gate, the terrain guard and the mission baseline (`tests/mission/baseline-v1.json`, state hash `3f3a131cdd88eba7`) exist; typecheck (two configurations), the unit suite and the headless mission give the results they gave before. **Still to do by the lead:** record the reference images on the visually signed-off tree immediately before sub-wave 3.2, frame-exactly: this needs `window.__test.renderExact` in the render core first (request `lead-3`, open; the harness side is done; all 25 checkpoints are `pending` in `tests/browser/baselines.manifest.json`). The step was reviewed and its six majors and five minors fixed (hand-off section 12): the mission record is compared EXACT or by ENVELOPE against control flights, never by a fixed tolerance; the terrain guard's directions are stored; the gate's slots survive a killed wrapper; the contract items that cannot be additive (hand-off section 2: union members, `setTarget(TargetRef)`, nullable active vessel, the two warp levels) at the start of 3.2 and before wave 4; `%UserProfile%\.wslconfig` is the USER's to write (the agent's permission system refused it; OPEN_QUESTIONS, "Small things"): `platform-delivery` (3.1) needs the Docker VM cap for its compose suite and does not start Docker until the file exists. **After the independent review of `sim-core-v2`** (hand-off sections 13 and 14, 2026-11-12 05:10): the contracts carry `CraftSnapshot.cockpit` and `.parent` (the lineage of a craft: no consumer takes a vessel id or a craft id apart), the pad class limits as rules data (`UniverseRules.pads.classLimits`, a field of the default rules document; provisional numbers, the lead's to set from `fleet-data`'s table) and the id rules (an issued craft id, a vehicle id and an instance id contain none of `/`, `~`, `.`); the mission record's ENVELOPE also fails on a body or situation mismatch and judges e and i; the recorded files are pinned in `tools/dev/guard-pins.test.ts` (reviewed; only the lead changes a pin); ARCHITECTURE and MIGRATION_V2 record, as built, tick-pure state (no clock base), craft identity and the launch sequence of a vehicle that launches pre-docked. **Open:** the launch sequence is not implemented (`fleet-data` compiles it, `contact-docking` walks it); `rootOf` in `src/render/vehicle/vesselFeature.ts` parses the vessel id until the presentation sweep; the per-chute `envelope` state becomes nullable at the tighten step after 3.2. **Request site-bake-1** (hand-off section 15, 05:30): the Madrakah region is in the lead's records: the golden's Earth tile hash is `f70a61d55dca902f` (flight unchanged), the terrain guard's tile summary was re-recorded after a full-form audit (8,379 of 8,380 recorded Earth directories and all 2,344 of the Moon byte-identical, the manifest and 840 new directories the only changes) and the place group `site:madrakah` appended (Earth 2,800 points, every earlier point unchanged); mission 36 of 36. **The guard's heights are re-recorded once more, by the lead, when `fleet-data` writes the site files** (only points inside new flatten discs may change). Request `lead-4` (open): the Ka Lae unit records of the Earth bake are stale since the site rename; run regional steps with `--region` |
| v2 sub-wave 3.1: `sim-core-v2` | **Done, reviewed, fixed** (`docs/handoff/sim-core-v2.md`): vessels as craft trees joined by dock links, tick-pure state on the 1/120 s tick grid, codec v3 with migrations and corpus, `createSession` (`src/session`). Headless mission 36 of 36; golden `b8221b0fd316207e`; `tests/mission/baseline-v1.json` stays pinned |
| v2 sub-wave 3.1: `bodies-ephemeris` | **Done, reviewed, fixed**: 32 bodies in `data/staged/bodies`, orbits fitted to Horizons (planets 0.1 deg / 0.2 %, moons 1 deg / 2 %; approved exceptions Mimas and Miranda). **Open:** regenerate terrain sections, mean colours and credits from the planet bake's manifests (request `planet-bake-1`) once the soft-knee re-bake is verified |
| v2 sub-wave 3.1: `planet-bake` | **Built, reviewed, all eleven findings fixed and re-baked** (25 bodies in `data/tiles/<body>`; `verify.py --all` 812 of 814, the two failures clear with `planet-bake-1`). **In progress:** the lead's soft highlight knee (each body's level-0 mean albedo equals its target within 2 %, at most 0.5 % at the ceiling), about 13 bodies to re-bake. Lead decision: the DLR/ESA Phobos DEM ("no access or use constraints", credited) is an accepted third licence class |
| v2 sub-wave 3.1: `site-bake` | **Built, reviewed; review fixes in progress**: second site Madrakah (Oman), pads re-resolved on GLO-30 with built-up and launch-corridor gates (16 pads on the coastal plain 19.08-19.37 N), replace-mode swap, shallow-sea fix. **Then, by the lead:** audit, terrain-guard re-record, Earth tile hash in the golden |
| v2 sub-wave 3.1: `platform-delivery` | **Built** (`docs/handoff/platform-delivery.md`, `docs/capacity/2026-11-12-platform.md`); **independent review in progress**. Packs (content-addressed, range-readable; 862,220 tiles swept with 0 mismatches), the tile-source seam (`createTileSource`), a 22.4 MB boot set (cold load 4.05 s at 50 Mbit/s), the local stack (`npm run stack`, embedded Postgres 18), CI (green, about 4 runner-minutes a push), one image. **Deployed:** Railway project `fable-space-program` (services `game` and `shell` as hello roles, `postgres`, hourly `dump`; buckets `packs` and `dumps`), Modal environment `fsp`. Idle cost so far U + 5 USD = about 7.5 USD a month against the 30 USD ceiling. **Not done:** the 6 h and 72 h idle readings (`node deploy/railway/usage.mjs snapshot`; a reading was taken 2026-11-12 18:13 UTC, the next are due at +6 h and +72 h, then `report`); the compose suites (need the user's `.wslconfig`); two browser tests on the local stack; the client does not use the boot pack or the pack source yet (`presentation-sweep`). **Findings for the user:** the packs bucket FAILS the 2,000-concurrent-fetcher thresholds (2.74 % errors, p95 553 ms, 1.40 Gbit/s; passes at 500) - the front-page-traffic escalation of OPEN_QUESTIONS, not a stage-0 problem; a first session downloads 577 MB (461 MB with the OPFS cache) against the 300 MB the cost model assumed; an empty bucket `packs-orphan-undeployed` has to be deleted in the Railway dashboard |

User decisions that bind v2 are in `docs/research/v2/user-decisions.md` (anonymous identity, Railway Hobby at
about 50 USD/month for 5 players and about 30 USD idle, local end-to-end stack, Docker allowed, no alerts, GitHub
App and the larger load tests later). Lead decisions on escalated requests are recorded in the request files
themselves (`docs/requests/*.md`, "Lead decision" sections).

## Visual close-out

Every rendering package goes through fix round -> one independent critic judging two lenses (photograph and
artifact; `out/qa/wave2/<package>.r<n>.combined.json`) -> next fix round, until both lenses give 8/10 with no
blocker. Since 2026-11-12 the rounds run as background agents (one fixer per package, resumed with the critic's
list), not as a workflow script. A fixer's own score has run 0.5 to 1 above the critic's every time: only the
critic's score counts. The one GPU slot is the bottleneck (a browser run waits 1 to 1.5 hours): fixers batch
everything into as few runs as possible.

- Real reference photographs: `out/qa/ref/` (144 images, 12 subjects) with `out/qa/ref/INDEX.md` (sources,
  licences, what to learn, measured ratios). `out/` is git-ignored; the index is copied to `docs/qa/` at each
  checkpoint so the library can be rebuilt.
- Critique lists: `out/qa/wave2/<package>.md` (first critique) and `out/qa/wave2/<package>.r<n>.<lens>.json`
  (later rounds); copied to `docs/qa/wave2/` at each checkpoint.
- Scores so far (photo / artifact, out of 10):

| Package | Round 0 | Latest critique | State at the checkpoint (next step) |
|---|---|---|---|
| flight-ui | 5.5 / 6.5 | r6: 7.3 / 7.6 | round 7 fixes committed (fixer's own 8 / 8); critique r7 next, on real-game pictures from the mission re-flight |
| map-view | 4 / 4.5 | r4: 6.5 / 7 (0 blockers, 2 + 2 majors) | round 5 fixes partly committed; critique r5, then a fix round |
| atmosphere-clouds | 4 / 4 | r1: 5.5 / 5.5 (0 blockers, 8 + 8 majors) | fix round 2 running (also request `core-4`: cloud sequences keyed to the absolute frame index, which blocks the reference images); critique r2 next |
| ocean | 4 / 4 | r1: 5 / 5.5 (1 blocker, 10 + 10 majors) | fix round 2 running: pictures done (fixer's own 6.5), closing three red specs (hand-over at fade start, near-pass cost 1.2-1.4 ms against 0.6, foam repetition); critique r2 next |
| vfx | 3.5 / 3.5 | r2: 5.5 / 6 | fix round 3 running; critique r3 next. Owes: vent vapour and falling ice (`vehicle-pad-9`), entry streaks through the cockpit panes (`cockpit-19`) |
| sky-lighting | 4.5 / 5 | r1: 6 / 6.5 | round 2 fixes committed; critique r2, then a fix round (request `core-3`) |
| cockpit | 3 / 3.5 | r5: 6 / 6.5 (0 blockers, 17 majors) | fix round 6 running: default seat becomes the pilot's centre couch (lead decision on `cockpit-18`), sun patch, harness penetration, fabric moire, night pooling. Interior GPU line met (p99 0.733 ms against 0.8). No crew figures (lead decision) |
| terrain-render | 5 / 4.5 | r1: 5.5 / 5.5 | round 2 committed (wood-framed trees, one imagery treatment, lava albedo, lunar rocks and craters; fixer's own 7 / 6.5); continuation running on three reds: Earth ground-view GPU lines (1.66-3.66 ms against 1.5; shadows 0.99-2.39 against 0.5), the pop detector's control, the lunar ink-blot slope; critique r2 after |
| vehicle-pad | 4 / 4 | r2: 6 / 6 (0 blockers, 7 majors) | fix round 3 running: frost, flown capsule, markings as stickers, hatch rails, night stack lighting, tower detail, berm. The site sits on a ground survey of the real terrain (`tools/vehicle/site-ground.ts survey` must be re-run when terrain inside a site changes) |

Shared-code maintainer (render core, harness): working `cockpit-10` (grain on sunlit window wells, the shared
shadow filter) and `vehicle-pad-10` (contact shadows of thin fittings).

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

0. **Order agreed with the user (2026-11-12):** critics for every running fix round -> re-fly the browser
   mission (app shell first adds `await renderer.warm()`, the `renderExact` hook of request `lead-3`, the
   atmosphere loading row and the camera-reset binding of `app-integration-14`) -> record the reference images
   (needs `core-4`) -> the lead step before sub-wave 3.2 and `presentation-sweep` -> wave 4.1 (`island-core`,
   `wire-protocol`, `solar-system-sim`, `fleet-data`, `shell-menu`, `capability-settings`) in parallel with
   further visual rounds. Data side: `planet-bake` knee re-bake -> `bodies-ephemeris` regenerates
   (`planet-bake-1`); `site-bake` fixes -> lead audit and guard re-record; `platform-delivery` review -> fixes.
   Of the user's feedback in item 3, the loading screen, opt-in capture and the cockpit overlap (penetration
   check at zero) are done; the audio drop during entry and the footage labels' switches are done or routed.
1. Visual close-out to 8/8 for every package (table above), now also against the browser-mission pictures.
2. App integration: request app-integration-7 (main-thread cost near terrain); request -8 is RESOLVED (the
   57.5 Hz clock was the monitor asleep: `withGpuLock` now keeps the display awake, and the mission and app perf
   specs are to call `measureHarnessClock` / `expectNominalClock` before they judge rAF lines:
   `docs/requests/app-integration-8.md`); attribute the main-thread cost during burns (the spec now records per-feature
   CPU; not yet run), and the boot-time sea around the pad; then the browser mission green on every line.
3. User feedback from playing the build (2026-11-11), for the next batch:
   - **Loading progress.** Entering the game takes a while (terrain tiles, LODs, the Milky Way cube, the sky probe)
     and the screen gives no sense of progress; for about 40 s at 1440p the land around the pad is even drawn as
     sea. Show a clear, honest progress indicator (what is loading, how far along) until the view at the pad is
     final, and do not show the scene before the ground under the camera is resident. In v2 this belongs to the
     shell's spawn flow (ARCHITECTURE section 23) and the boot pack (10.4); until then to `src/app`.
   - **Keyboard capture and automatic fullscreen are disorienting.** Today the first key or click requests
     fullscreen and the keyboard lock (`src/app/settings.ts`; `?capture=0` turns it off). Make it opt-in: start
     windowed and uncaptured, and offer fullscreen / keyboard lock as an explicit control (and a setting), with the
     key bindings working without it (the bindings already avoid Ctrl/Alt/Meta). Reflect it in the v2 menu and
     settings design.
   - **Cockpit geometry overlaps.** Parts of the cabin interpenetrate: the console (dash) runs into the side of the
     craft (the hull wall), besides the seat and harness overlaps the critiques found. Request
     `docs/requests/cockpit-lead-1.md` (fit to the hull, plus an automated penetration check).
   - **From the mission video** (`tools/footage/`, video on the user's desktop): the sound drops to near silence
     during entry from about 66 km and Mach 16 right after the plasma (audio package); "TEST PILOT" and "Capture
     keyboard" labels should be hideable for footage; the headless 57.5 Hz clock causes slight judder.
4. v2: the lead step `lead-baseline-v2` is done except for the reference images
   (`docs/handoff/lead-baseline-v2.md`). In order:
   a. Review that step, then start sub-wave 3.1 (`sim-core-v2`, `bodies-ephemeris`, `planet-bake`,
      `site-bake`, `platform-delivery`): they need nothing that is still open. They compile against the
      working tree, so the wave-2 fixers and the wave-3 packages must both keep it compiling.
   b. When the visual close-out is signed off: record the reference images
      (`BASELINE_RECORD="<note>" node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional`;
      frame the fourteen checkpoints whose `page` is null first), LOOK at every PNG, commit the manifest.
   c. At the start of sub-wave 3.2: join the v2 union members, change `setTarget` to `TargetRef`, add the
      `'ui.scrimRects'` key (hand-off section 2, "what is therefore still to do"), and hand the sweep the list
      of deprecated fields.
   d. Then waves 4-7 as in `MIGRATION_V2.md` section 3.

## The 2026-11-11 15:35 crash and the git recovery

Bugcheck 0x119 (VIDEO_SCHEDULER_INTERNAL_ERROR, GPU scheduler/driver) while four WebGPU Chrome test runs ran at
once (373 W; memory was fine). The heavy gate went back to two GPU slots then, and to **ONE GPU slot** after
the third crash (2026-11-11 22:16, the same bugcheck with only two WebGPU runs at once; commit 23fdeb7): keep it
at one, or update the NVIDIA driver (610.88) before raising it. Waiters of a class are now served first come,
first served (050b2b3), and the gate has the class `stack` (one slot) for the local stack. The crash zeroed `.git/refs/heads/main`, the index and two
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
3. **Finish the visual close-out** for every package below 8/8 or with blockers. Since 2026-11-12: one
   background agent per package, briefed with the package's hand-off (its last "Visual close-out, round n"
   section), the latest `docs/qa/wave2/<package>.r<n>.combined.json` and `docs/PACKAGE_RULES.md`; a separate
   critic agent afterwards (it changes nothing, looks at every picture in `out/screens/<package>/` against
   `out/qa/ref/`). Every agent keeps scratch files in a subdirectory of its own and never deletes by wildcard
   (a reviewer's cleanup once emptied the shared scratch directory). The earlier workflow script was `~/.claude/projects/C--dev-fable-space-game/<session>/workflows/scripts/spacesim-visual-closeout-resume-*.js`
   (args: per package `start` = `takeover` | `critique`, `nextRound`, `list` = the latest critique files, and
   the score history). Open requests: `grep -l "^Status: open" docs/requests/*.md`.
4. **Finish app integration v1** if it is not done: `docs/handoff/app-integration-v1.md` says where it stands.
   Done means: a human can fly the original mission in the browser, and the Playwright `mission` project flies it
   end to end through the controls API (about 45 minutes).
5. **Then v2.** The lead step `lead-baseline-v2` of `docs/WORK_PACKAGES_V2.json` is done except for the
   reference images (next steps, item 4); then waves 3-7.
   The design-critical v2 packages (`suggestedModel: fable`) were written for the strongest model: keep the
   designs as written; do not simplify them to fit a weaker model.

## Machine and accounts

- Windows 11, RTX 5090, 62 GB RAM, Ryzen 9950X3D. One kernel bugcheck (0x4E, 2026-11-10) under seven agents'
  unthrottled load; one Windows Update restart (2026-11-11 00:29). Pause updates during long runs.
- GitHub: `sshh12/fable-space-program` (private), remote `origin`; push at every checkpoint after
  `node tools/dev/check-secrets.mjs`.
- Railway (Hobby, logged in), Modal (logged in; never touch existing apps), Docker Desktop installed (may be used
  for the local stack). `.env` holds OpenAI, Hugging Face and ElevenLabs keys: never print, commit or ship them.
- Three bugchecks in all (0x4E on 2026-11-10; 0x119 in the GPU scheduler twice on 2026-11-11): ONE GPU slot
  since. Disk: about 26 GB free on 2026-11-12 against the 25 GB floor; `data/packs` (14 GB) is mirrored,
  SHA-verified, on the Modal volume `fsp-packs` and rebuilds from `data/tiles` in about 70 s, so it is the
  first thing to delete when space is needed.
- Waiting on the user: `C:\Users\Shriv\.wslconfig` (6 GB cap) and `wsl --shutdown` before any Docker compose
  suite; the orphan bucket in the Railway dashboard; a decision on tile delivery beyond Railway's bucket
  before a front-page launch.
- Model budget: the week's Fable allowance ran out on 2026-11-11 (resets 2026-11-16); work continued on Opus 5.5.
  The user then added credit for Fable/Opus workloads (about 2,000 USD on 2026-11-12): stop launching new
  agents at about 85 % of it and leave this file current.
