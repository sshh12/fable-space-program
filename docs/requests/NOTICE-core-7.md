Status: notice
From: core-support (shared-code maintainer), 2026-11-24, commits ff3b69e, c01ecc6, 2d3ee9d, 3883d51, ce14791 (the look switch), 0a1db8b, 4df6664 (read-outs), 8b93e39, affe39a (the scrim), 89cb2f2 (the perf recorder)
To: every package that takes pictures or holds levels through the display curve; the UI package (the scrim)

## As it stood until the flip (2026-11-24, before 1d91c88): nothing moved
(Kept as written. The section "The flip" below is what holds now.)
- **The render core has one switch, `RendererOptions.look`, and it is OFF (look 1).** With it off the tonemap
  pass compiles the text it always compiled and the meter evaluates none of the new rules: the lead's 33
  reference images compare at 0 pixels on the tree with the switch in it. Nobody has to do anything.
- **What the switch holds** (RENDER_API section 13.1): look 2 = the camera curve above mid-grey (sunlit white
  paper at sunny 16 from 193 to 241 of 255, white reached at 2.5 times sunlit white, shadows and mid-grey
  where they are) and the meter's bounds for exterior views (the sky's bulk held at 0.7 pre-exposed; under
  a low sun and for small emitters a small bright subject no longer sets the exposure; an emitter that
  fills the frame is the scene; the scale ends at EV100 18). It is built for the lead's decision on request
  ocean-10. It is NOT flipped, and no package re-states a level test for it until the lead orders that.
- **To look at your own scenes under it**: add `corelook=2` to a page's address (any lab, the app), or run a
  suite with `VITE_CORE_LOOK=2` in the environment. The A/B the lead decides from:
  `out/screens/core-support/curve-ab/` (thirteen contact sheets, `tests/browser/integration/curve-ab.spec.ts`).
- **What will move when it is flipped** (so that you can plan): every daylight picture's highlights (whites
  from about 200 to 250 of 255, cloud tops, frost, steam, glints); every level-holding test that reads a
  display level above mid-grey; the cabin's windows and sun patches (they clip: the gain on the outside of
  a cabin was set for the present curve); dawn, dusk and overcast frames with sky in them (the meter holds
  the sky, the ground and the sea are darker). Nothing below one stop under mid-grey moves; night scenes
  move only in their brightest pixels.

## Additive, in force now
- `CoreRenderer.meterInput()`: a copy of what the meter evaluated in the last frame, for replaying its rules
  outside the page. `coredebug=1` in a page's address publishes `globalThis.__core` (the renderer, the look,
  `displayLevel(preExposed)`) for measurement specs.
- **The UI scrim** (`'ui.scrimRects'`; RENDER_API 19.3): with no rectangle the tonemap pass is the pass
  before the scrim; a rectangle costs by its area (drawn inside scissors). Whoever publishes rectangles
  writes the buffer with `writeScrimRects(device, buffer, rects)` (exported by the core), always and before
  `render`: a plain `queue.writeBuffer` still gives the right picture at the old flat cost (0.073 ms), and
  mixing the two on one buffer leaves stale scissors.
- `Perf` (the frame-time recorder) takes an optional clock as its third constructor argument.

## The flip (2026-11-24, commit 1d91c88): look 2 is the default; what is expected to be red, and why

By the lead's decision in docs/requests/ocean-10.md the render core's default is look 2 since 1d91c88.
Look 1 is still there for one round (`corelook=1` in a page's address, `RendererOptions.look`,
`VITE_CORE_LOOK=1` for a whole run): use it to tell "my change" from "the new look" while you re-state.
My own suites are re-stated and green (render-core unit 339 of 339 with camera and the boundary test;
render-core browser; the lab's exposure, contact, exact and shadows specs). **I ran nobody else's suite
under look 2.** The list below is what I expect from my A/B (`out/screens/core-support/curve-ab/`) and from
reading which specs hold display levels; a spec may also pass.

Until the lead's records agent has re-recorded them:
- `tests/browser/shell/baselines.record.spec.ts` (the image gate, and every `expectBaseline` in a package's
  spec): every checkpoint with anything brighter than a stop under mid-grey differs from its reference.
  Night checkpoints differ in their brightest pixels only.
- the budget baseline: the tonemap and exposure line is 0.055 ms (0.048 with look 1), nothing else moved.

Each owner re-states in its next round; what I expect, by package:
- **cockpit** (`cockpit/world.spec.ts`, `cockpit/app.spec.ts`): pane medians and frame levels of the seat
  views. The cabin's metering and its gain on the outside (`INTERIOR_FAR_STOPS`, the highlight cap) are
  unchanged and were set for the old curve: the sun patch is white (5 % patch: under 246 before, 255 now)
  and erases the display under it; cloud tops in the window stand at 254 and up (under 225 before).
- **vfx** (`vfx/effects.spec.ts`, `vfx/lunar.spec.ts`, the lift-off and reentry matrices): whatever was
  placed several stops over white for the old long shoulder clips: steam's brightest lobes (6 % of the
  lift-off frame white, 0 before), the sheath (at the peak of heating the target is 18.0 where it was
  16.5: the scale's top moved), flames and thruster pulses (a pulse no longer stops the camera down: the
  target stays within 2 EV, so the pulse itself is far over white), the canopies at dawn (orange gores go
  yellow). And request `core-8`: the sheath's hint at the peak of g.
- **ocean** (`ocean/warp-splash.spec.ts`, `ocean/integrated.spec.ts`, `ocean/foam.spec.ts`,
  `ocean/handover.spec.ts`): at dawn and under overcast the meter holds the sky and the sea is darker: the
  dawn splashdown stands at EV100 11.6 throughout (8.4 to 12.5 before) with the sea's median at Y 0.03 to
  0.04 (the spec's KNOWN line should go; a bound on the sea's level set for 0.127 will fail); under
  overcast 11.7 with the sea at Y 0.11 (9.9, 0.32 before). Foam and glint levels above mid-grey are higher.
- **atmosphere** (`atmosphere/screens.spec.ts`, `sky.spec.ts`, `integrated.spec.ts`, `clouds.spec.ts`,
  `cloudlight.spec.ts`, `explore.spec.ts`): mean-luma and clipped-share bounds of the pad pictures. Noon:
  the same exposure, brighter highlights (p95 Y 0.31 -> 0.36 in my pad frame). Sunset, twilight and
  overcast frames: the sky's 90th percentile is held at 0.7 pre-exposed, so frames that were exposed for
  the ground are darker on the ground and their sky is no longer near white. Cloud tops are white.
- **sky-lighting** (`sky/flare.spec.ts`, `stars.spec.ts`, `sun.spec.ts`, `views.spec.ts`, `impostor.spec.ts`,
  `probe.spec.ts`, `integration.spec.ts`): display levels of anything over mid-grey (the disc, flare
  profiles stated in display levels, a body's lit face); what is under a stop below mid-grey is unchanged
  (star fields, the Milky Way).
- **vehicle** (`vehicle/screens.spec.ts`, `adhoc.spec.ts`): levels on white hardware and frost (the frosted
  barrel's p95 Y 0.47 -> 0.72; sunlit white 185-205 -> 225-253 of 255), ratios between frosted and bare
  paint measured in display levels.
- **terrain** (`terrain/integrated.spec.ts`, `integrity.spec.ts`, `pops.spec.ts`, `views.spec.ts`,
  `source.spec.ts`): bounds stated in display levels on sunlit ground (regolith p95 Y 0.40 -> 0.52), and
  pop or seam thresholds in levels: the same scene step is up to twice as many levels above mid-grey.
- **map-view** (`map-view/real-planet.spec.ts`): cloud tops and the lit disc in display levels.
- **app, mission, flight-ui** (`app/app.spec.ts`, `mission/lunar-direct.spec.ts`, `flight-ui/screens.spec.ts`):
  picture statistics with bounds near white, and exposure values asserted at the entry and the splashdown
  (the entry's peak of heating 18.0, was 16.5; the dawn splashdown 11.6 throughout).
- Perf specs are not expected to move.

## Resolution
Notice only.
