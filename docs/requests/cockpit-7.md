Status: open
From: cockpit
Owner path: src/render/core/post/exposure.ts (`meterExposure`, interior branch); docs/RENDER_API.md section 13
Blocking: yes (visual QA wave 2, cockpit item 4, a blocker: "LEO with Earth filling a side window" must show the Earth, not a white rectangle; the critics ask that it be exposed "as a photographer would at the exposure the game uses", not by a per-shot `ec`)

## Problem
An interior view meters the cabin only (the near histogram, geometry within `INTERIOR_RANGE`). That is right
while the crew look at the console. When they turn to a window and the Earth or the Moon fills a good part
of the frame, the picture is still exposed for the dim cabin around the window and the subject they are
looking at, eight to ten stops brighter, is a flat white shape. A photographer (and the eye) exposes for
what fills the frame: the window frame goes to a dark silhouette and the Earth shows its clouds and its
limb (`out/qa/ref/spacecraft-hardware/lm-spider.jpg`, `out/qa/ref/cockpit-interiors/orion-a2-sill-moon.jpg`,
`apollo7-schirra-inflight.jpg` for the opposite case: a small window in a frame of cabin stays clipped).

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g leo-earth`
(the integration lab, `scene=lowOrbit&roll=180`, the seat view aimed with `sitAtWindowBelow()`, fov 55):
`out/screens/cockpit/world-leo-earth-side-window.png`: the two forward windows, about a fifth of the frame,
are 255,255,255 with a hint of cloud at their edges; the cabin around them is metered at 20-40/255.
`world-moon-horizon.png` (lunar surface through the side window, cabin unlit) happens to come out right:
there the cabin has almost no lit pixels, so the photometric prior decides and exposes for the sunlit ground.

## Requested change
In the interior branch of `meterExposure`, after the cabin's own target `evCabin` (as it is now, with the
night key and the bounded highlight term):

- `far` = the lit geometry BEYOND `INTERIOR_RANGE`: `m.histogram` minus `m.histogramNear` (bin by bin),
  `farFraction` = its lit pixels / `m.sampleCount`;
- `evOutside` = the exterior rule applied to `far` (arithmetic mean of its lit range to mid-grey with the
  compensation curve, the `HIGHLIGHT_CAP` on its p99), exactly what an exterior camera would do with it;
- `w = smooth(INTERIOR_WINDOW_FROM, INTERIOR_WINDOW_FULL, farFraction)` with `INTERIOR_WINDOW_FROM = 0.1`,
  `INTERIOR_WINDOW_FULL = 0.4` (exported);
- `target = evCabin + (max(evCabin, evOutside) - evCabin) * w`: the outside only ever stops the camera
  DOWN (a dark Earth at night in the window must not open the exposure of a lit cabin), and a window that is
  a small part of the frame changes nothing (the brief's "the cabin stays readable when the windows blow
  out" holds for the seat's normal view: the two forward windows are 5-8 % of that frame).

Must not change: exterior and map metering; the interior result when less than a tenth of the frame is
far geometry. Sky pixels (depth 0) are not in either histogram and stay out, as now.

Workaround meanwhile: none (the views are shot at the metered exposure and the Earth clips).
