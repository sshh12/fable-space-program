Status: notice
From: core-support (shared-code maintainer), 2026-11-24, commits ff3b69e, c01ecc6, 2d3ee9d, 3883d51, ce14791 (the look switch), 0a1db8b, 4df6664 (read-outs), 8b93e39, affe39a (the scrim), 89cb2f2 (the perf recorder)
To: every package that takes pictures or holds levels through the display curve; the UI package (the scrim)

## Nothing moves today
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

## Resolution
Notice only.
