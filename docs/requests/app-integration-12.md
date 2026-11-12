Status: open (cockpit half, items 1 and 2: done in cockpit round 4, see "Resolution: cockpit"; item 3 is flight-ui's, also filed as cockpit-17)
From: app-integration-v1
Owner path: src/render/cockpit (feature.ts `compute`, displays.ts; cockpit), src/ui/mfd/mfdPainter.ts (the page painter; flight-ui)
Blocking: yes   (ARCHITECTURE 17: main-thread frame p99 <= 6 ms; this is the whole miss during engine burns away from terrain)

## Problem
The cockpit feature paints the three cockpit displays (Canvas 2D, 1024 x 768, 15 Hz each), uploads them and
renders its sun map, ambient pass and cabin probe in EVERY view, also in the chase view from 140 m where the
displays cover less than a pixel. That costs 0.6-0.9 ms of main thread in every external frame, and while an
engine burns one display paint in about six takes 5.2-5.7 ms: `cockpit.compute` alone is then the difference
between a 2.5 ms frame and a 7 ms frame. This is the unattributed "burn-time" miss of the browser mission
(loi:burn 6.7, lunarCircularise 7.3-7.5, deorbit:burn 6.9, loi:tail 18.8 ms p99 against the 6 ms line).

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/app/app.perf.spec.ts --project=perf`,
test "lunar orbit: coast, engine start, burn, cut-off" (`/?scenario=qa-lunar-orbit&scale=1&governor=off&mute=1`,
2560 x 1440, chase view, nothing else on the GPU; the app times every feature hook in every frame,
`window.__app.cpu().features` / `cpuSlowest()` / `takeCpuTrace()`; numbers in `out/app/perf-burn.json`):

| Lunar orbit, chase view (displays: flight / orbit / systems) | main thread p50 / p99 | `cockpit` hooks p50 / p99 | everything else p99 |
|---|---|---|---|
| coast | 1.53 / 2.40 ms | 0.55 / 0.80 | terrain 0.46, core 0.34, vehicle 0.23 |
| burning (descent engine, 200 kN) | 1.75 / **7.05** | 0.60 / **5.56** | terrain 0.58, core 0.37, vehicle 0.25, vfx 0.14 |
| burning, the centre display cycled off the orbit page (flight / systems / systems) | 1.58 / 2.47 | 0.55 / 0.82 | terrain 0.46, core 0.34 |
| after the cut-off | 1.49 / 2.35 | 0.53 / 0.79 | terrain 0.68, core 0.34 |

(Second run, 23:17; the first run at 22:49 gave 1.60 / 2.51, 1.70 / 6.94 and 1.71 / 2.76 for coast, burn and after.)

- Trace across the burn (909 frames, thrust on for 407 of them): 63 frames of 6 ms or more, every one of them
  during the burn and every one with `cockpit.compute` 5.2-5.7 ms (e.g. frame 1394: 8.06 ms = render 6.93 of which
  cockpit 5.69, core 0.39, terrain 0.34; frame 1378: 7.69 ms, cockpit 5.48). None before the engine start, none
  after the cut-off. Not the render core's attribution frame (0 of the 63 on `frame % 64 == 32`).
- The slowest frames of the steady burn window are the same picture: `cockpit.compute 5.21-5.39`, next
  `terrain.prepare 0.3-0.7`, `cockpit.prepare 0.11-0.16`.
- On the pad and at lift-off (same spec, "frame time at the pad and in the climb"): `cockpit.compute` 0.6-1.1 ms in
  every chase frame (cockpit hooks p50 / p99: pad 0.66 / 0.96, climb 0.71 / 1.18 at 1440p), and one frame at the
  moment of lift-off (the snapshot goes from one vessel to two) in which the cockpit takes 16-26 ms: the slowest
  frame of the whole lift-off in all four traces. 1440p: 29.96 ms = cockpit 16.03 + sim 5.85 + terrain 4.26
  (second run), 28.05 ms with cockpit 10.59 (first run); 720p: 31.91 ms with cockpit 25.55 (second run), 34.01 ms
  with cockpit 24.66 (first run: a frame over the 33 ms line). The first run also had single cockpit frames of
  6.2 ms on the pad and 10.6 ms 0.8 s before lift-off.
- **Measured split** (`window.__app.mfdPaintStats()`, the cockpit's own `MfdDisplays.stats`; the cabin is drawn
  at `lod1`, eye outside): 0.75 display paints per frame in every state (three displays at 15 Hz). Mean per
  paint: coast Canvas 2D 0.44 ms, upload 0.20, mips 0.02; burning 1.28 / 0.20 / 0.02; burning without a display
  on the orbit page 0.22 / 0.20 / 0.02. So the upload and the mips are constant and small, and the whole burn
  cost is the Canvas 2D painting of the ORB page while the orbit changes (about 3.4 ms on average and 5.2-5.7 ms
  in the worst case for that page, against 0.2 ms for the flight and systems pages).

## Requested change
cockpit (`src/render/cockpit`):
1. Do not paint, upload or mip a display whose picture cannot be told from its previous one in this view: when the
   cabin is drawn at `lod1` / `lod2` (the eye outside, the display under a few pixels) repaint at most about once
   a second, or not at all below a pixel size; likewise skip the sun map, the ambient pass and the cabin probe
   when the cabin's projected size makes them invisible (or run them at a low rate). Budget asked for:
   `cockpit` hooks <= 0.15 ms p99 in an external view beyond a few metres. Inside (`lod0`) nothing changes.
2. Whatever the feature does in the frame the vessel list changes (lift-off: 16-26 ms) and on a page change or
   first paint must be spread: at most one display painted per frame, as the 15 Hz stagger already does for the
   regular paints, and no rebuild of cabin resources for a vessel that only gained a sibling.
flight-ui (`src/ui/mfd/mfdPainter.ts`):
3. A page paint must be bounded (about 1 ms). The ORB page costs 3.4 ms on average and up to 5.7 ms per paint
   while the orbit changes (a burn), against 0.2-0.4 ms otherwise ("Measured split"): whatever it recomputes when
   the conic changes (the per-pixel body graphic is the first suspect) has to be cached and re-used while only
   the conic and the numbers change, or computed off the main thread.

Must not change: the picture of the displays in the cockpit view; the cabin seen through the glazing from close
by (request cockpit-8); `'ui.mfd'`.

## Resolution: cockpit (items 1 and 2; round 4)
`src/render/cockpit/displays.ts`, `feature.ts` `compute`:
1. No display is painted, uploaded or mipped unless a camera can see the screens: only while the cabin is drawn at
   its full detail level (`lod0`: the eye inside, or within 6-7 m outside) and the view is not the map. In the
   chase view beyond that the pages are not touched; they are marked dirty and are current again within three
   frames of the cabin coming back into view (one per frame). At a far detail level the cabin's sun map, ambient
   pass and probe run every 8th frame (`FAR_LIGHT_INTERVAL`). What is left of `cockpit.compute` in an external
   view is the call itself.
2. At most ONE display is painted per frame, dirty ones included (a page change, the first paint, the return
   into view): there is no frame with two or three paints any more. Nothing in the cockpit is rebuilt when the
   vessel list changes: the feature picks the vessel by id and re-uses the layout's GPU model (the bind groups
   depend only on shared-resource versions). If a slow frame remains at lift-off in the cockpit view it is the
   first paint of a page whose content changed (the painter: item 3 / cockpit-17).
Also: a display whose page is dear to paint is painted less often (its smoothed cost keeps all displays within
0.36 ms per frame on average); with the ORB page at 5 ms that is about one paint a second during a burn. Inside
(`lod0`) the picture is unchanged for pages that paint in about half a millisecond (15 Hz).
