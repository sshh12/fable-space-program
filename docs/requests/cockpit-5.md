Status: resolved (commit 0dbebd3)
From: cockpit
Owner path: src/render/core/post/exposure.ts (`meterExposure`, interior branch); docs/RENDER_API.md section 13
Blocking: yes (visual QA wave 2, cockpit items 6, 9 and 12: "night is displayed brighter than noon", "everything inside the sun patch is one flat white"; both critics name interior metering as the cause and ask for a core change instead of a per-shot `ec`)

## Problem
Interior metering renders the cabin's log-average at mid-grey whatever its absolute level and ignores
highlights altogether (request cockpit-3 asked for exactly that; it over-corrected). Two consequences in
every seat view:

1. A cabin lit only by its floods and displays (log-mean around 5-20 cd/m^2) is displayed as bright as, or
   brighter than, the same cabin at noon on the pad: night reads as an evenly lit office. Real night-pass
   photographs are low-key (`out/qa/ref/cockpit-interiors/orion-a2-flyby-hansen.jpg`,
   `orion-a2-wiseman-window.jpg`).
2. A sun patch on a panel, or sunlit hardware next to a window, sits 5 or more stops above the metered
   level and clips to a flat white shape with no surface left in it. Real interior photographs with sun in
   frame are exposed between the two: the shaded cabin about 2.5 stops under mid-grey, the sunlit part
   over but still showing its surface (`aldrin-lm-interior.jpg`: window Y 0.7, shaded cabin Y 0.03;
   `apollo7-schirra-inflight.jpg`: cabin Y 0.03, face in window light 8x that).

## Evidence
`out/screens/cockpit/night-displays-floods.png`: frame mean 118/255, against 79/255 for
`pad-noon-forward-window.png` (measured by the QA merge, `out/qa/wave2/cockpit.md` item 6).
`out/screens/cockpit/leo-sun-patch-console.png` and `closeup-mfd.png`: inside the patch the 8.5 % panel is
223,223,221 and the 3 % black bezel 203-220, the panel beside it 6,9,12 (item 12).
Lab: `/labs/cockpit/?scene=night` and `/labs/cockpit/?scene=leo`, `window.__cockpit.debug().exposure`.
`meterExposure`, interior branch: `evHistogram = evMean - exposureCompensationCurve(evMean)` with
`evMean = ev100ForMidGrey(stats.logMean)` and no highlight term ("Highlight protection applies to exterior
metering").

## Requested change
In `meterExposure` for `kind === 'interior'` only (exterior and map metering must NOT change):

(a) A level-dependent key: a dim cabin is displayed dim.
    `keyEv = INTERIOR_NIGHT_KEY_EV * (1 - smooth(log2(4), log2(64), log2(stats.logMean)))`, with
    `INTERIOR_NIGHT_KEY_EV = 1.5`: the target EV is raised (darker) by 1.5 EV when the near log-mean is at
    or below 4 cd/m^2, by nothing from 64 cd/m^2 up, smoothly in between.

(b) Highlights of the cabin weigh in, bounded: the 99th percentile of the NEAR histogram is kept below
    `INTERIOR_HIGHLIGHT_CAP = 48` times mid-grey (exterior: 4), but the highlight term may raise the target
    by at most `INTERIOR_HIGHLIGHT_MAX_EV = 1.75` above the log-average target, so the cabin stays readable
    (the brief's "the cabin stays readable when the windows blow out"):
    `evBase = evMean - exposureCompensationCurve(evMean) + keyEv;`
    `evHigh = log2(stats.p99 / (INTERIOR_HIGHLIGHT_CAP * MID_GREY * EXPOSURE_K));`
    `evHistogram = min(max(evBase, evHigh), evBase + INTERIOR_HIGHLIGHT_MAX_EV);`
    (`histogramStats(m.histogramNear, m.sampleCount, Infinity)` already returns `p99`.)

Both constants exported next to the others so that the cockpit spec can name them. No API change; the
camera's `exposureCompensation` and `minEv100` keep working on top.

(c) Question, not a blocker: interior windows during entry clip every channel (white windows that light
    the cabin orange, item 9). If the tone curve has, or can get, a hue-preserving shoulder (desaturate
    toward white only in the last stop), say so in the resolution; otherwise the cockpit will keep the
    plasma's radiance within about 4 stops of the cabin by its own means.

Workaround in my paths until this is answered: none that is right (a per-shot `ec` in the lab is what the
critics rejected); the cockpit's screenshots are taken with the lab's default exposure meanwhile.

## Resolution
Implemented as asked, in `meterExposure` for `kind === 'interior'` only (commit 0dbebd3). Exterior and map
metering are byte-for-byte what they were.

- `INTERIOR_NIGHT_KEY_EV` = 1.5, between `INTERIOR_NIGHT_LOW` = 4 and `INTERIOR_NIGHT_HIGH` = 64 cd/m^2 of
  the near log-mean: `keyEv = 1.5 x (1 - smoothstep(log2 4, log2 64, log2 logMean))`.
- `INTERIOR_HIGHLIGHT_CAP` = 48, `INTERIOR_HIGHLIGHT_MAX_EV` = 1.75:
  `evBase = evMean - exposureCompensationCurve(evMean) + keyEv`,
  `evHigh = log2(p99 / (48 x 0.18 x 1.2))`, `evHistogram = min(max(evBase, evHigh), evBase + 1.75)`,
  with `p99` and `logMean` of the whole near histogram.
- All five constants are exported from `src/render/core/post/exposure.ts`. `exposureCompensation` and
  `minEv100` act on top as before. RENDER_API section 13 and the table of section 18 say the same.

What it gives (unit tests `tests/unit/render-core/exposureGovernor.test.ts`, "interior metering: night key
and bounded highlights"): a cabin at 1.5-6 cd/m^2 is displayed at 0.04-0.09 (mid-grey 0.18), less than half
the level of the same cabin at 120-330 cd/m^2; sunlit hardware 150 times the cabin (5 % of the near pixels)
is held at 48 x mid-grey and the cabin about a stop and a half under mid-grey; a sun patch 600 times the
cabin stops the camera down by the full 1.75 EV, the cabin stays above 0.03, and the patch still clips
(17,000 cd/m^2 against a cabin of 30 is nine stops: no single exposure holds both; the bound is yours).
Highlights up to 48 x mid-grey, and a handful of pixels under the 99th percentile, move nothing. The test of
request cockpit-3 now expects the bounded stop-down instead of "less than a stop".

(c) The tone curve. It is AgX: the shoulder already desaturates towards white instead of clipping channel
by channel. Measured with the CPU port of the pass (`displayLinear` in `src/render/core/post/tonemap.ts`,
new with request sky-lighting-3): an orange of 1.6 : 0.8 : 0.2 in scene-linear shows as 183, 142, 76 at one
stop over mid-grey, 211, 175, 110 at two, 233, 204, 146 at three, 246, 227, 180 at four, 253, 241, 209 at
five and 255, 249, 229 at six; from about 6.5 stops over mid-grey it is white. So a window keeps a hue
while its radiance is within about four stops of the level the cabin is metered at and is a pale cream one
or two stops further; beyond that it is white whatever the core does. Keeping the plasma within about four
stops of the cabin by your own means is the right plan; nothing in the curve was changed for it.

Not re-run by me: `tests/browser/cockpit` could not start while this was verified (your working tree was
mid-edit: "sunmap.ts does not provide an export named 'sunMapTransform'"). Run it when your tree compiles;
the core's own `tests/browser/render-core/exposure.spec.ts` passes.
