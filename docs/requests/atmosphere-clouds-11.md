Status: resolved (c9656d7: at twilight the sky counts in the meter of an exterior view, by how little of the sun still arrives directly; where the meter settles pad-sunset has a mean luma of 101 and pad-anti-twilight of 98 (the request's table, not settled: 196 and 153); the frame at +2.3 degrees is metered as before)
From: atmosphere-clouds
Owner path: src/render/core/post/exposure.ts (`meterExposure`: what the target is once the sun's disc has gone under the horizon)
Blocking: no   (PROMPT: "sunsets"; the acceptance pictures of twilight from the pad are washed out)

Follows `atmosphere-clouds-10`, part 2 ("count the sky"; its resolution says: re-open with the frame that is
still wrong after part 1). This is that frame, at the other end: too bright, not too dark.

## Problem
While the sun stands above the horizon the exposure of a view into the sunset is held by the rules under the
sun, and the picture is a sunset: a glow, a darker sky above it, dark ground. The moment the disc is under
the horizon those rules let go, the histogram (geometry only) exposes the ground, which is lit by the sky
alone, to mid-grey, and the sky above it, which is not metered and is an order of magnitude brighter than
the ground it lights, goes to white. In a flight at dusk the sky would bloom to white as the sun sets.

## Evidence
Atmosphere lab, the pad, 30 m up, field of view 75 deg, camera pitched 10 deg up, clear sky, no exposure
override (`tests/browser/atmosphere/screens.spec.ts`, "pad, clear sky"; pictures in `out/screens/atmosphere/`;
8-bit values of the picture, 2026-11-12):

| picture | sun | view | sky at the top | sky near the horizon | ground | mean luma |
|---|---|---|---|---|---|---|
| `pad-sunset-minus-10min.png` | +2.3 deg | into the sun | 64, 73, 91 | 141, 130, 94 | 37, 18, 4 | 72.6 |
| `pad-sunset.png` | -0.3 deg | into the sun | 231, 234, 242 | 253, 249, 241 | 118, 112, 116 | 196.4 |
| `pad-anti-twilight.png` | -2.5 deg | away from the sun | 203, 203, 225 | 201, 197, 210 | 60, 55, 66 | 152.7 |

Between the first two the sun moved 2.6 degrees and the sky lost perhaps a stop; the picture gained more than
three. In round 1 (before the exposure rules of this week) `pad-anti-twilight.png` measured 109, 110, 142 at the
top (the round-1 critique, item 17, quotes it).

EXPOSURE_TABLE

To see it: `/labs/atmosphere/?hud=0&clouds=0&fov=75&view=18.987556,-155.603239,30,270,10&sun=270,-0.3` against
`...&sun=270,2.3`.

## Requested change
The sky counts in the meter when the frame shows it (part 2 of `atmosphere-clouds-10`): the histogram's section
of sky pixels (`MeterInput.histogramSky`) or the mean of `'atmosphere.skyViewLut'` over the view. At the least:
no step in the exposure target as the sun's disc crosses the horizon (the sky's luminance has none), and a
twilight sky that fills half the frame not above the shoulder of the tone curve.

Must not change: the daylight frames (pad, ascent, orbit), the dawn frame of `atmosphere-clouds-10`
(`out/screens/atmosphere/integrated-app-drogues.png` is a good picture now), the night floor.

## Resolution (shared-code maintainer, c9656d7, 2026-11-12)

The sky counts once the direct sun is nearly gone (`meterExposure`, `twilightSkyWeight` in
`src/render/core/post/exposure.ts`; RENDER_API section 13; NOTICE-core-6).

**The rule.** Inside an atmosphere, an exterior or map view is metered twice: as before, and with the sky's
pixels (`histogramSky`) counted as lit ones and the rules under the sun let go; the two targets are mixed
by a weight. The weight is how little of the sun's light still arrives directly (the air's transmittance
towards it x the visible share of its disc: 1 from 0.5 % down, 0 from 5 % up) x the camera's depth in the
air x twilight (full to 6 degrees under the horizon, none from 12). What is brighter than the sky's 90th
percentile (the glow about the sun) counts at that level, so the frame is not exposed for the aureole.

**Why by the sun's light and not by its disc** (my first version, and the reading of your request "the
moment the disc is under the horizon those rules let go"): the rules under the sun are scaled by the sun's
light at the camera (request atmosphere-clouds-10), and that dies before the disc sets: through the game's
air 0.076 of it arrives at 2.3 degrees, 0.023 at 1 degree, 0.003 on the horizon, while the sky loses a
stop. With the game's air the weight is 0 down to 1.6 degrees, 0.64 at 1 degree, 1 from 0.3 degrees: it
is 1 before the disc reaches the horizon, so the target has no step there. From 7 km up 0.16 of the sun
still arrives on the horizon and the sky comes in as the disc sets.

**Your frames** (your own test, `tests/browser/atmosphere/screens.spec.ts`, "pad, clear sky", passes;
2026-11-12 19:20; mean luma of the picture and the exposure the lab logged):

| picture | sun | the rule's weight | mean luma in your table | now | EV100 now |
|---|---|---|---|---|---|
| `pad-noon.png` | high | 0 | | 128.2 | 13.40 |
| `pad-sunset-minus-10min.png` | +2.3 deg | 0 | 72.6 | 114.7 | 11.40 |
| `pad-sunset.png` | -0.3 deg | 1 | 196.4 | 100.8 | 10.15 |
| `pad-anti-twilight.png` | -2.5 deg | 1 | 152.7 | 98.1 | 7.50 |

The three twilight pictures looked at: `pad-sunset.png` is a sunset (a glow on the horizon, a darker sky
above it, the islands in silhouette on dark ground), `pad-anti-twilight.png` the belt of Venus over the
Earth's shadow, lavender above, dark ground. From +2.3 degrees to -2.5 the mean falls from 115 to 98:
no step.

Two things about these numbers that are not the rule's doing. Your test (the change in your working tree)
now takes each picture where the meter has settled; the lines it logged in this run: noon EV100 14.34 after
40 frames, 13.40 settled; +2.3 degrees 12.58, 11.40; -0.3 degrees 10.87, 10.15; -2.5 degrees 9.08, 7.50. So
the frame at +2.3 degrees is brighter than in your table (115 against 73) because it used to be taken 1.2
stops over its target, on the way down from noon; the rule's weight there is 0 (0.076 of the sun arrives)
and its target is the one of before. And for the same reason I cannot split the gain of the other two
frames between the rule and the settling: by your test's comment the table's twilight frames were taken
stops away from where they settle, and I did not render these frames settled with the rule off. What the unit tests hold is the target itself (below). If 115
is too bright for the frame at +2.3 degrees, that is the rule under the sun (atmosphere-clouds-10), and a
frame for a new request.

**Unchanged, by the unit tests** (`tests/unit/render-core/exposureGovernor.test.ts`, "exterior metering at
twilight", 4): the sun 2 degrees up and more, the dawn frame of atmosphere-clouds-10 (7 km, 0.24 of the
sun: weight 0), the night (12 degrees under and more: stars and airglow in the sky histogram change
nothing), a view from above the air (the glowing limb in orbital night is sky too, and is not counted), an
interior view. Also metered with the sky: a sun hidden by a mountain or the Moon while it stands high.

Not built: the mean of `'atmosphere.skyViewLut'`; the histogram's sky section does the same from the frame.
