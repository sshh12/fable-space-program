Status: open
From: bodies-ephemeris
Owner path: docs/ARCHITECTURE.md 8.2 and the bodies-ephemeris brief (the lead: tolerances and sources of the ephemerides)
Blocking: yes (acceptance "passes the Horizons validation" cannot be met for every body with the design's sources)

## Problem
Implemented as written (planets: JPL Table 1 with its rates and fitted mean motion; Earth: the v1 Almanac Sun
inverted; Moon: the frozen v1 ellipse; moons: JPL satellite mean elements in the three plane frames, Saturn's
moons fitted at the lobby epoch keeping a, e, P and the precession periods; Ceres and Pluto: SBDB osculating
elements), the staged bodies deviate from Horizons over 2030-2060 by more than the brief's tolerances for
16 of the 32 bodies. The causes are properties of the sources, not of the code (the tool's evaluator equals
the runtime's to 1e-6 m, `tests/unit/bodies/ephemeris.test.ts`), so they cannot be fixed within the design.

## Evidence
`node tools/bodies/validate.mjs` (ten epochs 2030-01-01 .. 2060-01-01 TDB, ICRF, body centres; full table in
`tools/bodies/validation-report.json`). Worst deviation per body:

| Body | Path | Worst | Tolerance | Cause |
|---|---|---|---|---|
| Mercury | Table 1 | lat 1.6" (lon 13.9", dist 1,000 km) | 15" / 1" / 1,000 km | Table 1 errors are "nominal" (typical), not bounds |
| Venus | Table 1 | dist 4,492 km (lon 19.4", lat 0.7") | 20" / 1" / 4,000 km | as Mercury |
| Mars | Table 1 | lon 58.7" | 40" | as Mercury |
| Jupiter | Table 1 | lon 467" | 400" | as Mercury |
| Saturn | Table 1 | lon 890", lat 25.2", dist 1.71e6 km | 600" / 25" / 1.5e6 km | as Mercury |
| Uranus | Table 1 | lon 197", lat 3.1" | 50" / 2" | as Mercury |
| Neptune | Table 1 | lon 50", dist 1.37e6 km | 10" / 200,000 km | as Mercury; already 0.8e6 km in 2040 |
| Earth | v1 formula | 0.84 deg (3,013" in longitude) | - (pinned) | the Almanac formula is referred to the mean equinox OF DATE: the offset is the precession since J2000 (1,490" in 2030, 3,013" in 2060); of date it is within 28", inside the formula's stated 0.01 deg (36") |
| Moon | frozen v1 | 162 deg | - (pinned) | no nodal regression or apsidal precession by design |
| Phobos | sat table | 166 deg | 1 deg | the table's P has four digits (0.3187 d): 1e-4 relative is many orbits per decade |
| Deimos | sat table | 91 deg | 1 deg | P to five digits (1.2625 d) |
| Io | sat table | 1.68 deg | 1 deg | P to seven digits plus long-period terms; drift 0.07 deg per 1,000 d |
| Europa | sat table | 3.57 deg | 1 deg | as Io |
| Mimas | sat fit | 80 deg | 1 deg | the Mimas-Tethys resonance: Mimas' longitude librates by about 44 deg with a 71-year period; no uniformly precessing ellipse follows it |
| Tethys | sat fit | 4.7 deg | 1 deg | the same resonance (smaller libration) |
| Miranda | sat table | 2.72 deg | 1 deg | drift 3e-4 deg/day against the table's P |
| Triton | sat table | 161 deg | 1 deg | the table's P (5.8792 d) does not give Triton's mean motion (5.8769 d sidereal); 4.6 deg off at J2000 already |
| Ceres | SBDB | 3.94 deg | 1 deg (the satellites', no tolerance stated) | osculating elements of 2026 propagated two-body; Jupiter's perturbations |

Within tolerance: Ganymede 0.25 deg, Callisto 0.15, Enceladus 0.46, Dione 0.21, Rhea 0.10, Titan 0.05,
Iapetus 0.25, Ariel 0.18, Umbriel 0.11, Titania 0.30, Oberon 0.22, Charon 0.085, Pluto 0.20 (radial
deviations all under 0.6 %).

Exploration (scratch scripts, not part of the tool, numbers indicative): the brief's fit path applied to the
failing moons AND the mean motion fitted to Horizons over 2029.7-2060 gives Io 0.05 deg, Europa 0.12,
Tethys 0.47, Miranda 1.5, Deimos 1.9, Triton 7.9, Mimas 12 (the libration); Phobos needs a better starting
mean motion than the table's to be fitted at all.

## Requested change
A decision per group; the generator can carry any of them in a line of `tools/bodies/lib/catalogue.mjs` /
`build.mjs`, and solar-system-sim owns `tools/bodies` in wave 4:
1. Planets: (a) keep Table 1 and state the measured factor as the tolerance (worst: Neptune distance x6.9,
   Uranus longitude x3.9); or (b) fit each planet's KeplerOrbitDef (elements, the six rates, the mean
   motion) to Horizons over 2030-2060 instead of Table 1.
2. Moons that fail: (a) extend the brief's fit path to every moon and fit the mean motion as well (Mimas
   still cannot meet 1 degree: its tolerance must then be stated separately, e.g. the libration amplitude);
   or (b) accept the table elements with the measured deviations documented.
3. Ceres: fit mean elements over 2030-2060, or accept 4 degrees.
4. Earth and the Moon stay pinned (ARCHITECTURE 8.2); please confirm that the validation reports them without
   gating (Earth 0.42-0.84 deg from Horizons in ICRF; the Moon's frozen ellipse 162 deg).
Until a decision the staged files follow the brief exactly and `validate.mjs` exits 1 listing these bodies.
