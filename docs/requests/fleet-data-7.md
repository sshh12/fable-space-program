Status: open
From: fleet-data
Owner path: tests/unit/sim-vessel/debris.test.ts (island-core this wave)
Blocking: no

## Problem
"a gentle drop of each part, in four attitudes, ends at rest on the surface" ends with
`expect(broke.length).toBeLessThan(10)`: a count over the WHOLE part library of the drops in which a fragile part
breaks by toppling over. It was set when the library had 25 parts (9 of them break today). With the fleet's 33 new
parts the library has 58, and two long first stages (azimuth-s1, 15.5 m; solstice-s1, 22 m) break by toppling from
the skew attitude as the Meridian's M-1, M-2 and M-3 do: 11 in all.

## Evidence
`npx vitest run tests/unit/sim-vessel/debris.test.ts -t "gentle drop"`: "broken by toppling over: azimuth-s1,
skew; heron-ascent-stage, skew; heron-capsule-adapter, on its side; heron-descent-stage, skew;
meridian-interstage-1, on its side; meridian-interstage-2, on its side; meridian-m1, skew; meridian-m2, skew;
meridian-m3, skew; meridian-payload-adapter, on its side; solstice-s1, skew". Every other expectation of the test
holds for every new part (each touches down, none falls through, each comes to rest).

## Requested change
Hold the toppling breaks to a share of the drops instead of an absolute count (for instance under 10 % of the
4 x part-count drops, which the 25-part library met at 9 of 100), or list the parts expected to break. fleet-data
raised the ground tolerance of its structures to the rules' default (6 m/s) and gave its ports' contact probes
6 m/s (their 2.5 m/s docking tolerance stays `PartDef.crashTolerance`); it did not raise the two stages further to
fit the count. Must NOT change: the other expectations of the test.
