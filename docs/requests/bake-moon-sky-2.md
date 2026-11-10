Status: open
From: bake-moon-sky
Owner path: docs/WORK_PACKAGES.json (bake-moon-sky acceptance: "albedo has no residual illumination (east/west crater-wall brightness ratio within 5% on 20 sampled craters)")
Blocking: no

## Problem
The per-crater form of the de-shading criterion cannot be met by removing illumination, because the albedo
base the brief prescribes (NASA SVS CGI Moon Kit colour, Hapke-normalised) already has real west/east wall
albedo differences beyond 5 % on 11 of the 26 sampled craters (dark-halo ejecta, mare/highland contacts,
ray material). The final level-7 albedo has 13 of 26 craters within 5 %, and its deviations show no trace of
the mosaic's baked shading. The test as written measures lunar albedo asymmetry, not residual illumination.

## Evidence
`python -I tools/bake/moon/verify.py` (output in `out/bake/moon/verify.txt`, numbers in `verify.json` under
`deshading`). West-facing / east-facing wall brightness (red, linear; wall pixels inside the refined rim
steeper than 8 deg on the level-6 DEM, split by downhill aspect +-45 deg):

| Crater | level 7 final | level 5 (SVS base only) | raw WAC mosaic |
|---|---|---|---|
| Kepler | 1.066 | 1.052 | 3.359 |
| Aristarchus | 0.929 | 0.929 | 2.254 |
| Timocharis | 1.004 | 1.011 | 3.519 |
| Euler | 1.006 | 1.011 | 3.124 |
| Lambert | 1.030 | 1.041 | 3.310 |
| Bessel | 1.007 | 0.991 | 6.356 |
| Dawes | 1.058 | 1.042 | 8.663 |
| Plinius | 0.996 | 0.998 | 4.224 |
| Manilius | 0.952 | 0.959 | 3.069 |
| Menelaus | 1.138 | 1.145 | 5.083 |
| Arago | 1.011 | 1.004 | 3.204 |
| Delisle | 1.051 | 1.044 | 3.999 |
| Diophantus | 1.012 | 1.018 | 8.412 |
| Pytheas | 0.895 | 0.923 | 3.792 |
| Mosting | 0.942 | 0.948 | 3.107 |
| Lalande | 1.019 | 1.004 | 2.620 |
| Godin | 0.940 | 0.946 | 3.524 |
| Dionysius | 0.728 | 0.751 | 8.139 |
| Maskelyne | 1.044 | 1.051 | 3.887 |
| Proclus | 0.918 | 0.930 | 8.399 |
| Picard | 0.790 | 0.797 | 3.591 |
| Taruntius | 1.012 | 1.021 | 2.849 |
| Bullialdus | 0.936 | 0.933 | 2.417 |
| Agrippa | 1.002 | 1.000 | 3.611 |
| Herschel | 0.947 | 0.962 | 3.142 |
| Theon Senior | 1.026 | 1.027 | 8.638 |

- The test is sensitive: the raw WAC mosaic gives 2.2-8.7 (median |1 - ratio| 2.56); the final albedo 0.73-1.14
  (median 0.050).
- Residual shading would make the final ratios follow the raw mosaic's: correlation of the log ratios -0.05.
  The independent review found the same against the fitted SVS shading gradient (r = 0.03) and the fitted
  WAC gradient (r = -0.16). The geometric mean over the 26 craters is 0.975.
- The level-7 detail changes the SVS-only ratios by 1.2 % RMS with mixed signs (9 up, 17 down, mean -0.4 %),
  not toward the mosaic's sun (which would raise every ratio). The SVS base alone already fails 5 % on Kepler,
  Aristarchus, Menelaus, Pytheas, Mosting, Godin, Dionysius, Maskelyne, Proclus, Picard and Bullialdus, so at
  most 15 of 26 are reachable with the prescribed base. The outliers are known albedo features: Dionysius' dark-halo ejecta, Picard and Menelaus on mare/highland
  contacts, Proclus' rays (`out/bake/moon/deshade-*.png` show the walls).
- The first bake had 15 of 26 within 5 %; keeping half-strength de-shaded detail on steep walls (review finding
  7, which removed ring artefacts around large craters) moved two craters just past 5 % (Delisle 1.051,
  Herschel 0.947).

## Requested change
Re-base the criterion on residual illumination rather than on albedo symmetry, for example: "the geometric-mean
west/east wall ratio over >= 20 craters is within 5 % of 1 and the per-crater log ratios do not correlate with
the source mosaic's baked shading (|r| < 0.3)" - both hold (0.975, r = -0.05) - or accept the per-crater result
with this note. Nothing in the bake needs to change.
