Status: open
From: core-support (shared-code maintainer; the lead's item of 2026-11-17 on the meter: "the exposure falling to EV 7.7 at peak g during entry, the capsule burnt out to white inside a glow as wide as the frame")
Owner path: src/render/vfx/feature.ts (`emissiveHint`: the `daylight` gate), src/render/vfx/plasma.ts (the sheath's hint)
Blocking: yes   (the mission's entry pictures: at the peak of g the meter is told of no emitter while the sheath still glows)

## Problem
The exposure meter meters lit geometry; what a volume emits reaches it only as the hint the vfx gives
(`CoreApi.addEmissiveHint`). During a night-side entry the sheath's hint is what holds the exposure (a
quarter of the frame, 5e4 to 3.6e5 cd/m2: the target stands at the scale's top, EV100 16.5, through the
peak of heating). A few seconds later the hint is gone from one frame to the next, while the sheath is
still drawn at full strength, and the meter exposes for the hull alone: the capsule and the glow burn out
to white.

Why it goes: `emissiveHint` returns without a hint once `daylight(frame)` is 1 (and scales the coverage by
`1 - day` before that), "a flame in daylight must not stop the camera down". At 57 km the sun comes over
the limb: its disc is visible from that height while it stands 7 to 8 degrees under the horizon of the
ground below, through a long path of air (0.02 to 0.03 of its light: 2,300 to 3,800 lux at the camera).
That counts as daylight for the gate; for the picture it is a dawn glimmer beside a sheath a hundred times
brighter than anything it lights.

## Evidence
The real app, `/?scenario=qa-entry&pilot=1&view=chase&scale=1&governor=off&mute=1&capture=0&hud=0`, the
meter's inputs recorded every 0.7 s with `CoreRenderer.meterInput()` (tests/browser/integration/
curve-ab.spec.ts, 2026-11-17; out/screens/core-support/curve-ab/meter/10-entry.json; replayed with
out/core-support/core_support_meter_replay.ts):

| altitude | sun's disc visible | hints the meter was given | target EV100 |
|---|---|---|---|
| 61.0 km (just before the peak of heating) | 0 | 3.6e5 cd/m2 over 23.8 % | 16.5 (the scale's top) |
| 58.3 km | 0 | 2.1e5 over 23.3 % (and two thruster pulses) | 16.5 |
| 57.9 km | 0 | 1.6e5 over 24.5 % | 16.5 |
| 57.2 km | 0.46 (56.7 km) | none | 9.4 |
| 55.0 km | 1.0, 0.018 of its light | none | 13.2 |
| 54.8 km, the peak of g | 1.0, 0.029 of its light | none | 12.3 (7.7 in the mission flights of 2026-11-12 and -17, where the stop fell a moment earlier) |

Pictures: `out/screens/mission/14-entry-interface-peak-g-chase.png` (both flights),
`out/screens/core-support/curve-ab/10-entry.png` (peak of heating and peak of g, both looks).

## Requested change
The sheath's hint is given whatever the sun (and so are the hints of everything else that is brighter than
what that sun lights): leave it to the meter to weigh an emitter against the sun. The meter's rules do
that: under the sun an emitter over sunlit white raises the target by a quarter stop at most (request
vfx-8, unchanged with look 1), and with the render core's look 2 (the switch of requests ocean-10 and
ocean-13, RENDER_API section 13) an emitter that fills a tenth to a fifth of the frame is the scene whatever
the sun. Replayed on the recorded frame at the peak of g with a hint of 5e4 cd/m2 over 23.5 % of the frame:
look 1 gives 13.2 (held at that weak sun's sunny 16: the sheath still clips, but four stops less than at
9.4), look 2 gives 16.5 (exposed for the sheath, as in the night).

If a flame at noon must stay unhinted for another reason than the meter (its own cap, `flameCap`), keep
that, but gate by what the sun does to the picture (its illuminance at the camera against the emitter's
luminance), not by a lux threshold that a sun on the limb passes.

Must not change: what the hints say (luminance, extent, `clipStops`), the lift-off by day.

## How to see it
`CURVE_AB=flights CURVE_AB_LOOK=1` (or 2) with `tests/browser/integration/curve-ab.spec.ts` flies the entry
to both peaks in about a minute and a half and records the meter's inputs; `npx tsx
out/core-support/core_support_meter_replay.ts` prints the table above.
