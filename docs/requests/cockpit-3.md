Status: resolved (commit 113438e)
From: cockpit
Owner path: src/render/core/post/exposure.ts
Blocking: yes (cockpit acceptance: "the cabin stays readable when the windows blow out")

## Problem
Interior metering (`CameraState.kind === 'interior'`) takes the ARITHMETIC mean of the lit range of the
near histogram (geometry within 8 m). In a sunlit cabin the sun patches that come through the windows are
inside 8 m and 300 - 600 times brighter than the rest of the cabin (a patch on a panel is
rho E cos / pi = 10,000 - 20,000 cd/m^2, the inter-reflected cabin 20 - 60 cd/m^2), so a patch covering a
few per cent of the frame sets the exposure and the cabin goes nearly black. The research design asked for
the opposite (rendering-design 10.6: "meters the interior-weighted centre so the cabin is readable while
windows blow out"; 11.1: "average of the 50..92 percentile band"), and the windows themselves are already
excluded (their pixels are farther than 8 m).

## Evidence
`/labs/cockpit/?scene=leo` (sun through the right forward window onto the commander's panel, Earth in the
left side window): `window.__cockpit.debug().exposure` reports targetEv100 12.69 (evHistogram 12.69,
litFraction 0.27). At that exposure the cabin walls (about 30 cd/m^2) are 0.004 in the HDR target:
`out/screens/cockpit/leo-sun-patch-console.png`. The geometric mean of the same scene (5 % at 17,000,
95 % at 30 cd/m^2) is about 41 cd/m^2, i.e. EV 7.6, at which the cabin is mid-grey and the patch blows out,
as in photographs taken inside a spacecraft cabin.

## Requested change
For `kind === 'interior'` meter the near histogram with a robust statistic: the log-average (geometric
mean) of its lit range, or the mean of a percentile band that excludes the brightest pixels (for example
40 - 85 %). Keep the 8 m range, the floor and the compensation curve; keep exterior metering unchanged
(arithmetic mean and the highlight cap there are right for a lit object on black).
Must not change: exterior and map metering, adaptation speeds, the photometric prior.

## Resolution
Done (core-support, commit 113438e), with the log-average you proposed.

`src/render/core/post/exposure.ts`: for `kind === 'interior'` the near histogram (geometry within 8 m) is
metered by its LOG-AVERAGE (geometric mean) over every bin above the luminance floor, instead of the
arithmetic mean of the range within 10 EV of the brightest pixels. The 8 m range, the floor, the
compensation curve, the adaptation speeds and the photometric prior are unchanged; exterior and map
metering are unchanged (arithmetic mean, 10 EV lit range, highlight cap). `histogramStats(h, n, litRangeEv)`
gained the range argument and returns `logMean` next to `mean` and `p99`.

Why also the range: with the 10 EV rule a 17,000 cd/m^2 patch puts the lower bound at 17 cd/m^2 and cuts the
darker half of the cabin out of the statistic. Inside, everything above the floor counts.

Numbers (unit test "interior metering keeps the cabin readable when a sun patch falls into it"): 95 % of
the near pixels at 20-45 cd/m^2 and 5 % at 14,000-20,000: the patch raises the target by less than one
stop; a 30 cd/m^2 wall renders between 0.08 and 0.3 in the HDR target (it was 0.004 in your screenshot) and
the patch at more than 20 (blown out). For your scene (5 % at 17,000, 95 % at 30) the log-average is
41 cd/m^2: EV100 about 7.3 after the compensation curve. A uniformly lit cabin meters exactly as before.

What to expect in the lab: the adaptation towards the darker target runs at 0.8 EV/s, so after the camera
enters the cabin it takes a few seconds to settle. If the cabin then reads too bright or too dark for your
taste, use `CameraState.exposureCompensation` on the cockpit rig (EV, positive = brighter) rather than a
different statistic. RENDER_API section 13 describes the rule.

Re-run your "cabin stays readable when the windows blow out" spec; render-core's own suite is green
(27 browser specs, 51 unit tests).
