Status: resolved (commit 703b7c3)
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

## Resolution
Implemented as specified (commit 703b7c3), in the interior branch of `meterExposure` only.

- `far` = `histogram - histogramNear` bin by bin; `outsideFraction` = its lit pixels / `sampleCount`;
- `evOutside` = the exterior rule on `far` alone (arithmetic mean of its lit range to mid-grey with the
  compensation curve, `HIGHLIGHT_CAP` on its 99th percentile, and the exterior's bound under the sun,
  sunny 16 + 0.5 EV);
- `w = smoothstep(INTERIOR_WINDOW_FROM = 0.1, INTERIOR_WINDOW_FULL = 0.4, outsideFraction)` (exported);
- `target = evCabin + (max(evCabin, evOutside) - evCabin) x w`, with `evCabin` the interior target as it was
  (prior, log-average, night key, bounded highlights); exposure compensation, the clamp and `minEv100`
  apply after it.

`MeterResult` and `renderer.exposureInfo()` gained `outsideFraction`, `evOutside`, `outsideWeight`, so a
spec can print what the meter saw. Exterior and map metering are untouched, and an interior frame with less
than a tenth of far geometry meters exactly as before (unit tests in
`tests/unit/render-core/exposureGovernor.test.ts`, "interior metering: what fills the frame through the
windows"; RENDER_API section 13 and a row in section 18).

**What it does to your view, measured.** Your evidence view does NOT change, and the reason is in the view,
not in the rule. In `scene=lowOrbit&roll=180`, `sitAtWindowBelow()`, fov 55, the Earth is 5.2 % of the
frame, not a fifth: forced to EV 13 the picture shows two slivers of ocean and cloud, and most of each
white rectangle is the window's own reveal, lit by the Earth and blown out at the cabin's exposure (it is
cabin geometry, within 8 m). Share of the frame beyond 8 m from the seat, by field of view: 2.8 % at 70
degrees, 5.2 % at 55, 10.5 % at 40, 14.6 % at 28, 19.6 % at 18. By your own rule ("a small window in a
frame of cabin stays clipped") those frames stay metered on the cabin.

The Earth is exposed when the eye goes to the window. I added that to the lab:
`window.__integration.sitAtWindowBelow(lean)` moves the eye `lean` (0..0.95) of the way from the seat to
the window's centre, still aimed at it. At fov 55:

| lean | Earth, share of frame | weight | EV100 (sunny 16 = 15.08) | picture |
| --- | --- | --- | --- | --- |
| 0 | 5.2 % | 0 | 2.2 | cabin readable, windows white |
| 0.5 | 14.4 % | 0.06 | 3.6 | as from the seat |
| 0.7 | 25.0 % | 0.50 | 7.9 | in between: cabin dark, Earth still clipped with a hint of cloud |
| 0.85 | 54.9 % | 1 | 14.77 (= `evOutside`) | coast, sea and cloud exposed as from outside (mean 0.09 pre-exposed, nothing above white), the window frame a silhouette |

Pictures: `out/screens/integration/exposure-window-from-seat.png` and `exposure-window-leaning.png`, from
the new integration test "from the seat the windows blow out; leaning to the window the Earth fills the
frame and is exposed as from outside" (`tests/browser/integration/exposure.spec.ts`), which also checks
that the cabin is readable again back in the seat.

For your item 4, then: shoot `world-leo-earth-side-window` with the eye at the window (your `free` recipe,
or `sitAtWindowBelow(0.85)`), where the Earth fills half the frame. Two things you may want to weigh:

- Between a tenth and four tenths the result is a blend in EV, and a blend of two exposures nine stops
  apart shows neither subject well (the row at lean 0.7). If views in that band matter, ask for a narrower
  band (for example 0.2 to 0.3) rather than a lower one: lowering `INTERIOR_WINDOW_FROM` under the 5-8 % of
  the seat's forward windows would darken the cabin in its normal view.
- The reveal: at the cabin's exposure it is the larger part of the white shape. That is your material and
  your light (a darker reveal, or less Earth light on it, would make the window read as a window from the
  seat even while the Earth itself clips).

Not re-run by me: `tests/browser/cockpit` (your tree is mid-edit; two of your unit tests fail at the
moment for reasons of their own, `tests/unit/cockpit/geometry.test.ts` "no vertex outside the mould line"
and `light.test.ts` "cabin probe ... cube face"; neither touches the meter).
