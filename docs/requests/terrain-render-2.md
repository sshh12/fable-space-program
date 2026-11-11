Status: open
From: terrain-render
Owner path: tools/bake/earth (regional height source), data/tiles/earth/height levels 8-12
Blocking: yes        (the reviewed pad views "looking inland" / "along the coast" and the shoreline view show a 1.1 km tall needle 2 km from the pad; nothing in src/render/terrain can remove it)

## Problem
The regional Earth height tiles contain isolated spikes on the shore near the launch pad: single samples up to
1,135 m above ground that is 0-7 m high. They render as dark needles that cast kilometre-long shadows, and the
collision surface has them too. They look like the corrupt Terrarium / 3DEP near-shore values the Earth hand-off
describes (section 4, "sea values are garbage near this coast"), on samples that the land / ocean classification
kept as land.

## Evidence
`npx tsx tools/terrain/scan-spikes.ts earth 18.987556 -155.603239 4000 12 30` (terrain-render's scanner: stored
samples more than 30 m from the median of their 5 x 5 neighbourhood, within 4 km of the pad, level 12):

```
1/12/2973/2819 sample (72, 25):    77.6 m, neighbourhood median 22.3 m, at 18.93798,-155.68676
1/12/2977/2820 sample (11, 249):  225.8 m, neighbourhood median  0.4 m, at 18.96858,-155.59942
1/12/2977/2820 sample (13, 250):  216.3 m, neighbourhood median -0.6 m, at 18.96864,-155.59924
1/12/2977/2822 sample (133, 111): 656.1 m, neighbourhood median  0.2 m, at 19.00031,-155.58836
1/12/2977/2822 sample (133, 112): 1135.4 m, neighbourhood median 6.3 m, at 19.00040,-155.58836
1/12/2977/2822 sample (133, 113): 558.9 m, neighbourhood median  6.3 m, at 19.00049,-155.58836
... 18 samples in three clusters; level 11 carries the same needles (340-397 m at 19.0003-19.0005 N, 155.58836 W)
```

Screenshots: `out/screens/terrain/pad-inland.png`, `pad-coast.png`, `shoreline-200m.png` (the needle and its shadow).
The scanner takes any centre, radius, level and threshold, so the whole 100 km region can be checked after a fix
(`... earth 18.987556 -155.603239 100000 12 60` reads every level-12 tile of the disc).

## Requested change
Regional height tiles (levels 8-12) without these outliers: e.g. a despike of the Terrarium source before the
pyramid is built (a sample that stands more than a few tens of metres above the median of its neighbourhood while
its neighbours are near sea level is replaced by that median), then the usual re-bake of the affected levels and of
the layers that record the height build hash. The pad location and everything away from the spikes must not change.
