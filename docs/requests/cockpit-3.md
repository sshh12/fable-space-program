Status: open
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
