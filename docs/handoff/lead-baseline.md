# Lead baseline between wave 1 and wave 2 (2026-11-10)

What the lead did after wave 1 finished: answered every open request in `docs/requests/`, fixed what was red,
and re-ran the whole tree. Code and docs are commit `3d9fcae`; the request resolutions and this note are the
commit after it. Wave-2 packages read this after `docs/ARCHITECTURE.md` and before their brief's READ list.

## 1. Requests

Nothing is open (`node tools/dev/wait-requests.mjs --open` finds none). Each file has the details under
`## Resolution`.

| Request | Against | Result | One line |
|---|---|---|---|
| `audio-1` | contracts/audio.ts | resolved `3d9fcae` | `AudioListener.attachedVesselId` (required); structure-borne share only for a camera attached to the vessel; `ambientPressure` (interior = outside pressure) and the map-listener rule documented |
| `bake-moon-sky-1` | bake-moon-sky acceptance | resolved `3d9fcae` | Tycho benchmark judged against the 256 ppd `ldem_256` pixel (-1357 m), same 60 m; the other three unchanged |
| `bake-moon-sky-2` | bake-moon-sky acceptance | resolved `3d9fcae` | De-shading judged on residual illumination: geometric-mean wall ratio within 5 % of 1 and no correlation with the raw mosaic (abs r < 0.3); per-crater ratios reported |
| `flight-ui-1` | vite.config.ts | resolved earlier `fa1c31b` | No dependency scan of `data/`; first page load seconds, not minutes |
| `map-view-1` | src/input | resolved earlier `264d8ac` | Editable DOM targets reach no key binding; `overUi` over any element but the canvas |
| `map-view-2` | vite.config.ts | resolved earlier `fa1c31b` | Same fix as `flight-ui-1` |
| `map-view-3` | contracts ui / render / sim | resolved `3d9fcae` | Doc comments: `displaySize` in CSS px, `drawOverlay` target, where `planned` starts, at-intercept anchor, what `consumed` covers. `MapView.mount` not added (factory option `uiRoot` stays) |
| `render-core-1` | contracts/render.ts | **declined** | No `'clouds.shadowParams'` key; cloud-shadow placement stays with `coreOf(ctx).setCloudShadowParams({ near, far })`, now stated in the contract comment |
| `render-core-2` | tools/server | resolved `3d9fcae` | `GET /tiles/index.json` -> `{ tilesets: string[] }`; LabPlanet skips a tile set that is not baked |
| `render-core-3` | contracts/render.ts | resolved `3d9fcae` | `ShadowCascadeView.texelSizeV` added; `texelSize` = coarser axis; cull by `viewProj`, not by `farDistance` |
| `sim-orbits-1` | start-time policy | resolved `3d9fcae` (decision) | Either coplanar azimuth; start 2029-09-24T18:26:58.8Z, launch azimuth 99.4 deg (section 3) |
| `sim-orbits-2` | contracts/sim.ts, FakeSim | resolved `3d9fcae` | `NavballState` angles documented; FakeSim roll sign flipped to the control sign |
| `sim-orbits-3` | core/math/conic.ts | resolved `3d9fcae` | Cancellation-free `timeFromPeriapsis` in core; the sim's copy removed; radial conic convention documented |
| `sim-vessel-1` | contracts defs / simInternal | resolved `3d9fcae` | Doc comments: RCS `dir` = exhaust, leg foot pads, decoupler cuts the joint to the parent, environment = start of step; sim-design q-alpha limit corrected to about 3 500 Pa rad |
| `terrain-core-1` | contracts/terrain.ts | resolved `3d9fcae` | `TileLayerManifest.sourceCoverage` and `SOURCE_BLEND_TILES` in the contract; `effectiveLevel` comment relaxed |
| `terrain-core-2` | bake-moon-sky data | resolved earlier `2d0d820`, `c3fa50e` | NAC seam and SLDEM track stripes removed, levels 7-12 re-baked |
| `terrain-core-3` | bake-earth data | resolved earlier `a6dc2b7` | Smooth regional sea floor |
| `terrain-core-4` | both bakes | resolved `4f89577` (Moon), `93e67ae` (Earth) | `sourceCoverage` lists only tiles with data finer than the parent: Moon level 9 empty, Earth land tiles only. The lead corrected the real-data texture test for it (section 4) |

## 2. Contract and API changes

"Migration" is what existing code must do. Everything else in `src/core/contracts` is unchanged.

| Change | Where | Affects in wave 2 | Migration |
|---|---|---|---|
| `AudioListener.attachedVesselId: string \| null` (required). Set by `buildAudioListener` from `camera.focusVesselId` of a `kind: 'external'` camera; null for cockpit, map and free cameras | `contracts/audio.ts`, `src/camera/listener.ts`, `src/audio/model.ts` | core-support (owns audio, camera); the lead's app shell; any lab that builds a listener by hand | Add the field to every `AudioListener` literal (TypeScript reports it). A new external rig that follows a vessel must set `CameraState.focusVesselId` |
| `ShadowCascadeView.texelSizeV: number` (m; equals `texelSize` for a square cascade) | `contracts/render.ts`, filled in `src/render/core/shadows/shadowSystem.ts` | terrain-render, vehicle-pad, vfx (anything with `drawShadow`) | None: additive for readers. `texelSize` stays the value for caster LOD and small-caster culling; cull against `viewProj`, never by `farDistance` |
| `TileLayerManifest.sourceCoverage?: Record<string, TileRect[]>` and `export const SOURCE_BLEND_TILES = 1` | `contracts/terrain.ts` | terrain-render, sim-world-pilot, core-support | None. Both manifests carry the field; `E_L = E_(L-1) + s_L (L - E_(L-1))` with `s_L` on the source rectangles. `TerrainResidency.effectiveLevel` is lower than `availableLevel` in coverage margins and at levels without finer source data: gate on `availableLevel` and `complete`, not on `effectiveLevel == availableLevel` |
| `timeFromPeriapsis(e, p, mu, nu)`, `atanOverX`, `atanhOverX` exported from core; `timeSincePeriapsis(c, nu)` is that relation (no parabolic band, `c.a` not read) | `src/core/math/conic.ts`; `src/sim/orbit/anomaly.ts` re-exports | sim-world-pilot, core-support (map) | None. Values change only within rounding away from e = 1 and become correct near it |
| `ConicElements`: radial trajectories are published with `e = 1`, `p = 0` (test `p === 0`), `period = null`; `period` is null from `e >= 1 - 1e-9` (test `period !== null` for "closed") | comment in `conic.ts` | sim-world-pilot (publishes patches), core-support (map draws them) | None; draw a radial patch as the straight segment between its start and end positions |
| `NavballState.pitchDeg / headingDeg / rollDeg` defined: roll positive = rotation about +Y (dorsal toward starboard), heading of the ventral side when the nose is vertical. FakeSim follows it (its roll sign flipped; pad heading is now 90, was 0) | `contracts/sim.ts`, `src/core/fakes/fakeSim.ts` | cockpit (instruments on the FakeSim), sim-world-pilot (already computes this in `attitudeAngles`) | Anything tuned against FakeSim's old mirrored roll sees the sign change; code that followed ARCHITECTURE section 3 needs nothing |
| `SimSnapshot.patches.planned` starts AT the first future node (`planned[0].tStart = nodes[0].ut`), every planned patch has `afterNodeId` | comment in `contracts/sim.ts` | sim-world-pilot | None: `predictPatches` already emits this; publish it unchanged |
| `Patch.bodyPosAtEnd`: at-intercept anchor = body position at SOI entry, derived from the preceding patch | comment in `contracts/sim.ts` | core-support (map) | None |
| `RenderFeature.drawOverlay`: one colour target in `RenderContext.canvasFormat` (non-sRGB view), no depth; write sRGB-encoded values, premultiplied alpha; `frame.displaySize` is device px | comment in `contracts/render.ts` | any package that adds an overlay | None |
| `'clouds.shadowMap'` / `'clouds.coverageMap'`: placement goes through `coreOf(ctx).setCloudShadowParams({ near, far })` in `prepare`, every frame; there is no shared-resource key for it | comment in `contracts/render.ts`, RENDER_API section 7 | atmosphere-clouds | Call it every frame; `null` switches a term off |
| `MapView.update` `displaySize` = CSS px; `MapUpdateResult.consumed` = draggable elements and the DOM panel only; `NavballRenderer.view` = sRGB-encoded, premultiplied | comments in `contracts/ui.ts` | cockpit (navball texture), the lead's app shell | None |
| Part contract: `rcs.thrusters[].dir` = exhaust direction; `contactPoints[i]` of a `legs` part = foot pad of leg `i`; `decoupler` / `decouple` / `jettisonLES` cut the joint to the PARENT, impulse along the part's Y; `fairing.shields` match instance or def id; `joint.maxQAlpha` in Pa rad | comments in `contracts/defs.ts` | vehicle-pad, vfx (RCS plumes along `dir`), sim-world-pilot | None |
| `VesselEnvironment` describes the START of the step; spawned vessels are stepped once in the same tick | comment in `contracts/simInternal.ts` | sim-world-pilot | Build the environment for `ut`, not `ut + dt` |
| `GET /tiles/index.json` -> `{ "tilesets": string[] }` (also emitted into a production build); `listTilesets(tilesRoot)` exported | `tools/server/dataPlugin.ts` | terrain-render, atmosphere-clouds, every lab | Optional: fetch `${ctx.tilesUrl}/index.json` before a manifest that may not exist; a 404 is a console error and fails `expectNoErrors` |
| `vitest.config.ts`: `minWorkers` removed (not an option in vitest 5; it made `npm run typecheck` fail) | config | everyone | None; the 6-worker cap is unchanged |

## 3. Decisions

**Scenario start (sim-orbits-1).** The launch opportunity may be either coplanar crossing of the Moon's orbit
plane. `tools/sim/start-time.json` (regenerated for the final pad and the bake-recommended lunar target):

| | |
|---|---|
| startUt | 938240818.839663 = 2029-09-24T18:26:58.839Z |
| launch | start + 600 s, descending crossing, surface azimuth 99.4021 deg (inertial heading south of east, over open ocean) |
| pad Sun | 30.866 deg at start, morning |
| landing-site Sun | 7.4353 -> 31.8633 deg from start + 3 d to start + 5 d, rising, lit throughout |
| margins | at least 1 deg on every bound |

Reason: with the ascending crossing alone the three constraints have no solution in 2027-2030 at the resolved
pad. The descending crossing is equally coplanar, so the parking orbit lies in the Moon's plane and TLI needs
no plane change from any revolution, which is what keeps the mission flyable by hand. It gives a daylit pad
and a low Sun for relief at lunar touchdown, and keeps the constraint numbers and the search range. Written
into the sim-orbits and sim-world-pilot briefs, ARCHITECTURE section 1 row 28 and sim-design 15.3.
`padAzimuthDeg` stays 90: after tower clear the vessel rolls its ventral side to the launch azimuth.
Splashdown in daylight is a stated preference for sim-world-pilot where the trajectory leaves a choice (TEI
time, recovery zone); it is not a gate and nothing was computed for it.

**Moon bake acceptance (bake-moon-sky-1, -2).** Tycho is judged against `ldem_256`; de-shading is judged on
residual illumination. Brief sentences changed; `tools/bake/moon/verify.py` implements both and ends with
ALL CHECKS PASSED (56 s). No tile changed.

**Cloud shadow placement (render-core-1).** Declined as a shared-resource key; one CPU path. The
atmosphere-clouds brief names `setCloudShadowParams`.

**Earth bake gates.** bake-earth changed two of its own acceptance gates without a request (its hand-off,
section 8, items 2 and 3: the albedo seam gate compares border pairs with the interior pairs next to them;
the hillshade gate is the paired form regionally plus eight arid ranges within 6 % globally). Both are
reasoned from measurements and are accepted as documented there. The brief was not edited.

**sim-vessel's three open points** (its hand-off, "Decisions the lead still has to take"): accepted as built
for the baseline - SAS turn times met under thrust (coasting: 22 s lander stack, 74 s M-3 stack for 90 deg),
6.8 m landing-gear pad circle with 37.8 deg static tip-over, stage delays as in its section 4.
sim-world-pilot owns the part data in wave 2 and may enlarge the M-3 RCS thrusters if the coasting slew is too
slow for hand flying; that is its call, with the hand-off numbers as the starting point.

## 4. What was red and how it was fixed

| Check | Failure | Cause | Fix |
|---|---|---|---|
| `npm run typecheck` | `vitest.config.ts(19,5)`: `minWorkers` does not exist | Option removed in vitest 5 | Removed the line |
| vitest `src/core/fakes/fakeSim.test.ts` | pad latitude 18.987556, expected 19.1 | The Earth bake moved the pad to real terrain; the test pinned the nominal site | Test reads the site definition |
| vitest `realData.test.ts`, Moon texture | "L9 source ring start: NaN" | Moon level 9 lists no source tiles (terrain-core-4), so there is no ring to sample | Levels without source tiles are reported as such and not sampled for a ring |
| vitest `realData.test.ts`, Earth texture | "L9 source ring start: 0.795" (limit 0.8) | With land-only source tiles the rings of levels 8-12 share the coast: 0.1 level-9 tile inside the level-9 boundary the level-12 ring is nearly complete, so the ratio against the parent surface measured real coast against the model, not a step of level 9's ring | The ring-start assertion compares with the same surface without that level's ring (`sourceHeldSource`), within 5 % of 1; ratios against the parent are still printed |
| Playwright `audio-offline.spec.ts`, "unknown view mode ..." | tapDiff 2.1e-4 against a bound of 1e-5, once in two full runs; 3 of 3 passes alone | Chrome's offline renderer is bit-exact or off by about -71 dB per render, independently; the bound used the chase/chase pair alone as the noise floor and collapsed to -100 dB when that pair was exact | Floor of the bound set to twice the largest measured difference (-66 dB per tap, -70 dB master); the -60 dB audibility bound and the model-identity assertion are unchanged |

The first three were stale tests or config, the fourth a test whose premise the requested data change removed,
the fifth a flaky bound. No product code was changed to make a test pass.

## 5. Baseline results

Machine otherwise idle (the Earth bake agent finished at 16:33 local); every command through
`tools/dev/heavy.mjs`.

| Command | Result | Wall time |
|---|---|---|
| `npm run typecheck` | 0 errors (308 project files) | 0.7 s |
| `npx vitest run` | 58 files, 657 tests passed, 0 failed (before the fixes: 57 files, 647 tests, 3 failed) | 53 s |
| `npm run test:py` | 9 tests OK | 1.2 s |
| `node tools/dev/check-secrets.mjs` | OK: 3 secrets checked against 561 tracked, untracked and shipped files | 0.2 s |
| `npx playwright test --project=functional` | 110 passed, 0 failed (audio 16, flight-ui 49, map-view 19, render-core 23, shell 3) | 3 min 19 s |
| `python -I tools/bake/moon/verify.py` | ALL CHECKS PASSED | 56 s |

The functional suite was run twice: the first run had the one flaky audio failure of section 4 (109 passed),
the second, after the fix, is the row above. Not run, because not part of this job: the `perf` and `mission`
Playwright projects, `npm run test:mission` (no scenario or world exists yet), `npm run build`, the Earth and
sky verifiers (bake-earth reports 41 of 41 in its hand-off). Wave-1 perf numbers are still provisional;
core-support re-measures them (its Job 2).

## 6. What a wave-2 package must know that its brief does not say

- **Pad.** The resolved site is 18.987556 N, 155.603239 W, pad elevation 21.62 m
  (`data/defs/sites/ka-lae-lc1.location.json`); ARCHITECTURE row 1 still quotes the nominal 19.10 N 155.50 W.
  The shoreline is about 1 km east of the pad. Effective terrain level 12.00 at the pad and within 500 m of
  it, 11.67 at the shoreline.
- **Launch heading.** 99.4 deg (south of east), not the 81 deg that sim-design's examples use. The HUD's
  launch-window readout and the pilot's roll-to-azimuth step take it from the window maths, not from a
  constant.
- **Lunar target.** `recommendedTarget` in `data/defs/regions/moon-tranquility.json`: 0.661471 N,
  23.435999 E, -1907.80 m. Effective level 12.00 within 1 km; 11.79 at 1.5 km west (the 1,500 m mission disc
  comes within 357 m of the NAC strip edge); level 8 beyond 3 km east or west. `availableLevel` is 12 over the
  whole coverage, which is what the touchdown gate of ARCHITECTURE 18.1 tests.
- **No scenario file exists yet.** `data/defs/scenarios/` is empty until sim-world-pilot authors
  `lunar-direct`; FakeSim builds its own scenario from the first site in the library.
- **Earth source tiles follow the coast.** `sourceCoverage` of Earth levels 8-12 is an exact cover of the
  tiles that hold land (2 / 5 / 11 / 22 / 43 rectangles). Sea-only tiles are in `coverage` with a smooth
  ETOPO sea floor and keep the procedural relief of level 7. Manifest contentHash `5a9f0db7c755fdf8`.
- **Tile set listing.** `/tiles/index.json` exists; both `earth` and `moon` are baked, so a manifest fetch
  no longer 404s in any lab.
- **Audio attach range.** A chase camera further than 250 m from the vessel's bounding sphere still hears no
  structure-borne share (`propagation.attach.maxDistance` in `data/defs/audio/mix.json`). The range was
  shortened in wave 1 only because a ground camera received the share too; that can no longer happen, so
  core-support may widen it.
- **The offline audio renderer is not bit-reproducible** (about -71 dB per tap between two renders of the
  same scene, or exactly 0). Compare renders against a floor, never for equality.
- **`data/` holds 16 GB** of the 20 GB allowed. A wave-2 bake or cache has 4 GB.
- **Typecheck is cheap** (under a second for the whole project): run the full `npm run typecheck` after any
  contract-facing change instead of only the scoped one.
- **Gate timing.** With an idle machine the gate starts a job at once; the whole unit suite is 53 s and the
  whole functional browser suite 3.3 min, so a package can afford to run its own directory before every
  commit.

## 7. Not decided, not done

- Daylight at splashdown is a preference only; whether the 2029-09-24 start allows it is not known until
  sim-world-pilot has a return trajectory.
- The audio attach range (above) was left at 250 m.
- `MapView.mount` was not added; if the app shell needs to move the node panel after creation, that is a new
  request against `src/map`.
- The Earth bake's two changed gates were accepted on the hand-off's evidence; the lead did not re-run the
  Earth verifier (273 s, bake class).
