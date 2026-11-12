Status: open
From: cockpit
Owner path: src/ui/mfd/mfdPainter.ts (the MFD page painter; flight-ui)
Blocking: yes (the cockpit's CPU line "display paint + upload + mips under 0.4 ms per frame on average" and the app's main-thread p99 line while a burn runs in the cockpit view; item 3 of request app-integration-12 states the same need)

## Problem
The cockpit paints one display per frame at most, 15 Hz each. Its CPU line is 0.4 ms per frame on average;
measured 0.42, 0.54 and 0.44 ms in three runs of `tests/browser/cockpit/cockpit.perf.spec.ts` with the default
pages (flight, orbit, systems): about 0.56 ms per paint, of which the cockpit's own share (canvas to texture,
mips) is about 0.1 ms. And request app-integration-12 measured the ORB page at 3.4 ms on average and 5.2-5.7 ms
per paint while the orbit changes (a burn): one such paint is a main-thread frame over the 6 ms p99 line by
itself, however the cockpit schedules it.

## Evidence
- `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/cockpit.perf.spec.ts --project=perf`:
  "CPU (ms/frame): display paint+upload+mips 0.42 ... 0.54 (0.75 paints/frame)".
- docs/requests/app-integration-12.md, "Measured split": ORB 0.2-0.4 ms steady, 3.4 ms average and up to 5.7 ms
  per paint while the conic changes.

## Requested change
A page paint bounded at about 0.3 ms typical and 1 ms worst case at 1024 x 768: cache what does not change
between two paints (the page chrome, the tabs, static scales and labels, the per-pixel body graphic of the ORB
page) in an offscreen layer and redraw only the numbers, the conic and the moving marks; or expose
`paint(ctx, w, h, page, snapshot, defs, { budgetMs })` / an incremental `paintStep` the cockpit can spread over
frames. Must not change: the pages' content and layout (the cockpit's bezel keys sit over the page tabs), the
strings (a cockpit test compares them with the HUD's).

What the cockpit does meanwhile (round 4, `src/render/cockpit/displays.ts`): no display is painted while no camera
can see the screens (chase view, map); never two paints in one frame; a page whose smoothed paint cost is high
is painted less often, so that all displays together stay within 21.6 ms of main-thread time per second (0.36 ms
per frame): a 0.5 ms page keeps its 15 Hz, the ORB page during a burn drops to about one paint a second. That
keeps the average; a single 5 ms paint is still a 5 ms frame.
