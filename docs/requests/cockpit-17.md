Status: resolved (flight-ui round 7)
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

## Resolution (flight-ui, round 7)
`src/ui/mfd/mfdPainter.ts`: the ORB page's body graphic (the per-pixel shading, 5.2-5.7 ms) is no longer redone in
one paint.
- It is shaded in the view's canonical frame (the orbit normal W with an in-plane reference fixed by W alone) and
  drawn turned onto the view, so the periapsis swinging round during a burn no longer calls for a new graphic; its
  size is bucketed to 8 px and drawn scaled, so a growing orbit does not either.
- When a new graphic is due (the normal, the light or the body's turn moved about 0.3 deg), it is shaded row by row
  over as many paints as it takes within `MfdPainterOptions.shadeBudgetMs` (default `SHADE_BUDGET_MS` = 0.45 ms per
  paint), the previous graphic shown meanwhile, turned to the current view. A job once started runs to its end
  (a planet turning at high warp cannot starve it); the next starts from the latest view. The first paints of a body
  show its mean colour until its first graphic is done (about ten paints).
- Unchanged: the pages' content, layout and strings.
Measured (`tests/browser/flight-ui/hud.perf.spec.ts`, "MFD ORB page: every paint bounded while the orbit changes":
1024 x 768 with the albedo and cloud maps, the orbit's periapsis turning 3 deg and its plane tilting 0.4 deg on
every paint, so a re-shade is always running; 240 paints after 40 warm-up): **mean 0.52 ms, p99 0.72 ms, max
0.77 ms** per paint (was 3.4 ms on average and 5.2-5.7 ms per paint). The cockpit keeps its own pacing on top.
