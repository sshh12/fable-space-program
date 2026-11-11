Status: open
From: sky-lighting
Owner path: src/render/core/post/tonemap.ts (`TOE_START_STOPS`, `TOE_FULL_STOPS`: the join of AgX to the linear toe)
Blocking: yes   (major finding 1 of both round-1 critics of the sky, `out/qa/wave2/sky-lighting.r1.photo.json` and `.r1.artifact.json`, and their only item "still open" from round 0: it cannot be closed inside `src/render/sky`)

## Problem
The display transform joins AgX (+ the punchy look) to the linear toe of request sky-lighting-3 over ONE stop
(-3 to -4 stops under mid-grey). AgX's log-log slope there is 1.7 to 1.9 and the toe's is 1.0, so the display
contrast of every smooth gradient falls by 40 % within half a stop, always at the same display level
(21 -> 16.5 of 255). A radial falloff that crosses that level gets a traceable edge: both critics measured it
on the sun's glare ("the gradient breaks at 17-19/255 in every view, not at the same radius"; ring medians
38 / 32 / 26 / 21 / 18 / 17 / 15 / 13 at 160-230 px: 5-6 levels per 10 px, then 1.3-2), and they point out
that terminators and twilight skies will show the same contour. The sun's glare is the sky package's, the
edge is not: the HDR profile is smooth.

## Evidence
- `out/screens/sky/flare-deep-space-ev14.png`, `flare-display-check-ev14.png`, `perf-1440p-leo-horizon.png`:
  a grey ball with an edge at 17-19/255; `flare-deep-space-ev12.png` (the same profile two stops up) has none.
- `displayLinear()` of a grey, log-log slope (display-linear against scene-linear) at half-stop steps from
  +1 to -8 stops under mid-grey:
  now `0.72 0.82 0.92 1.02 1.14 1.26 1.38 1.51 1.76 | 1.12 1.00 1.00 ...` (largest change 0.50 per quarter stop,
  between -3.25 and -3.5 stops);
  with the blend from -1 to -6 stops `0.72 0.82 0.92 1.02 1.16 1.34 1.48 1.55 1.50 1.32 1.09 0.91 0.86 0.91 1.00 ...`
  (largest change 0.12 per quarter stop), monotonic, and no grey moves by more than 1.8/255 against today's
  image (the join's middle, -3.5 stops, and therefore `TOE_GAIN` and the toe's line stay exactly as they are).

## Requested change
`TOE_START_STOPS = -1`, `TOE_FULL_STOPS = -6` (the same smoothstep in stops of scene luminance, the same
`TOE_GAIN` rule: AgX at the middle of the span, which is still -3.5 stops), CPU and WGSL alike. Any other join
that is slope-continuous over three stops or more is as good (-1.5 to -5.5 gives 0.14 per quarter stop).
Unit test (replaces the "bit-identical from -3 stops upwards" assertion of request 3 by "from -1 stop
upwards"): the log-log slope of `displayLinear` for greys changes by under 0.15 per quarter stop from +1 to
-8 stops, and the transform stays monotonic.
Must not change: the toe below -6 stops (display-linear = `TOE_GAIN` x scene-linear on the whole colour: the
night-sky specs of the sky package assert levels there), AgX above -1 stop, the exported names.
The sky package re-shoots its flare views and adds the slope check both critics ask for to
`tests/browser/sky/flare.spec.ts` when this lands; it is reshaping the glare profile in parallel (less energy
in the wide skirt), which makes the edge smaller but cannot remove it.
