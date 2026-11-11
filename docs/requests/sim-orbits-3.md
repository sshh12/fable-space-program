Status: resolved (commit 3d9fcae)
From: sim-orbits
Owner path: src/core/math/conic.ts (timeSincePeriapsis; ConicElements doc comment)
Blocking: no

## Problem
1. `timeSincePeriapsis` loses digits near e = 1. Its Barker band (|e - 1| < 1e-9) drops the (1 - e) terms,
   and just outside it E - e sin E / e sinh H - H cancel. UI consumers of `Patch.conic` (map-view's
   anomalyTime.ts, scene.ts) evaluate patch times with it, while the sim computes `conic.tPeriapsis` and every
   event time with the cancellation-free form in src/sim/orbit/anomaly.ts (`timeFromPeriapsis(e, p, mu, nu)`,
   needed for the 1 +/- 1e-9 Kepler acceptance). The two are the same relation; they agree to rounding away
   from e = 1 but not near it. The brief asks the sim to build on src/core/math rather than keep its own
   copy, which needs the core function to be the well-conditioned one.
2. `Patch.conic` of a RADIAL trajectory (r x v = 0, e.g. a vessel at rest or moving vertically at the lunar
   pole) cannot be represented by the documented fields. The sim now emits a documented degenerate conic
   (below), but the ConicElements doc does not mention it. In the same doc, "period: null when not closed
   (e >= 1)" differs from `conicFromState`, which returns null already for e >= 1 - 1e-9.

## Evidence
Both relations evaluated at 401 anomalies |nu| <= 0.999 nu_max per eccentricity, on conics from
conicFromState (rp = 6,600 km, Earth mu), relative difference |core - sim| / max(|t|, 1 s);
tests/unit/sim-orbits/anomaly.test.ts asserts the bound 1e-13 + 4e-16/|1 - e| outside the Barker band and
1e-7 inside it for |nu| <= 2. Worst values:

| e | worst relative difference | where |
|---|---|---|
| 0 .. 0.97, 1.01 .. 5 | <= 2e-14 | - |
| 0.99999 | 1.8e-11 | near periapsis |
| 1 - 1e-7 / 1 + 1e-7 | 1.2e-9 / 2.1e-9 | near periapsis |
| 1 - 2e-9 / 1 + 2e-9 | 9e-8 / 1.2e-7 (146-155 s) | near periapsis |
| 1 - 5e-10 / 1 + 5e-10 (Barker band) | 1.2e-4 (1.2e7 s) | nu = 3.138 rad |
| 1 (exactly) | 8e-16 | - |

## Requested change
1. Replace the body of `timeSincePeriapsis(c, nu)` with the relation of src/sim/orbit/anomaly.ts
   `timeFromPeriapsis` (copy that function and its helpers `atanOverX`, `atanhOverX`, `remainder3`):
   t - tp = sqrt(p^3/mu) [2 A D/(1+e)^2 + 8 e S3 A^3 D^3/(1+e)^3], D = tan(nu/2), w = sqrt(|1-e|/(1+e)) D,
   A = atan(w)/w or atanh(w)/w, S3 = (E - sin E)/E^3 or (sinh H - H)/H^3 by series near 0, the classical
   E - e sin E for ellipses with |E| > pi/2. It needs only c.e, c.p, c.mu (not c.a) and has no band: at
   e = 1 it is Barker's equation exactly. Keep the signature and the conventions (elliptic results in
   (-period/2, period/2], +/-Infinity beyond a hyperbola's asymptote). When this lands, sim-orbits deletes its
   copy and calls the core function (tests/unit/sim-orbits/anomaly.test.ts then checks identity).
2. Document in the ConicElements comment: "A radial trajectory (h = 0) is represented with e = 1 and p = 0
   (test p === 0): a = 1/alpha from the energy (finite unless parabolic), P = minus the vessel's radial
   direction (the limit periapsis direction), W an arbitrary unit normal, period null; the vessel stays at
   true anomaly pi (Patch nuStart = nuEnd = pi), so anomaly-based helpers do not apply and drawing code
   should treat such a patch as the straight segment between its start and end positions." and align the
   period sentence with conicFromState ("null when e >= 1 - 1e-9 or when e >= 1").
What must NOT change: the ConicElements fields and `conicFromState`'s output for non-radial states.

## Resolution
Lead. Both points.

1. `src/core/math/conic.ts` now holds the cancellation-free relation:
   `export function timeFromPeriapsis(e: number, p: number, mu: number, nu: number): number` (with
   `atanOverX`, `atanhOverX` exported and `remainder3` private), and
   `timeSincePeriapsis(c, nu)` = `timeFromPeriapsis(c.e, c.p, c.mu, nu)`: same signature and conventions
   (elliptic results in (-period/2, period/2], +/-Infinity beyond a hyperbola's asymptote), no parabolic
   band, `c.a` is no longer read. `src/sim/orbit/anomaly.ts` no longer has a copy: it re-exports the three
   functions, so sim imports are unchanged.
   Tests: `src/core/math/math.test.ts` "time since periapsis keeps its digits through e = 1" checks the
   relation against quadrature of dt = sqrt(p^3/mu) dnu / (1 + e cos nu)^2 to 2e-12 for e from 0 to 3,
   including 1 +/- 5e-10, 1 +/- 2e-9 and 1 +/- 1e-7 (the old form was off by 1e-9 .. 1e-7 there);
   `tests/unit/sim-orbits/anomaly.test.ts` asserts that the sim function IS the core function and that
   `timeSincePeriapsis` is bit-identical to it.
2. The `ConicElements` comment documents the radial convention (e = 1, p = 0, test `p === 0`; a = 1/alpha;
   P = minus the radial direction; W arbitrary; period null; the vessel stays at true anomaly pi; draw the
   straight segment) and `period` says "null when e >= 1, and also for e >= 1 - 1e-9; test
   `period !== null`, never `e < 1`".
Migration: none. Values of `timeSincePeriapsis` change only within rounding away from e = 1 and become
correct near it. `ConicElements` fields and `conicFromState` output are unchanged.
