Status: open
From: solar-system-sim
Owner path: tests/unit/fleet/reachTable.ts, tests/unit/fleet/reach.test.ts (fleet-data); docs/OPEN_QUESTIONS_V2.md Q17 (the lead)
Blocking: no

## Problem
fleet-data's reach table holds four bodies the refuelled Albatross does not close (Q17): Mercury -1,162 m/s,
Mimas -382, Pluto -4,808, Charon -5,042. Three of the four are an artefact of the reach profile's defaults, not
of the fleet: the default heliocentric leg is a DIRECT Lambert arc searched over ONE synodic period.
- Pluto and Charon lie 15-17 deg off the ecliptic in the 2030s: a direct arc near half a revolution needs a
  steep transfer plane. A broken-plane arc (in the Earth's orbit plane, one plane change on the way, then to
  Pluto's true position) is 6.3 km/s cheaper.
- Mercury's eccentric orbit makes its windows differ strongly from one synodic period to the next: the first
  one after 2029-09-24 costs 12.07 km/s after the refuel, the best of the seven years after it 9.03.

## Evidence
`deltaVToOrbit(defs, id, { refuel: 'highOrbit', brokenPlane: true, searchSpan: 7 * 365.25 * 86400 })` on the staged
library (src/sim/nav/reach.ts; tests/unit/solar-system/reach.test.ts, "reach with broken-plane arcs ..."), km/s
before + after the refuel against the cruiser's 10.9:

| Body | Default options | brokenPlane + 7-year search | Transfer |
|---|---|---|---|
| Mercury | 3.19 + 12.07 | 3.19 + 9.03 | 95 d |
| Mimas | 3.19 + 11.29 | 3.19 + 11.25 (still short by 0.35) | 5.2 y |
| Pluto | 3.19 + 15.72 | 3.19 + 9.43 | 68 y |
| Charon | 3.19 + 15.95 | 3.19 + 9.67 | 68 y |

Every other body stays closed: Ceres falls by 2.4 km/s (to 7.15 after the refuel), the rest move by at most
0.34 km/s (Jupiter rises by 0.02: the refined cell of a coarser search). The defaults are unchanged (your
table, and its held shortfalls, are what you have today).

## Requested change
1. In `reachTable` pass `{ brokenPlane: true, searchSpan: 7 * 365.25 * 86400 }` to both `deltaVToOrbit` calls
   (about 0.7 s per body instead of 0.1 s), and hold Mercury, Pluto and Charon closed; Mimas stays the one
   body for Q17 with its shortfall of about 350 m/s.
2. For the lead (Q17): Mimas is not closed by any profile of this function (direct or broken-plane arcs, the
   flyby or the planet-capture way into a moon's orbit, a high-orbit or a lunar-orbit refuel). What would close
   it: about 0.4 km/s more delta-v in the cruiser after the refuel, a second refuel point beyond Earth, or an
   aerobraking pass in Saturn's atmosphere (the profile aerobrakes only at bodies with a solid surface). Pluto's
   68-year arc is the cheapest in the 0.6-1.5 Hohmann-time range; it is long but within the time model.

Must NOT change: the other rows of the table.
