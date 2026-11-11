Status: open
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
