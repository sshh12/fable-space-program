# Hand-off: site-bake (wave 3.1)

Status (after the lead's decisions of 2026-11-12, section 0.10): Madrakah resolved and accepted; **Ka Lae resolved: 9 pads (LC-1, 1 heavy, 2 medium, 5 light) after the lead accepted the 25 km field and the look (section 0.12, which also lists what the next packages inherit)**; verify 24 of 27 + 3 waived by the lead, 0 failed. Before the decisions: follow-up round done (2026-11-12 05:00-10:30 Pacific), one item STOPPED for the lead. Madrakah was baked
again (Copernicus GLO-30 instead of SRTM, the lead's near-shore sea floor, false inland water removed, de-shading
refit) and swapped in by REPLACE (only the region's directories changed: 506 of its 840 plus `manifest.json`;
section 0.7). Madrakah's 16 pads were re-resolved under the full LC-1 rule with the built-up and corridor gates,
LOOKED at pad by pad, and moved along the coast to 19.08-19.37 N (section 0.2). **Ka Lae is stopped**: under the same
gates only 9 of 16 pads fit within 95 km, so `ka-lae.pads.json` was withdrawn and two candidate layouts await the
lead's decision (section 0.3). `verify.py --region earth-madrakah`: 24 of 27 pass, 2 WAIVED BY THE LEAD (relief
shading, measured numbers in section 0.6), 1 fails (the level-11 albedo seam statistic, as in round 1). Sections 1-12
below are round 1 as written then, marked where superseded. The running log is at the end.

## 0. Follow-up round (the coordinator's review of 2026-11-12)

### 0.1 What was asked and where it is answered

| Item | Answer |
|---|---|
| A1 pads: no built-up land within max(blend, keep-out) + margin, no road, no wadi bed, LOOK at every pad | gates in `padresolve.py`; every Madrakah pad looked at (0.2) |
| A2 launch corridors 60-130 deg to 12 km free of pads' keep-out discs and built-up land; per-pad table | gate, both ways; tables in 0.2 (Madrakah) and 0.3 (Ka Lae candidates) |
| A3 Madrakah keeps the full LC-1 rule, 45-50 km search, along the coast north of the headland | `--strict --search-km 45`; moved along the coast (0.2) |
| A3 Ka Lae: gates 1 and 2, ocean sector reported; replace the outliers; Q8 fall-back dry run | STOPPED: 9 of 16 fit; fall-back 8 of 32 (0.3) |
| B4 near-shore sea floor: ETOPO only where it is itself sea deeper than the ramp | `seaFloorNearShore` "deeper" (0.5) |
| B6 GLO-30 test at the pad field against SRTM, both pictures, licence | GLO-30 is better and was used (0.4) |
| B6 REPLACE swap: staged, atomic at the manifest, nothing outside the region's rectangles | `stage.py` / `swaptree.replace_tree` (0.7) |
| B7 false inland water | dropped by height range, slope and size (0.5) |
| B8 de-shading refit, else WAIVED BY THE LEAD with the numbers | refit; still fails, reported as waived (0.6) |
| After the bake: replace-swap, verify, exact changed directories | 0.6, 0.7 |
| C5 request about `realData.test.ts`; Madrakah level-12 edge continuity not checked by the provider test | `docs/requests/site-bake-2.md`; 0.9 |
| C10 `pads.test.ts` checks `bareFraction`; the pads file records the tile set's hash | done: `tilesetContentHash`, `rule.dry` (0.8) |

### 0.2 Madrakah: re-resolved under the full LC-1 rule, moved along the coast

`data/staged/sites/madrakah.pads.json` (replaced). Resolved on the live tile set after the replace swap
(`tilesetContentHash` f5e6ef420bda7cea, recorded in the file) with:

```
bake.py pads --region earth-madrakah --site madrakah --nominal 19.0,57.8 --strict --search-km 45 --exclude <42 discs, section below>
```

**The rule** (every gate, `rule` in the file): flat (500 m disc: plane slope < 4 deg, relief <= 12 m), dry (the
centre and 80 % of the disc bare ground: WorldCover bare / sparse vegetation, as LC-1), clear of the shore (no water
within 600 m, height >= 15 m), on the coast (the sea within 6 km), **LC-1's open-ocean sector** (every azimuth
60-130 deg reaches the sea within 6 km and the sector holds no land from there to 100 km: `--strict`, the lead's
decision), **no built-up land** (WorldCover built-up) within max(blend, keep-out) + 300 m of the pad's class (heavy
1,200 m, medium 900 m, light 600 m), **the launch corridor** (azimuths 60-130 deg out to 12 km free of built-up land
and of every other pad's keep-out disc, both ways; keep-out heavy 600, medium 450, light 300 m), **not excluded after
looking**, latitude < 20.5 deg; spacing as before (same class 2.5 / 1.5 / 1.0 km, two classes the mean). The corridor
gate strings the pads north-south across the launch direction.

**Moved along the coast.** Within 8.8 km of the nominal point no ground passed every gate and the look (the nearest
candidates, 5-6 km north on the headland, had a graded road through the disc; the round-1 ground about the nominal
point fails the open-ocean sector or lies within the built-up clearance): the field lies on the coastal plain north of Ras Madrakah, from 19.08 to 19.37 N, 8.8-41.0 km from the
nominal point, on a strip 0.6-2.4 km behind the cliffed shore. The site's reference pad (`pads[0]`, lc-1, heavy) is
at 19.078241 N 57.786868 E; the nominal point 19.0 N 57.8 E stays the region's centre. The heavy pads take the south
of the strip (19.08-19.12 N, and one at 19.22 N), the medium and light pads the flat gravel plain at 19.25-19.37 N.

**Looked at, every pad.** Each placement was rendered on the level-12 imagery with a hillshade of the level-12
heights (1.4 km across, the 500 m disc drawn) and judged; ground with a graded road or track through the disc, in a
wadi bed or a wadi channel network, on broken ground (outcrops, gullies, knolls) was excluded by a disc (`--exclude`)
and the field re-resolved: thirteen runs, every new placement of each looked at (17 close-up sheets); 42 exclusion
discs are recorded in the file (`rule.excluded`, with the reason for each; three of them are zones of 1.2-2.5 km
where several candidates in a row were on dissected ground, and seven a strip along an east-west graded track at
19.362 N). Faint vehicle tracks and thin rills that the pad apron erases were accepted and are noted below. Pictures: `out/bake/earth/site-bake/pads-madrakah-final-{a,b,c}.png` (every pad, 1.4
km, imagery and hillshade), `pads-madrakah-sheet.png` (every pad, 2.6 km, flat / blend / built-up rings and corridor
edges), `pads-madrakah-corridors.png` (the field, 45 km, keep-out discs and corridors); the rejected candidates in
`pads-madrakah-closeup{1..15}.png`.

What the pictures show per pad: lc-1 dark ophiolite gravel; lc-2 gravel with thin wadi rills in the west of the
disc; lc-3 clean gravel; lc-4 gravel with faint tracks, a small knoll at the south-east edge; lc-5 a faint north-south
track through the centre and thin rills; lc-6 thin rills; lc-7 plain, a line of shrubs along a shallow drainage at the
north-east edge; lc-8 to lc-15 flat pale gravel plain, faint tracks; lc-16 plain, the east-west graded track 330 m
south (outside its 300 m blend disc) and a pale outcrop 340 m east.

Pads (`rule` and every evaluation in the file; columns as section 3, plus the distance to the sea and to built-up land with the class's need; "> 1500" = none in the 3 x 3 km window):

| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Sea m | Built-up m (need) | Bare | Centre class | Ocean sector 60-130 | From nominal km |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lc-1 | heavy | 19.078241, 57.786868 | 144.51 | 1.32 | 5.2 | 0.24 | 1.15 | 990 | 1000 | > 1500 (1200) | 1.00 | bareRock | open | 8.81 |
| lc-2 | heavy | 19.100904, 57.788294 | 114.06 | 0.70 | 5.0 | 0.20 | 1.45 | 738 | 750 | > 1500 (1200) | 1.00 | sand | open | 11.29 |
| lc-3 | heavy | 19.121947, 57.779726 | 108.50 | 0.28 | 1.5 | 0.10 | 0.46 | 1677 | 1701 | > 1500 (1200) | 1.00 | sand | open | 13.73 |
| lc-4 | heavy | 19.224994, 57.723139 | 89.86 | 0.47 | 6.2 | 0.16 | 1.19 | 2391 | 2405 | > 1500 (1200) | 1.00 | sand | open | 26.29 |
| lc-5 | medium | 19.247390, 57.730272 | 97.54 | 0.40 | 1.9 | 0.11 | 0.55 | 1250 | 1251 | > 1500 (900) | 1.00 | sand | open | 28.47 |
| lc-6 | medium | 19.260073, 57.735411 | 96.74 | 0.29 | 6.2 | 0.14 | 0.59 | 642 | 652 | > 1500 (900) | 1.00 | sand | open | 29.70 |
| lc-7 | medium | 19.271671, 57.727976 | 88.45 | 0.24 | 2.0 | 0.09 | 0.43 | 1364 | 1400 | > 1500 (900) | 1.00 | sand | open | 31.14 |
| lc-8 | medium | 19.283545, 57.734830 | 91.45 | 0.14 | 1.4 | 0.08 | 0.51 | 607 | 608 | > 1500 (900) | 1.00 | sand | open | 32.26 |
| lc-9 | medium | 19.295143, 57.727394 | 93.24 | 0.05 | 1.2 | 0.07 | 0.27 | 1421 | 1450 | > 1500 (900) | 1.00 | sand | open | 33.69 |
| lc-10 | medium | 19.306208, 57.735679 | 93.15 | 0.04 | 0.7 | 0.07 | 0.23 | 610 | 618 | > 1500 (900) | 1.00 | bareRock | open | 34.71 |
| lc-11 | light | 19.317540, 57.737676 | 92.72 | 0.09 | 1.9 | 0.07 | 0.29 | 611 | 618 | > 1500 (600) | 1.00 | sand | open | 35.91 |
| lc-12 | light | 19.326444, 57.739102 | 91.71 | 0.26 | 1.7 | 0.08 | 0.48 | 611 | 618 | > 1500 (600) | 1.00 | sand | open | 36.86 |
| lc-13 | light | 19.335078, 57.742244 | 85.64 | 0.29 | 1.6 | 0.09 | 0.37 | 622 | 626 | > 1500 (600) | 1.00 | sand | open | 37.75 |
| lc-14 | light | 19.343713, 57.745672 | 83.51 | 0.04 | 0.9 | 0.07 | 0.21 | 615 | 632 | > 1500 (600) | 1.00 | sand | open | 38.64 |
| lc-15 | light | 19.352347, 57.748815 | 84.37 | 0.16 | 1.0 | 0.07 | 0.25 | 622 | 640 | > 1500 (600) | 1.00 | sand | open | 39.55 |
| lc-16 | light | 19.365568, 57.751956 | 88.52 | 0.26 | 2.8 | 0.10 | 0.47 | 790 | 800 | > 1500 (600) | 1.00 | sand | open | 40.96 |

Launch corridors (per pad: the contiguous range of azimuths about 90 deg whose ray is free to 12 km of built-up land and of every other pad's keep-out disc; the nearest pad keep-out disc and the nearest built-up land in the 60-130 deg sector; every sector looks over the open sea, LC-1's rule):

| Pad | Clear launch azimuths (deg, free to 12 km) | Nearest pad keep-out in the 60-130 deg sector | Nearest built-up land in the sector (to 30 km) |
|---|---|---|---|
| lc-1 | 17.5-130 | none | none within 30 km |
| lc-2 | 0-156.5 | none | none within 30 km |
| lc-3 | 0-145 | none | none within 30 km |
| lc-4 | 27-141.5 | none | none within 30 km |
| lc-5 | 38.5-180 | none | none within 30 km |
| lc-6 | 10-160 | none | none within 30 km |
| lc-7 | 46-131 | none | none within 30 km |
| lc-8 | 13.5-168.5 | none | none within 30 km |
| lc-9 | 53-131 | none | none within 30 km |
| lc-10 | 23.5-171.5 | none | none within 30 km |
| lc-11 | 26.5-168.5 | none | none within 30 km |
| lc-12 | 36.5-171 | none | none within 30 km |
| lc-13 | 38-180 | none | none within 30 km |
| lc-14 | 36.5-180 | none | none within 30 km |
| lc-15 | 24.5-180 | none | none within 30 km |
| lc-16 | 0-180 | none | none within 30 km |

Nearest built-up land in any direction (6 km window): lc-1 2.4 km at 133 deg, lc-2 4.5 km at 158 deg, lc-3 5.3 km at 348 deg, none within 6 km of lc-4 to lc-16.

Ground excluded after looking (`rule.excluded`; centre, radius m, reason):

| Centre | Radius m | Reason |
|---|---|---|
| 19.045056, 57.800571 | 800 | a graded track crosses the disc (looked at, level-12 imagery) |
| 19.096585, 57.772877 | 600 | braided wadi channels across the disc |
| 19.130041, 57.777155 | 600 | in a braided wadi bed |
| 19.140024, 57.786863 | 600 | wadi channels converge at the centre |
| 19.205577, 57.747432 | 800 | road junction and the bright wadi fan at the coast |
| 19.051531, 57.794862 | 800 | the same graded track crosses the disc |
| 19.099284, 57.778301 | 600 | braided wadi channels across the south of the disc |
| 19.135436, 57.777440 | 600 | braided wadi channels across the disc |
| 19.147038, 57.784863 | 600 | broken ground: wadis and outcrops |
| 19.159719, 57.790289 | 600 | a gully through the centre, a wadi at the edge |
| 19.212589, 57.738573 | 600 | wadi channels through the centre |
| 19.237410, 57.735420 | 600 | a scarp along the south-east of the disc, wadi patches |
| 19.119248, 57.774301 | 600 | a wadi bed across the north-west of the disc |
| 19.134898, 57.791433 | 600 | wadi channels converge through the disc |
| 19.150815, 57.780579 | 600 | braided wadis and broken ground |
| 19.163496, 57.786004 | 600 | broken ground, outcrops and a gully |
| 19.216098, 57.743143 | 600 | rocky hummocky ground, a gully at the south-east edge |
| 19.231472, 57.730565 | 600 | a rocky knoll and its scarp on the east of the disc |
| 19.140024, 57.794003 | 600 | wadi channel network across the disc |
| 19.155402, 57.784006 | 600 | braided wadis through the disc |
| 19.216095, 57.734000 | 600 | dense branching wadi channels |
| 19.240645, 57.730561 | 600 | a wadi channel network across the disc |
| 19.150000, 57.778000 | 2500 | wadi-dissected plain and outcrops between 19.13 and 19.17 N (eleven candidate pads looked at there) |
| 19.213000, 57.739000 | 1500 | wadi-dissected rocky ground between 19.20 and 19.23 N (five candidate pads looked at there) |
| 19.149462, 57.754018 | 700 | a graded road junction at the edge, an outcrop ridge through the disc |
| 19.221219, 57.727426 | 600 | outcrops and hummocks in the disc |
| 19.155937, 57.754874 | 900 | a graded road through the west of the disc and a junction (the same road as the last) |
| 19.224998, 57.732282 | 600 | a rocky outcrop in the north-east of the disc |
| 19.244000, 57.736000 | 700 | wadi channels cross the disc (four candidate pads looked at here) |
| 19.278686, 57.727687 | 600 | a track with a line of objects crosses the disc |
| 19.243072, 57.725416 | 700 | the same wadi crosses the centre with its branches |
| 19.245000, 57.716000 | 1200 | wadi-dissected ground west of the coastal strip, 19.23-19.26 N (three candidate pads looked at there) |
| 19.285161, 57.727970 | 600 | the same line of objects along a track crosses the disc |
| 19.360712, 57.753102 | 500 | a straight graded track to the shore crosses the disc, a rocky patch at its east edge |
| 19.360170, 57.743951 | 500 | the same track crosses the north of the disc, inside the light pad's blend radius |
| 19.362400, 57.734000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.738000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.742000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.746000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.750000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.754000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |
| 19.362400, 57.758000 | 400 | the east-west graded track at 19.362 N (a strip of discs along it; three candidate pads looked at on it) |

### 0.3 Ka Lae: STOPPED for the lead (16 pads do not fit under the gates)

Ka Lae was re-resolved under the same gates as Madrakah except the open-ocean sector (reported, as the lead
decided): bare ground (LC-1's land-cover test), flat, clear of the shore, the sea within 6 km, no built-up land
within the class radius, the launch corridor both ways, search up to 95 km from LC-1. **Only 9 of 16 pads fit**
(LC-1 + 3 heavy + 4 medium + 1 light; 2 medium and 5 light unplaced). The old layout's pads 9-13 km west of LC-1
(round 1, section 3) all lie in one another's corridors (they were clustered east-west) and two (lc-11, lc-15) were
7-8 km inland at 661-706 m; with the corridor gate the field strings north-east along the Ka'u coast, 17-40 km from
LC-1, on bare lava from above Punalu'u towards the Ka'u Desert, and runs out of bare, flat, coastal ground there.

**LC-1 itself fails two of the new gates** (it is fixed by the design and kept): WorldCover built-up land 436 m
east-north-east of it on the South Point shore (needs 1,200 m for a heavy pad), and that patch blocks its launch
azimuth 90 deg within 12 km (nearest built-up in the sector: 0.5 km at 74 deg).

Measured alternatives (each a complete computation on the live tiles; pictures LOOKED at):

| Layout | Gates | Result | File |
|---|---|---|---|
| A | every gate (bare ground) | 9 of 16 (heavy 4 incl. LC-1, medium 4, light 1) | `data/staged/sites/candidates/ka-lae.bare-ground.json` |
| B | dry = any land but water, wetland and built-up (a measurement, not LC-1's rule) | 16 of 16 within 62.9 km, but 11 of the 15 new pads have grass or trees at the centre (pasture around South Point and above Punalu'u), and the sheet shows roads inside the outer ring of three pads | `data/staged/sites/candidates/ka-lae.any-land.json` |
| Q8 fall-back | every gate, 32 pads (8 heavy, 12 medium, 12 light) at Ka Lae, dry run | **8 of 32** (7 heavy, 1 light) | `out/bake/earth/site-bake/pads-ka-lae-q8-fallback-dryrun.json` (out/ only) |

Both candidate files carry `"candidate": true` and the unplaced counts; fleet-data must not read them (it reads
`<site>.pads.json` only, and `ka-lae.pads.json` was removed: commit f9ae0b7). The pads test checks every layout it
finds (the resolved file, else the candidates) against every gate it records, and Madrakah's against the full rule.

Decision for the lead (the design says 16 pads per site; this package does not choose): (1) accept fewer pads at Ka
Lae (layout A: 9) and give Madrakah the rest: measured, Madrakah holds 20 pads within 50 km under every gate and
the 42 exclusions when asked for 32 (8 heavy, 11 medium, 1 light, the field extended to 19.44 N; placements beyond the resolved 16 not
looked at; dry run `out/bake/earth/site-bake/pads-madrakah-32-dryrun.json`), so 9 + 20 = 29 by this greedy measure,
short of 32; (2) relax the dry gate at
Ka Lae (layout B: pads on pasture, roads to be checked pad by pad), or (3) change a gate (corridor reach or the
built-up radius). The Q8 fall-back (all 32 at Ka Lae) is not possible under these gates: 8 of 32.

Layout A, every gate (`ka-lae.bare-ground.json`, 9 pads; resolved on the live tile set f5e6ef420bda7cea):

| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Sea m | Built-up m (need) | Bare | Centre class | Ocean sector 60-130 | From nominal km |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.62 | 0.89 | 4.2 | 0.20 | 1.25 | 601 | 1001 | 436 (1200) | 0.80 | bareRock | open | 0.00 |
| lc-2 | heavy | 19.145439, -155.485194 | 18.31 | 0.45 | 5.7 | 0.21 | 1.33 | 620 | 650 | > 1500 (1200) | 0.83 | bareRock | no: 60 deg, no sea within reach | 21.50 |
| lc-3 | heavy | 19.181564, -155.446605 | 130.31 | 3.13 | 6.1 | 0.47 | 2.27 | 2049 | 2081 | 1217 (1200) | 0.81 | bareRock | no: 60 deg, no sea within reach | 27.14 |
| lc-4 | heavy | 19.203412, -155.440870 | 271.86 | 2.87 | 6.7 | 0.50 | 2.46 | 3424 | 3440 | > 1500 (1200) | 0.83 | bareRock | no: 60 deg, no sea within reach | 29.45 |
| lc-5 | medium | 19.224447, -155.430278 | 397.61 | 3.15 | 7.8 | 0.44 | 2.95 | > 3000 | 4699 | > 1500 (900) | 0.80 | bareRock | no: 60 deg, no sea within reach | 32.00 |
| lc-6 | medium | 19.248155, -155.397103 | 475.44 | 2.89 | 10.0 | 0.55 | 2.41 | > 3000 | 5607 | > 1500 (900) | 0.80 | bareRock | no: 60 deg, no sea within reach | 36.18 |
| lc-7 | medium | 19.262972, -155.378508 | 537.92 | 3.10 | 7.2 | 0.46 | 2.78 | > 3000 | 5443 | > 1500 (900) | 0.83 | bareRock | no: 60 deg, no sea within reach | 38.67 |
| lc-8 | medium | 19.275105, -155.372204 | 605.53 | 3.73 | 8.3 | 0.63 | 2.44 | > 3000 | 5946 | > 1500 (900) | 0.81 | bareRock | no: 60 deg, no sea within reach | 40.14 |
| lc-9 | light | 19.119289, -155.521192 | 19.02 | 1.62 | 7.1 | 0.36 | 2.55 | 611 | 632 | 727 (600) | 0.82 | bareRock | no: 60 deg, land at 6.0 km | 17.00 |

| Pad | Clear launch azimuths (deg, free to 12 km) | Nearest pad keep-out in the 60-130 deg sector | Nearest built-up land in the sector (to 30 km) |
|---|---|---|---|
| lc-1 | blocked at 90 | none | 0.5 km at 74 deg |
| lc-2 | 58.5-180 | none | 27.7 km at 60 deg |
| lc-3 | 41-137 | none | none within 30 km |
| lc-4 | 47.5-176 | none | 20.8 km at 69 deg |
| lc-5 | 59-180 | none | 26.6 km at 61 deg |
| lc-6 | 60-180 | none | 15.1 km at 80 deg |
| lc-7 | 44-180 | none | 13.1 km at 86 deg |
| lc-8 | 9.5-180 | none | 16.8 km at 63 deg |
| lc-9 | 60-180 | none | none within 30 km |

Layout B, dry = any land (`ka-lae.any-land.json`, 16 pads; a measurement):

| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Sea m | Built-up m (need) | Bare | Centre class | Ocean sector 60-130 | From nominal km |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.62 | 0.89 | 4.2 | 0.20 | 1.25 | 601 | 1001 | 436 (1200) | 1.00 | bareRock | open | 0.00 |
| lc-2 | heavy | 19.031892, -155.585735 | 170.33 | 1.51 | 11.5 | 0.35 | 2.10 | 1457 | 1485 | 1449 (1200) | 1.00 | grass | no: 60 deg, land at 54.0 km | 5.26 |
| lc-3 | heavy | 19.053473, -155.567750 | 153.10 | 3.10 | 10.2 | 0.51 | 2.81 | 1536 | 1552 | 1208 (1200) | 1.00 | grass | no: 60 deg, land at 45.4 km | 8.22 |
| lc-4 | heavy | 19.143824, -155.491193 | 15.11 | 0.48 | 5.0 | 0.15 | 1.08 | 660 | 680 | 1822 (1200) | 1.00 | grass | no: 60 deg, no sea within reach | 20.99 |
| lc-5 | medium | 19.010848, -155.592015 | 32.48 | 1.64 | 7.0 | 0.31 | 1.77 | 902 | 949 | 914 (900) | 1.00 | trees | open | 2.85 |
| lc-6 | medium | 18.950141, -155.635378 | 37.43 | 2.30 | 7.7 | 0.44 | 2.12 | 613 | 636 | 1085 (900) | 1.00 | grass | open | 5.36 |
| lc-7 | medium | 19.179405, -155.446036 | 113.83 | 3.15 | 6.8 | 0.47 | 2.12 | 1858 | 1860 | 1006 (900) | 1.00 | bareRock | no: 60 deg, no sea within reach | 26.98 |
| lc-8 | medium | 19.191283, -155.454309 | 176.24 | 3.51 | 7.9 | 0.59 | 2.87 | 3358 | 3434 | 1187 (900) | 1.00 | trees | no: 60 deg, no sea within reach | 27.53 |
| lc-9 | medium | 19.204773, -155.454582 | 262.33 | 2.83 | 10.9 | 0.54 | 3.31 | > 3000 | 4482 | 912 (900) | 1.00 | grass | no: 60 deg, no sea within reach | 28.76 |
| lc-10 | medium | 19.218262, -155.453713 | 334.85 | 3.11 | 8.0 | 0.47 | 2.84 | > 3000 | 5552 | 927 (900) | 1.00 | grass | no: 60 deg, no sea within reach | 30.08 |
| lc-11 | light | 19.119019, -155.522620 | 17.93 | 1.73 | 11.6 | 0.42 | 3.43 | 620 | 650 | 611 (600) | 1.00 | bareRock | no: 60 deg, land at 6.0 km | 16.90 |
| lc-12 | light | 19.226079, -155.445134 | 391.28 | 3.48 | 7.0 | 0.54 | 2.45 | > 3000 | 5604 | 1087 (600) | 1.00 | grass | no: 60 deg, no sea within reach | 31.30 |
| lc-13 | light | 19.233088, -155.439127 | 442.78 | 2.71 | 7.2 | 0.39 | 1.86 | > 3000 | 5972 | 1129 (600) | 1.00 | grass | no: 60 deg, no sea within reach | 32.29 |
| lc-14 | light | 19.268101, -155.380788 | 566.53 | 3.32 | 6.9 | 0.57 | 2.49 | > 3000 | 5988 | > 1500 (600) | 1.00 | bareRock | no: 60 deg, no sea within reach | 38.98 |
| lc-15 | light | 19.276991, -155.370200 | 612.98 | 3.88 | 5.7 | 0.58 | 1.93 | > 3000 | 5999 | > 1500 (600) | 1.00 | bareRock | no: 60 deg, no sea within reach | 40.44 |
| lc-16 | light | 19.335624, -155.131657 | 668.80 | 4.00 | 7.6 | 0.57 | 2.12 | > 3000 | 5727 | > 1500 (600) | 1.00 | grass | no: 60 deg, no sea within reach | 62.86 |

| Pad | Clear launch azimuths (deg, free to 12 km) | Nearest pad keep-out in the 60-130 deg sector | Nearest built-up land in the sector (to 30 km) |
|---|---|---|---|
| lc-1 | blocked at 90 | none | 0.5 km at 74 deg |
| lc-2 | 50-150.5 | none | none within 30 km |
| lc-3 | 36.5-180 | none | none within 30 km |
| lc-4 | 54.5-180 | lc-16 at 43.4 km, 60 deg | none within 30 km |
| lc-5 | 53.5-130.5 | none | none within 30 km |
| lc-6 | 60-173 | none | none within 30 km |
| lc-7 | 36.5-130 | lc-16 at 37.3 km, 62 deg | none within 30 km |
| lc-8 | 44-130 | lc-16 at 37.5 km, 65 deg | none within 30 km |
| lc-9 | 49.5-153.5 | lc-16 at 36.9 km, 67 deg | none within 30 km |
| lc-10 | 60-162 | lc-16 at 36.2 km, 69 deg | 28.9 km at 62 deg |
| lc-11 | 58.5-180 | none | none within 30 km |
| lc-12 | 57.5-173 | lc-16 at 35.1 km, 70 deg | 27.8 km at 62 deg |
| lc-13 | 60-179.5 | lc-16 at 34.2 km, 70 deg | 26.5 km at 61 deg |
| lc-14 | 60-180 | lc-16 at 27.2 km, 74 deg | 13.1 km at 89 deg |
| lc-15 | 9-180 | lc-16 at 25.9 km, 75 deg | 18.1 km at 65 deg |
| lc-16 | 0-142.5 | none | 15.0 km at 84 deg |

Pad sheets (2.6 km crops at level 12, flat / blend / built-up rings, corridor edges; and the corridors over the
field): `out/bake/earth/site-bake/pads-ka-lae-allgates-{sheet,corridors}.png` (layout A),
`pads-ka-lae-anyland-{sheet,corridors}.png` (layout B).

### 0.4 The land source: Copernicus GLO-30 replaces SRTM (Terrarium)

Test (before the re-bake): Copernicus DEM GLO-30 (1 arc-second, TanDEM-X 2011-2015, edited, EGM2008 like ETOPO; 8
public tiles from the AWS bucket `copernicus-dem-30m`) against the SRTM-based Terrarium z14 tiles, both carried to
the level-12 vertex grid the same way, at three points of the new pad field on the coastal plain (19.15, 19.25,
19.35 N), 600 m (pad level) and 2 km across, imagery | SRTM hillshade x3 | GLO-30 hillshade x3:

![GLO-30 against SRTM at pad level, 19.25 N](../../out/bake/earth/site-bake/glo30-vs-srtm-p1925-600m.png)
![GLO-30 against SRTM, 2 km, 19.25 N](../../out/bake/earth/site-bake/glo30-vs-srtm-p1925-2km.png)

(`out/` is not committed: the pictures are on this machine, with the 19.15 and 19.35 N pairs beside them.)

| Point | Source | RMS finer than 30 m (m) | RMS curvature 10 m (m) | Slope median / p95 (deg) |
|---|---|---|---|---|
| 19.15 N 57.72 E | SRTM | 0.275 | 0.228 | 2.65 / 5.67 |
| | GLO-30 | 0.160 | 0.115 | 1.16 / 3.99 |
| 19.25 N 57.72 E | SRTM | 0.232 | 0.180 | 2.17 / 4.66 |
| | GLO-30 | 0.094 | 0.076 | 0.79 / 2.03 |
| 19.35 N 57.73 E | SRTM | 0.239 | 0.186 | 2.21 / 4.74 |
| | GLO-30 | 0.071 | 0.061 | 0.50 / 1.14 |

What the pictures show: the SRTM surface carries a blocky, diagonally streaked texture of about 0.25 m RMS that does
not follow the imagery (a gravel plain with a median slope of 2.2-2.7 deg); GLO-30 is clean and its shallow
channels lie where the imagery's wadis are. **GLO-30 was used** for land and inland water of the whole region
(`sources.height.id` "copernicus-glo30"; `tools/bake/earth/glo30.py`). Licence: the Copernicus DEM GLO-30 public
licence (free of charge, worldwide, any use, with attribution); the manifest's source and attribution lines read
"produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018
provided under COPERNICUS by the European Union and ESA; all rights reserved" (the region file's `credit` and
`attribution`); the Terrarium/SRTM attribution of the region is removed from the manifest by the replace.

On the baked tiles at the new pads (`bake.py quality`, one pad per class, every number on the level-12 collision
surface within 2 km of the pad, 10 m grid; columns as section 5; the cliffed shore lies within 2 km of each, and its
3-7 % of slopes above 16 deg dominate the RMS columns, the medians are the plain):

| Pad | Class | RMS diff 10 / 30 / 100 m | RMS curvature 10 / 30 m (ratio) | Finer than 30 m RMS | Slope median / p95 deg | Slope histogram 0-1/1-2/2-4/4-8/8-16/16-32/>32 % | Albedo neighbour RMS (sRGB) |
|---|---|---|---|---|---|---|---|
| lc-1 | heavy | 1.37 / 4.03 / 12.21 | 0.330 / 2.256 (0.15) | 0.48 | 1.9 / 26.1 | 18/35/25/8/4/7/3 | 10.4 |
| lc-5 | medium | 1.18 / 3.19 / 6.89 | 0.391 / 1.947 (0.20) | 0.53 | 0.9 / 12.2 | 59/29/5/1/2/3/2 | 7.1 |
| lc-11 | light | 1.56 / 3.94 / 7.22 | 0.491 / 2.233 (0.22) | 0.69 | 0.6 / 1.8 | 85/10/0/0/0/1/3 | 6.8 |

Inside the pad discs the GLO-30 plain is smooth: roughness at 10 m 0.07-0.24 m, plane RMS 0.2-1.5 m (section 0.2).
A hillshade with relief x3 shows a faint even dimple texture at the source's 30 m grid (amplitude about 0.1 m); in the
imagery lit by a 45 deg sun (relief x1) it is not visible. Pictures: `out/bake/earth/site-bake/quality-madrakah-{overview,lc-1-*,lc-5-*,lc-11-*}.png`
(regenerated on the GLO-30 tiles; LOOKED at: lc-5 at 2 km).
**Q8 decision unchanged and stronger: keep the Madrakah site** (the source swap that section 5 named as the remedy
is done; the fall-back to Ka Lae is not possible under the new gates, section 0.3).

### 0.5 The Madrakah re-bake (one more bake, REPLACE swap)

Same region, levels, coverage, imagery sources and pipeline as round 1 (section 4), with four changes, all region
options of `data/defs/regions/earth-madrakah.json` (Ka Lae's configuration hashes unchanged):

1. **Land source GLO-30** (section 0.4) instead of Terrarium/SRTM; `resolutionM` 30 as before (sourceCoverage at
   levels 8-11, level 12 carries the level-11 procedural detail); `despikeBelow` kept.
2. **Near-shore sea floor, the lead's rule** (`seaFloorNearShore` "deeper", `regsrc.py`): within 1.5 km of the
   WorldCover coastline ETOPO counts only where it is itself sea deeper than the ramp, otherwise the ramp; the ramp
   is 1:50 (`nearShoreSlope` 0.02, was 1:25) held at 30 m beyond 1.5 km; between 1.5 and 3 km the floor becomes
   ETOPO. Round 1 blended ETOPO in from the coast, and ETOPO's coarse coast lies up to 1.3 km offshore of the real
   one along this coast, so the floor sat at -1 m for a kilometre. A first version of the re-bake (ETOPO weighted
   by its own depth, 1:25 ramp) was stopped after its heights because LOOKING at the profile showed a sill (the
   ramp at -39 m 1 km out, ETOPO's -3.5 m at 1.3 km); 1:50 is the slope that meets ETOPO's own offshore gradient
   without one. Profiles eastward from the coast (m below sea level; source formula on the region's grids):

   | Latitude | 0 m | 250 m | 500 m | 1 km | 1.5 km | 2 km | 3 km | 5 km | ETOPO at 1 km |
   |---|---|---|---|---|---|---|---|---|---|
   | 19.0 N (the headland) | 1.3 | 4.2 | 13.4 | 15.3 | 20.8 | 26.2 | 28.5 | 41.4 | 15.3 |
   | 19.075 N | 1.2 | 4.9 | 9.6 | 18.8 | 26.4 | 28.9 | 54.7 | 36.4 | 1.0 |
   | 19.15 N | 1.2 | 4.8 | 9.7 | 19.5 | 29.4 | 36.2 | 39.2 | 20.1 | 15.6 |
   | 19.25 N | 1.3 | 5.6 | 10.6 | 20.7 | 30.0 | 27.7 | 39.7 | 45.2 | 1.0 |
   | 19.35 N | 1.2 | 4.6 | 9.3 | 18.2 | 26.6 | 29.8 | 31.2 | 40.0 | 15.6 |
   | 19.45 N | 1.2 | 3.8 | 6.6 | 10.6 | 21.4 | 34.6 | 42.4 | 41.9 | 8.5 |

   Known consequence: in the shallow bay south-west of the headland (ETOPO about -10 m) the floor within 3 km of
   the shore is up to 20 m deeper than ETOPO (18.95 N: -30 m at 2.5 km against ETOPO's -8 m).
3. **False inland water** (`watermask.inlandMaxRangeM` 2.5, `inlandMaxSlopeDeg` 5, `inlandMinAreaM2` 2,000): a
   WorldCover water component not connected to the sea (20 m cells) becomes land when the land source under it
   spans more than 2.5 m (5th to 95th percentile), its mean slope exceeds 5 deg, or it is smaller than 2,000 m2.
   4,035 components, 3,075 made land (5.90 km2), mostly specks of a few WorldCover pixels beside tracks and dark
   rock on the headland's hills. The two points of the review: 19.00601 N 57.81562 E (dark rock on a hillside) is
   land; 18.99051 N 57.80224 E was three specks of 92 m2 together on a gravel plain beside a track (LOOKED at:
   `out/bake/earth/site-bake/water-18.99051-57.80224.png`), now land.
4. **De-shading refit on the GLO-30 normals** (level 10, slopes above 10 deg, ground above 5 m).

Bake facts: `bake.py stage --region earth-madrakah --replace` through the bake gate with 4 workers (06:39-08:31 after
a wait for the slot; the first attempt, 06:03-06:33, was stopped after its heights and water mask, above). WorldCover re-read (572
water components, 1 the ocean); 8 GLO-30 tiles; level-12 corrections: no tile-edge pockets (GLO-30 has none), one
downward needle removed (10 vertices in 1 tile, a pit 16 m deep at 19.14404 N 57.80163 E on the shore); 60,360
Sentinel-2 requests again (the round-1 downloads had been cleaned up; 78 min at 12 per second); colour match land
gains (0.946, 1.175, 1.615), water (0.216, 0.248, 0.630). Staged: 53,140 tiles, 0.42 GB. The staged region was
checked for `.partial` and empty files before the swap (none). LOOKED at after the bake on the staged tiles: the
19.075 N profile (-0.5 m at the coast, -9.8 m at 500 m, -18.4 m at 1 km, -26.6 m at 1.5 km, -28.6 m at 2 km, -54.3 m at
3 km) and both review points are land (water mask 0).

### 0.6 Verify, measured

`python -I tools/bake/earth/verify.py --region earth-madrakah` (through the bake gate), staged before the swap and
live after it: **24 of 27 pass, 2 WAIVED BY THE LEAD, 1 fails** (live; staged: 23 pass, the 24th was the old pads file
against the new heights). Passing: 53,140 files present and decoded, no alpha, pyramid complete, pads (16 pads,
level-12 height within 0.02 m of padElevation, every pad passes the rule), sourceCoverage, shared height edges
identical, albedo seams at levels 8, 9, 10, 12, coverage edges at every level, coastline at every level, no inland
pits, no needles, TypeScript decode.

- **WAIVED BY THE LEAD: `no baked hillshade`** (the region's `verifyWaivers`, as the lead decided). The refit on the
  GLO-30 normals gave alpha +0.412 (east), beta -0.298 (north) from 93,577 texels (round 1 on SRTM: +0.257 / -0.174
  from 73,789). Paired east/west and north/south brightness of slopes above 5 deg against their 300 m surroundings
  (need 1 +/- 0.03):

  | Within 10 km of | Level 10 E/W, N/S | Level 12 E/W, N/S |
  |---|---|---|
  | the headland (round-1 reference pad 18.996 N 57.794 E), round 1 (SRTM) | 1.205, 0.954 | 1.099, 0.984 |
  | the headland, re-bake (GLO-30), staged | 1.286, 1.017 | 1.313, 0.947 |
  | the new field's reference pad (19.078 N 57.787 E), re-bake, live | 1.482, 1.129 | 1.513, 1.039 |

  The ratio got larger, not smaller, although the correction is 60 % stronger. The likely reason is the selection:
  on SRTM many of the "slopes above 5 deg" were noise on flat gravel, where the imagery has no shading, which pulled
  the ratio toward 1; on GLO-30 the selected slopes are real, and the morning-sun shading on them is larger than a
  Lambertian correction within its bounds removes. The lead decides (accept the residual shading, or ask for a
  different de-shading).
- **FAIL: `albedo seams` level 11**: border excess +0.0367 sRGB levels against a 2-s.e. bound of 0.0310 (300 borders;
  round 1 +0.033 against 0.031). The same statistical excess as in round 1 (section 8: about 1-2 % of the neighbour
  difference; a real seam is about 60 %); not waived.

### 0.7 The REPLACE swap: exactly what changed

`bake.py stage --region earth-madrakah --replace` baked the region under `data/cache/earth/stage/earth-madrakah/` with
the live tiles readable throughout (routing only in processes with `EARTH_STAGE_REPLACE=earth-madrakah`);
`bake.py swap` then (1) built the prospective manifest and checked it against the live one (the region's
rectangles unchanged, its source and attribution lines replaced: the Terrarium/SRTM line removed, GLO-30's added),
(2) refused unless the staged files are exactly the region's tile paths (`swaptree.replace_tree`: 53,140 = 4 layers x
13,285; nothing outside the region's rectangles), (3) replaced each live file with `os.replace` (atomic per file,
same volume), (4) checked the 750,486 promised tiles present and (5) wrote the manifest once, atomically. Manifest
contentHash **f70a61d55dca902f -> f5e6ef420bda7cea** (09:44:33). A concurrent reader polled the live manifest for
462 s across the swap: 174 reads (159 of the old manifest, 15 of the new), 0 failed reads, 9,246,360 existence
checks of promised Madrakah tiles, 0 missing. The tiles were replaced over 73 s before the manifest changed: during
that window a reader under the old manifest could load a mix of old and new Madrakah tiles (the price of replacing
in place without versioned paths; a running app that loaded Madrakah tiles in that window should reload them).

**Changed directories** (full form: names, bytes and content of every file, the terrain guard's own summary, taken
before and after the swap): Earth 9,220 directories, **507 changed, 8,713 unchanged, 0 added, 0 removed**; Moon 2,344
unchanged. The 507 are `.` (`manifest.json`, 21,925 -> 22,126 bytes) and 506 of the region's 840 column directories
`{layer}/2/{level}/{x}` (the other 334, over open sea, came out byte-identical):

| Layer | Level | Changed | x |
|---|---|---|---|
| height | 8 | 4 | 44-47 |
| height | 9 | 8 | 88-95 |
| height | 10 | 15 | 176-190 |
| height | 11 | 29 | 353-381 |
| height | 12 | 56 | 707-762 |
| albedo | 8 | 9 | 43-51 |
| albedo | 9 | 13 | 87-95, 99-102 |
| albedo | 10 | 20 | 175-190, 199-202 |
| albedo | 11 | 36 | 352-381, 398-403 |
| albedo | 12 | 67 | 706-763, 797-805 |
| watermask | 8 | 8 | 43-50 |
| watermask | 9 | 9 | 88-95, 100 |
| watermask | 10 | 18 | 176-190, 199-201 |
| watermask | 11 | 32 | 352-380, 399-401 |
| watermask | 12 | 55 | 706, 709-760, 799-800 |
| landcover | 8 | 8 | 43-50 |
| landcover | 9 | 11 | 87-95, 99-100 |
| landcover | 10 | 19 | 175-190, 199-201 |
| landcover | 11 | 32 | 352-380, 399-401 |
| landcover | 12 | 57 | 706-760, 799-800 |

Nothing outside the region's rectangles changed. The terrain guard (run after the swap): heights at the stored
directions change only in the place group `site:madrakah` the lead appended (f072a36): 497 of its 800 points on
the collision query, 525 on the band-limited one (the new land source; no uniform direction lies in the region's
coverage, the nearest is 226 km from its centre); the directory test fails on the directories
above. The lead re-records both and the mission golden's earth hash (f5e6ef420bda7cea; request site-bake-1).
Region size: 53,140 files, 422,475,736 bytes (round 1: 461,133,283): height 187.8 MB, albedo 224.2 MB, landcover
8.9 MB, watermask 1.6 MB.

### 0.8 Files, tests, disk

- Commits of this round: f9ae0b7 (Ka Lae withdrawn, candidates, sea floor rule, inland specks), 540d8d4 (strict
  ocean pre-filter), a0c258b (Madrakah pads), ec38893 (cleanup), and the commit of this hand-off with the test.
- `tests/unit/site-bake/pads.test.ts` checks every layout it finds: the resolved file of a site, else its candidate
  layouts (complete or with the unplaced counts). Gates as recorded, with `bareFraction` the dry gate (`rule.dry`
  "bareGround"; a candidate measured with "anyLand" is checked on `dryFraction`); the full rule (open ocean) at
  Madrakah only; built-up clearance by class; corridors both ways and a clear 60-130 deg sector for every resolved
  pad (a fixed pad, LC-1, is reported); `tilesetContentHash` equal to the live manifest's; and an independent
  re-measurement with the real TerrainProvider. Result: site-bake 20 of 20 (`npx vitest run tests/unit/site-bake`, after the swap: Madrakah and both Ka Lae candidates; the TerrainProvider re-measurement on the live tiles: Madrakah heights within 0.31 m of padElevation, steepest 500 m disc 1.32 deg; Ka Lae layout A 0.25 m, 3.73 deg; layout B 1.49 m, 4.00 deg). Terrain guard after the swap: 5 of 7, the two failures are the lead's re-record (section 0.7).
- Disk: free 33 GB after the cleanup (36.6 GB at 10:15; lowest during the round 26 GB, at 09:58, while other packages were writing too); `data/cache/earth` 0.92 GB as found (6.33 GB of downloads and intermediates deleted); the region's tiles 0.42 GB (0.04 GB less than round 1).

### 0.9 What the next packages must know (replaces section 11 where they differ)

- **fleet-data**: take Madrakah's pads from `data/staged/sites/madrakah.pads.json` (format of section 1, plus
  `tilesetContentHash`, `corridors` and the rule fields `strict`, `dry`, `padRadii`, `builtUpMarginM`, `corridor`,
  `excluded`). **Do not take Ka Lae's pads yet**: there is no `ka-lae.pads.json` until the lead decides (section
  0.3); the candidate files in `data/staged/sites/candidates/` are not layouts to consume. Pads face 90 deg. The
  pads were resolved for the radii of `rule.padRadii` (flat / blend / keep-out: heavy 450 / 900 / 600, medium 300 /
  600 / 450, light 150 / 300 / 300 m): larger radii need a re-resolve.
- **fleet-models-pads**: Madrakah's field is the gravel and ophiolite coastal plain north of Ras Madrakah, between
  the cliffed shore and the inland plain, strung north-south over about 32 km (19.08-19.37 N); no built-up land
  within 6 km of lc-4 to lc-16, 2.4-5.3 km from lc-1 to lc-3, none in any pad's launch sector within 30 km. Round 1's "town 2-4 km south-east of the southern pads" was
  wrong: WorldCover built-up land lay 0.44 km east of round-1 lc-4 and 0.64 km south-east of lc-1, scattered
  patches around the headland rather than one town.
- **planet-render**: level-12 edge continuity of the height authority at Madrakah is NOT yet checked by the
  provider test (`tests/unit/terrain-core/realData.test.ts` fails on its tile-cache budget since the region was
  added: request site-bake-2); `verify.py --region` checks the coverage edges with the bake's own reader. Ground
  checkpoints at one pad per class: lc-1 (heavy, 19.078 N, dark ophiolite gravel), lc-5 (medium, 19.247 N), lc-11
  (light, 19.318 N); look for the faint 30 m dimple texture of the GLO-30 grid (section 0.4) and the residual relief
  shading of the imagery on the headland's hills (section 0.6).
- **The lead**: decide Ka Lae (section 0.3) and the hillshade waiver (section 0.6); audit the changed directories
  (section 0.7), re-record the terrain guard and update the mission golden's earth hash (request site-bake-1).

### 0.10 Lead decisions of 2026-11-12 (on the report of this round) and what followed

Recorded as the lead decided them:

1. **LC-1 is fixed.** It is the site of the original mission (the golden flight, the terrain guard's points and the
   vehicle-pad ground survey are built on it): it stays at its exact v1 position and elevation as pad `lc-1`, class
   heavy, exempt from the gates. Its gate results are written to the pads file as reported only (`rule.fixed`, with
   the reason); the WorldCover built-up land 436 m from it is the complex's own ground (the complex was built
   there). Every other pad's keep-out and corridor gates still respect LC-1.
2. **Dry gate for new pads at Ka Lae:** bare ground, grassland or shrubland (pasture is cleared inside the fence).
   Never tree cover, cropland, built-up, wetland or water inside the outer ring (the class's built-up radius:
   heavy 1,200, medium 900, light 600 m); no mapped or visible road or track inside the outer ring; the built-up
   distance gate and the corridor gates unchanged. The land-cover fractions inside the pad footprint (flat radius)
   and the outer ring are recorded per pad, so the ground cover can be cleared there (fleet-data and the terrain
   renderer read them).
3. **Compact:** placements nearest LC-1, search to 40 km, up to 16 with Madrakah's class mix, shed from the light
   end if fewer fit; at least 12: take them; under 12: stop and report the count per radius. Every placement looked at.
4. **The Q8 fall-back (all pads at one site) is dropped:** the pad count per site is data, and two sites exist.
5. **Madrakah relief shading in the imagery** (E/W 1.48-1.51 near the pads, 1.29-1.31 on the headland): accepted as
   a known limit, no further de-shading work now. The pads stand on a plain of 0.04-1.3 deg where it cannot show; the
   cliffs and wadi banks will be judged in the engine by the visual critic when Madrakah is first rendered
   (planet-render / fleet-models-pads), and a different de-shading is decided there from pictures. The check keeps
   reporting its numbers, waived by the lead with this reason (`verifyWaivers`).
6. **Level-11 albedo seam statistic** (+0.037 against 0.031 sRGB levels): waived for this region at the measured
   value (a twenty-seventh of one display level is far below visibility; the bound came from a measurement, not a
   visibility threshold). The bound stays for every other region. Implemented as a bounded waiver: `verifyWaivers`
   entries may be `{"reason", "upTo"}`, and the seam waiver covers the check only while the excess stays at or below
   0.037.
7. The line on faint tracks and rills stands.

**What followed.**

- `padresolve.py` / `bake.py pads`: `--dry-classes` (the disc's allowed land cover), `--forbid-outer` (land cover
  never allowed inside the outer ring: a distance gate per class, like built-up, on the grid and exactly),
  `--fixed-reason` (recorded in `rule.fixed` with the fixed pad's gate results, reported only), `--accept-min`
  (write a layout of at least N pads when only light pads are missing: `shed`). Every pad now records
  `report.landCover.{footprint,outerRing}` = {radiusM, fractions per class}, `allowedFraction` (the dry gate),
  `bareFraction` (bare ground alone), `forbiddenM` / `forbiddenClass`; the rule records `dryClasses`,
  `forbiddenInOuterRing` and `fixed`. The pre-filter logs the candidate cells left after each gate by radius.
- **Madrakah** re-resolved with the same arguments to carry the new fields: positions, elevations and ids identical
  (checked), tile-set hash f5e6ef420bda7cea. Its rule is unchanged (bare ground; no outer-ring land-cover gate: the
  lead's rule 2 is Ka Lae's). Outer rings by the shore hold 4-13 % sea; footprints are bare rock and sand only.
- **Ka Lae under the lead's rule: STOPPED again, 8 pads within 40 km (under 12).** Command: `bake.py pads --region
  earth-ka-lae --site ka-lae --nominal 18.987556,-155.603239 --fixed lc-1:heavy:18.987556:-155.603239:21.62
  --fixed-reason ... --search-km 40 --dry-classes bareRock,sand,sparseScrub,grass,shrub --forbid-outer
  trees,crop,builtUp,wetland,water --accept-min 12 --allow-partial --dry-run`
  (`out/bake/earth/site-bake/pads-ka-lae-lead-40km.json`). Placed: LC-1, 1 heavy, 0 medium, 6 light; 2 heavy and
  6 medium found no place. The placements were not looked at (the rule stops under 12 before that).

  | Pad | Class | Lat, lon | Elevation m | From LC-1 km | Footprint land cover | Outer ring land cover | Clear azimuths |
  |---|---|---|---|---|---|---|---|
  | lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.62 | 0 | bare rock 81 %, trees 13 %, grass 6 % | bare rock 54 %, trees 31 %, grass 8 %, water 4 %, built-up 0.6 % | blocked at 90 (reported) |
  | lc-2 | heavy | 19.228242, -155.365031 | 165.3 | 36.6 | bare rock 99 % | bare rock 98 %, grass 2 % | 0-180 |
  | lc-3 | light | 18.950771, -155.634712 | 36.8 | 5.3 | grass 100 % | grass 99.5 % | 59.5-178 |
  | lc-4 | light | 19.030902, -155.581073 | 158.0 | 5.4 | grass 100 % | grass 100 % | 29.5-169 |
  | lc-5 | light | 19.161428, -155.458239 | 49.7 | 24.6 | grass 100 % | grass 100 % | 58.5-180 |
  | lc-6 | light | 19.179491, -155.441656 | 120.2 | 27.3 | bare rock 100 % | bare rock 99.8 % | 60-154 |
  | lc-7 | light | 19.254428, -155.378139 | 486.1 | 37.9 | bare rock 99.7 % | bare rock 83 %, grass 17 % | 59-143.5 |
  | lc-8 | light | 19.264682, -155.379554 | 550.3 | 38.8 | bare rock 100 % | bare rock 80 %, grass 20 % | 6.5-151 |

  Count per radius (pads of this layout within the radius of LC-1): 5 km 1 (LC-1), 10 km 3, 20 km 3, 30 km 5, 40 km
  8. Beyond 40 km almost nothing passes the gates: candidate cells after every pre-filter gate, 40 km 18,142, 60 km
  18,202, 95 km 18,482 (30 m cells; a 95 km run was stopped once this showed).

  The binding gate is the launch corridor's built-up test (60-130 deg to 12 km free of built-up land). Candidate cells
  left after each gate, by radius (`pads: pre-filter funnel` in `out/bake/earth/site-bake/kalae-r95.log`):

  | Within | Land, height, shore, flat | + dry (bare, grass, shrub) | + coast (sea within 6 km) | + built-up clearance | + outer ring land cover | + corridor free of built-up |
  |---|---|---|---|---|---|---|
  | 5 km | 39,292 | 11,743 | 11,743 | 11,584 | 8,329 | **0** |
  | 10 km | 133,640 | 70,572 | 60,151 | 49,630 | 35,679 | **1,351** |
  | 20 km | 308,466 | 179,558 | 125,009 | 111,564 | 82,351 | **1,351** |
  | 40 km | 753,652 | 510,475 | 246,702 | 226,199 | 124,210 | **18,142** |

  What blocks the corridors near LC-1 (land probes every 1.5 km within 12 km of LC-1: 86 of 92 blocked): many
  separate WorldCover built-up patches east of the probes, the nearest in a sector being LC-1's own ground (0.4 km
  from LC-1) for 11 probes, patches 2.0, 2.9, 4.4, 7.0-7.9 and 10.9 km from LC-1 for the others (farms, houses and
  roads of Ka'u). Exempting LC-1's own ground alone would not open the field. The lead's choice: a shorter corridor
  reach or a corridor built-up gate that ignores small patches at Ka Lae, a larger radius, or 8 pads.
- No `ka-lae.pads.json` is written. The two round-2 candidate files were deleted (superseded by decisions 2 and 3; the staged deletion was carried into history by another package's commit, 1f5c754).
- `tests/unit/site-bake/pads.test.ts`: checks the resolved layouts (Madrakah; Ka Lae when it exists) and that no
  candidate file is left; the dry classes and the outer-ring land cover per site; land-cover fractions for every pad;
  `rule.fixed` and LC-1 pinned to the v1 site value (when Ka Lae is resolved); classes shed only from the light end
  and at least 12. The block that reads baked tiles (the live tile-set hash, the TerrainProvider re-measurement) is
  `describe.skipIf(!HAS_EARTH)`: skipped explicitly where `data/tiles/earth/manifest.json` is absent (CI), never
  passed silently (request platform-delivery-1, noted there).
- Verify and tests after these changes: `verify.py --region earth-madrakah` (live) **24 of 27 pass, 3 waived by the lead (relief shading at levels 10 and 12, the level-11 albedo seam at +0.0367 <= 0.037), 0 failed**; `npx vitest run tests/unit/site-bake` 9 of 9 (Madrakah's TerrainProvider re-measurement: heights within 0.31 m of padElevation, steepest disc 1.32 deg).

### 0.11 Lead decision on Ka Lae's corridor (2026-11-12, second) and the result: STOPPED, 10 pads within 25 km

The lead's decision, recorded as the lead's: the corridor's built-up test was written for an empty desert coast; on an
inhabited island it rejects a field the terrain itself allows. The range at Ka Lae is fiction on real ground:
scattered farm buildings and roads downrange are accepted; settlements are not. For Ka Lae only (Madrakah's rule
unchanged; per-site rule fields):

1. **Corridor, built-up part:** a SETTLEMENT is any 300 m x 300 m window in which at least 10 % of the WorldCover
   cells are built-up (a road crossing it is about 3 %, a farmstead about 3 %; a hamlet passes 10 %). A pad's 60-130
   deg sector must hold no settlement within 5 km. LC-1's own complex ground (within 600 m of LC-1) is excepted
   everywhere (the corridor and the any-direction built-up gate). Beyond 5 km, and built-up below the threshold, is
   reported per pad (nearest settlement in the sector, nearest built-up cell in the sector), not gated. The pads'
   keep-out part of the corridor, the dry gate (bare, grass or shrub; nothing forbidden inside the outer ring), the
   slope, spacing and any-direction built-up gates are unchanged.
2. **Compact:** within 15 km of LC-1 first, up to 16 (4 heavy with LC-1, 6 medium, 6 light; shed from the light
   end); under 12 there, extend to 25 km, not further; under 12 at 25 km, stop and report.
3. Look at every placement; then write `ka-lae.pads.json`.

Implemented (`padresolve.py`, `bake.py pads`): `--settlement-reach-km 5` (the settlement test: land cover sampled at
10 m on the candidate grid's frame, a 10 m cell is in a settlement when its centred 300 m window holds >= 10 %
built-up, a 30 m grid cell is a settlement cell when any of its nine 10 m cells is; the gate is the sector of the
grid node, exactly as the pre-filter's FFT; the corridor table adds `nearestSettlementInSector20km`), `--own-ground
18.987556:-155.603239:600` (excepted from every built-up test); recorded in `rule.corridor.settlement` and
`rule.ownGround`. Settlements in the 25 km field: 3.8 km2 of 10 m cells.

**Result: under 12 at both radii, so STOPPED (not looked at, no `ka-lae.pads.json`).**

- Within 15 km: **5 pads** (LC-1, 2 heavy, 2 light; `out/bake/earth/site-bake/pads-ka-lae-settle-15km.json`).
- Within 25 km: **10 pads** (LC-1, 3 heavy, 2 medium, 4 light; 4 medium and 2 light found no place;
  `pads-ka-lae-settle-25km.json`). Of these: 5 within 10 km, 5 within 15 km, 9 within 20 km, 10 within 25 km.

| Pad | Class | Lat, lon | Elev m | From LC-1 km | Footprint land cover | Outer-ring land cover | Clear azimuths | Nearest settlement in sector | Nearest built-up cell in sector |
|---|---|---|---|---|---|---|---|---|---|
| lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.6 | 0.0 | bareRock 81%, trees 13%, grass 6% | bareRock 54%, trees 31%, grass 8%, water 4%, sand 2%, builtUp 1% | blocked | 0.8 km at 88 | 0.6 km at 72 |
| lc-2 | heavy | 18.964261, -155.634430 | 77.7 | 4.2 | grass 100% | grass 100% | 60-180 | none | 3.6 km at 80 |
| lc-3 | heavy | 18.946451, -155.651827 | 83.5 | 6.9 | grass 100% | grass 100% | 56-180 | none | 1.9 km at 110 |
| lc-4 | heavy | 19.008990, -155.752862 | 81.3 | 15.9 | bareRock 100% | bareRock 100% | 30-180 | 12.1 km at 73 | 7.9 km at 122 |
| lc-5 | medium | 18.993334, -155.762263 | 45.1 | 16.7 | bareRock 100% | bareRock 100% | 47.5-180 | 13.6 km at 67 | 8.1 km at 109 |
| lc-6 | medium | 19.038391, -155.760879 | 264.5 | 17.5 | bareRock 100% | bareRock 100% | 13-130 | 12.4 km at 89 | 5.7 km at 60 |
| lc-7 | light | 19.030902, -155.581073 | 158.0 | 5.4 | grass 100% | grass 100% | 22-180 | none | none |
| lc-8 | light | 18.930802, -155.654960 | 45.3 | 8.3 | grass 100% | grass 100% | 45-180 | none | 0.7 km at 100 |
| lc-9 | light | 19.023833, -155.747167 | 195.1 | 15.7 | bareRock 100% | bareRock 100% | 0-179.5 | 11.1 km at 80 | 7.8 km at 60 |
| lc-10 | light | 19.164688, -155.490512 | 72.1 | 23.0 | grass 100% | grass 100% | 30.5-180 | none | 5.5 km at 80 |

The settlement test no longer binds: within 20 km 78,890 candidate cells pass every pre-filter gate (83,508 before
the corridor test). What limits the count now is the ground and the row geometry: in the 25 km run the explicit
evaluations rejected 772 candidates for relief, 264 for slope, 246 for forbidden land cover in the outer ring
and 100 for built-up land, and every pad must lie outside every other pad's 60-130 deg sector both ways, so the
pads string north-south across the launch direction; at the island's south tip such a row likely runs into the
sea, the Kahuku pali and the tree-covered slopes within a few kilometres. The lead's choice: accept 10 pads at Ka
Lae, a search beyond 25 km (the row continues north-east along the Ka'u coast: round 2's field), or a change to the
row geometry (for example a corridor sector narrower than 60-130 deg for the pads' keep-out part).

### 0.12 Ka Lae resolved (the lead accepted the 25 km field, 2026-11-12, third) and the close of the package

The lead's decision, recorded as the lead's: accept the 25 km layout (the ground, not a rule, limits the field;
26 pads over two sites is enough; the count per site is data); no wider search and no narrower keep-out sector; look
at every placement, exclude with reasons, re-resolve within 25 km when one falls; fewer accepted down to 8 without
asking.

**The look.** Every placement was rendered at level 12 (imagery and hillshade, 1.4 km; the 2.6 km sheet for the outer
rings). Of the 25 km layout's ten, three fell: lc-3 (vehicle tracks across the disc and the outer ring), lc-4 (a
lava-tube collapse pit inside the flat radius), lc-6 (Highway 11 inside the outer ring). The seven that stood were
kept as seeds (`--seed class:lat:lon`: placed first, every gate applied again; recorded in `rule.seeded`) and the
field re-resolved within 25 km four times; the replacements fell in turn (a collapse line, tracks, a collapse line,
a crack and pits: lava-tube features show in Ka Lae's 10 m heights), one light pad on the South Point
pasture (faint lines only) and one medium pad on the Kahuku lava (a flow front 400 m west, outside its 300 m flat
radius) stood. **Result: 9 pads** (LC-1; 1 heavy, 2 medium, 5 light new; 2 heavy, 4 medium and 1 light found no
place: `shed`). `data/staged/sites/ka-lae.pads.json`, resolved on the live tile set f5e6ef420bda7cea, with the
per-pad land cover and the reported corridor numbers; the rule fields below. Pictures:
`out/bake/earth/site-bake/pads-ka-lae-look{1..5}.png`, `pads-ka-lae-settle-sheet.png`, `pads-ka-lae-sheet.png`,
`pads-ka-lae-corridors.png`.

| Pad | Class | Lat, lon | Elev m | From LC-1 km | Footprint land cover | Outer-ring land cover | Clear azimuths | Nearest settlement in sector | Nearest built-up cell in sector |
|---|---|---|---|---|---|---|---|---|---|
| lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.6 | 0.0 | bareRock 81%, trees 13%, grass 6% | bareRock 54%, trees 31%, grass 8%, water 4%, sand 2%, builtUp 1% | blocked | 0.8 km at 88 | 0.6 km at 72 |
| lc-2 | heavy | 18.964261, -155.634430 | 77.7 | 4.2 | grass 100% | grass 100% | 60-180 | none | 3.6 km at 80 |
| lc-3 | medium | 18.993334, -155.762263 | 45.1 | 16.7 | bareRock 100% | bareRock 100% | 30-180 | 13.6 km at 67 | 8.1 km at 109 |
| lc-4 | light | 19.030902, -155.581073 | 158.0 | 5.4 | grass 100% | grass 100% | 22-180 | none | none |
| lc-5 | light | 18.930802, -155.654960 | 45.3 | 8.3 | grass 100% | grass 100% | 57.5-180 | none | 0.7 km at 100 |
| lc-6 | light | 19.023833, -155.747167 | 195.1 | 15.7 | bareRock 100% | bareRock 100% | 0-180 | 11.1 km at 80 | 7.8 km at 60 |
| lc-7 | light | 19.164688, -155.490512 | 72.1 | 23.0 | grass 100% | grass 100% | 30.5-180 | none | 5.5 km at 80 |
| lc-8 | light | 18.942946, -155.640416 | 34.6 | 6.3 | grass 100% | grass 100% | 44-180 | none | 0.7 km at 114 |
| lc-9 | medium | 19.004928, -155.769694 | 48.6 | 17.6 | bareRock 100% | bareRock 100% | 54-131 | 13.9 km at 73 | 9.2 km at 114 |

LC-1 is fixed and exempt (reported only: it fails the outer-ring land cover, trees 31 %; its built-up ground is the
complex's own). Ground excluded after looking (`rule.excluded`):

| Centre | Radius m | Reason |
|---|---|---|
| 18.946451, -155.651827 | 700 | Ka Lae: vehicle tracks cross the outer ring and the disc (looked at, level-12 imagery) |
| 19.008990, -155.752862 | 700 | Ka Lae: a collapse pit (lava tube) inside the flat radius (hillshade) |
| 19.038391, -155.760879 | 700 | Ka Lae: Highway 11 crosses the outer ring |
| 19.011143, -155.759141 | 700 | Ka Lae: a lava-tube collapse line through the flat radius (hillshade) |
| 18.948072, -155.642984 | 600 | Ka Lae: a vehicle track crosses the disc |
| 18.942133, -155.656675 | 600 | Ka Lae: vehicle tracks cross the disc (the South Point pasture) |
| 19.006822, -155.763988 | 600 | Ka Lae: a lava-tube collapse line inside the flat radius (hillshade) |
| 19.007647, -155.745156 | 600 | Ka Lae: a lava-tube crack and pits inside the flat radius (hillshade) |

**What the next packages inherit (the close of site-bake):**

| | Madrakah (`madrakah.pads.json`) | Ka Lae (`ka-lae.pads.json`) |
|---|---|---|
| Pads | 16: 4 heavy, 6 medium, 6 light | 9: 2 heavy (LC-1 + 1), 2 medium, 5 light (`shed`: 2 heavy, 4 medium, 1 light) |
| Field | 19.08-19.37 N, 8.8-41.0 km from the nominal point, a north-south row behind the cliffed shore | LC-1 and the South Point pasture (4-8 km), the Kahuku lava (16-18 km), one pad above Punalu'u (23 km) |
| Reference pad (`pads[0]`) | lc-1, 19.078241 N 57.786868 E (moved along the coast) | lc-1 = LC-1 at its v1 position and elevation (fixed) |
| Dry gate (`rule.dryClasses`) | bare ground (bareRock, sand, sparseScrub), 80 % of the 500 m disc and the centre | bare ground, grass or shrub |
| Outer ring (`rule.forbiddenInOuterRing`) | none | trees, crop, builtUp, wetland, water |
| Open-ocean sector (`rule.strict`) | gated (LC-1's full rule) | reported |
| Corridor, built-up part | any built-up cell in 60-130 deg to 12 km | no settlement (>= 10 % built-up in 300 m) in 60-130 deg within 5 km (`rule.corridor.settlement`); the rest reported |
| Corridor, pads' keep-out part | 60-130 deg to 12 km, both ways | the same |
| Own ground (`rule.ownGround`) | none | 600 m about LC-1, excepted from every built-up test |
| Fixed / seeded | none / none | LC-1 (`rule.fixed`, with reason) / 7 seeded after looking (`rule.seeded`) |
| Excluded after looking | 42 discs | 8 discs |
| Every pad records | `report.landCover.footprint` (flat radius) and `.outerRing` (built-up radius): class fractions, for clearing the ground cover; `allowedFraction`, `bareFraction`, built-up and forbidden distances; `corridors[]` with clear azimuths, nearest pad, settlement and built-up cell in the sector | the same |

Pad radii the layouts were resolved for (`rule.padRadii`, flat / blend / keep-out m): heavy 450 / 900 / 600, medium
300 / 600 / 450, light 150 / 300 / 300; larger radii need a re-resolve. Pads face 90 deg. Ids are in placement
order (fixed, seeded, new); fleet-data may rename them.

Waivers (`data/defs/regions/earth-madrakah.json` `verifyWaivers`, the lead's): relief shading of the Madrakah imagery
(levels 10 and 12), the level-11 albedo seam up to +0.037 sRGB levels. `verify.py --region earth-madrakah`: 24 of 27
pass, 3 waived, 0 failed. Tests: `npx vitest run tests/unit/site-bake` 16 of 16 (both sites; the TerrainProvider
re-measurement: Madrakah within 0.31 m of padElevation, steepest disc 1.32 deg; Ka Lae within 0.80 m, 3.98 deg; LC-1
pinned to its v1 value); the tile-reading block is skipped explicitly without baked tiles (CI).

Known limits: residual relief shading in Madrakah's imagery (waived; judged in the engine); a faint 30 m dimple
texture of GLO-30 at relief x3; the sea floor up to 20 m deeper than ETOPO within 3 km of the shore in the bay south-west
of Ras Madrakah; Madrakah level-12 edge continuity not yet checked by the provider test (request site-bake-2); the
replace swap's 73 s window of mixed Madrakah tiles under the old manifest; LC-1 fails the outer-ring land-cover and
corridor tests (reported, exempt); Ka Lae's new pads stand on pasture (grass, to be cleared from the footprint) and on
young lava with tube collapses nearby (excluded where seen); faint vehicle tracks and thin rills were accepted at both
sites; the region files' unit records in `data/cache/earth/state` no longer match their configuration (Ka Lae since
a2c6318, Madrakah since its `verifyWaivers` changed): run regional steps with `--region` deliberately, a default
`bake.py region` would re-bake.

## 1. What a consumer needs

| Item | Where | Notes |
|---|---|---|
| Resolved pads, Ka Lae | none: WITHDRAWN (section 0.3); candidates in `data/staged/sites/candidates/` | awaiting the lead |
| Resolved pads, Madrakah | `data/staged/sites/madrakah.pads.json` | 16 pads, re-resolved in the follow-up (section 0.2) |
| Madrakah region | `data/defs/regions/earth-madrakah.json` | disc of 100 km about 19.0 N 57.8 E, levels 8-12, sources, the pad rule's numbers (`siteResolution`) |
| Earth tile set | `data/tiles/earth/` | the Madrakah region added on face 2, levels 8-12, four layers; no existing tile changed (section 6) |
| Ground-quality note (Q8) | section 5 | pictures in `out/bake/earth/site-bake/` |
| Pad report (every evaluation, search statistics) | `out/bake/earth/site-bake/pads-<site>.json` | regenerated by `bake.py pads` |

### Pads file format (`data/staged/sites/<site>.pads.json`)

```
{ site, region, tileset: "earth", bodyId: "earth", nominal: {latDeg, lonDeg}, ground: <what the pads were resolved on>,
  tilesetContentHash, rule: { <the region's siteResolution numbers>, searchRadiusKm, gates, reported, strict, dry,
  padRadii, builtUpMarginM, corridor: {azimuthDeg, reachKm}, excluded: [{latDeg, lonDeg, radiusM, reason}],
  classes: {heavy|medium|light: {count, spacingM}}, spacing }, referencePad: "lc-1",
  corridors: [ { id, clearAzimuthDeg: [from, to] | null, nearestPadInSector, nearestBuiltUpInSector30km } ],
  pads: [ { id, class, latDeg, lonDeg, padElevation, azimuthDeg, offsetEnu: [east, north], fixed,
            report: { naturalHeightM, slopeDeg, reliefM, planeRmsM, roughness10M, shoreDistanceM, shoreBeyondWindow,
                      dryFraction, bareFraction, seaDistanceM, builtUpM, builtUpWindowM, builtUpRadiusM, centreClass, oceanRays, siteTests, passes, failures,
                      distanceFromNominalM } } ] }
```

- `pads[0]` is the reference pad: the site's `location` (`SiteLocationDef.latDeg/lonDeg/padElevation`) is its
  position; `offsetEnu` are metres east / north of it (azimuthal equidistant), as `PadDef.offsetEnu`; the resolved
  coordinates go into `location.pads[<id>]` (`SiteLocationDef.pads`).
- `padElevation` is the natural height at the pad centre on the baked level-12 collision surface (bilinear on the
  vertex grid), what LC-1's `padElevation` is (LC-1 keeps its v1 value 21.62 m; the tiles give 21.64 m there).
- `azimuthDeg` is 90 for every pad (LC-1's `padAzimuthDeg`: launches east).
- Pad ids `lc-1` .. `lc-16` per site, in placement order (heavy, medium, light); fleet-data may rename them.

## 2. Public API (tools/bake/earth)

```
python -I tools/bake/earth/bake.py stage   --region <id>     # bake a NEW region away from the live tile set
python -I tools/bake/earth/bake.py swap    --region <id>     # move its tiles in (new directories only), then the manifest, atomically
python -I tools/bake/earth/bake.py pads    --region <id> --site <site> --nominal <lat,lon>
                                           [--fixed <id:class:lat:lon:elevation>]... [--azimuth 90]
                                           [--classes heavy=4:2500,medium=6:1500,light=6:1000] [--search-km N] [--strict]
                                           [--exclude <lat:lon:radiusM:reason>]... [--dry-run] [--allow-partial]
                                           [--dry-any-land] [--candidate-out <file>]      # follow-up round
python -I tools/bake/earth/bake.py stage   --region <id> --replace   # bake a LIVE region again; `swap` then replaces it (follow-up)
python -I tools/bake/earth/bake.py quality --region <id> --site <site>      # Q8 material (pictures, measurements)
python -I tools/bake/earth/bake.py contact --region <id>     # the region's contact sheets only (staged or live)
python -I tools/bake/earth/verify.py --region <id> [--quick] # region checks, staged (prospective manifest) or live
python -I tools/bake/earth/swaptree.py --stage <dir> --live <dir> --manifest <file> [--delay-ms N]   # stdlib only
```

Python (stdlib) entry points other packages may call: `stage.begin(region_id)`, `stage.state(region_id) -> None |
"staging" | "moved" | "swapped"`, `stage.hidden_regions() -> set[str]`, `stage.route(face, level, x, y) -> Path | None`,
`stage.prospective_manifest(region_id) -> dict`, `stage.swap(region_id) -> dict`; `swaptree.swap_tree(stage: Path,
live: Path, *, delay_s=0.0, log=print) -> dict`, `swaptree.write_manifest_atomic(live: Path, data: bytes) -> Path`;
`region.list_regions(include_hidden: bool = False) -> list[str]`; `manifest.build_hash(layer, scope=None,
include=frozenset())`, `manifest.layer_dict(layer, regions)`, `manifest.region_attribution(region, layer=None)`;
`heights.source_finer_than_parent(region, level) -> bool`, `heights.vertex_spacing_m(region, level) -> float`;
`padresolve.run(region_id, args) -> dict`; `groundquality.run(region_id, args) -> dict`.

**Staging** (`stage.py`). A region is staged from `begin()` (which refuses a coverage overlapping the live one) until
`swap()` has finished; its state is `data/cache/earth/stage/<region>/stage.json`. While "staging", `tiles.tile_file`
routes every tile of its coverage at its regional levels to `data/cache/earth/stage/<region>/tiles/...` (reads and
writes; global levels and other regions stay live). While "staging" or "moved" the region is hidden:
`region.list_regions()` leaves it out (so `bake.py` without `--region`, `manifest`, `contact`, full `verify.py`
and `cleanup` never see it), and `manifest.build_hash()` leaves its state records out (so a manifest written by anyone
meanwhile is byte-identical to the live one).

**Swap** (`stage.swap`). (1) The prospective manifest is built with the same layer functions as
`manifest.write_all` and checked to be purely additive: every live layer key, coverage and sourceCoverage rectangle
(in order), height scale, source and attribution line stays; only the region's rectangles, its source and
attribution lines and the layers' `build` hashes are added or updated. (2) `swaptree.swap_tree` pre-flights every
staged file against the live tree (a different live file at the same path stops the swap before anything moves;
an identical one is left) and moves each staged directory that has no live counterpart with ONE rename (atomic on one
volume); existing directories are entered and files moved one by one onto free names. (3) Every tile the new
manifest promises is checked present (`layout.verify_files_exist`). (4) The manifest is written ONCE, through a
temporary file and `os.replace`. Every step is idempotent: an interrupted swap is finished by running it again.

**Region-file fields added** (optional, additive; Ka Lae's file is unchanged and keeps its behaviour):
`sources.height.resolutionM` (land source sample spacing: sourceCoverage only at levels whose parent samples more
coarsely), `sources.height.credit` / `landSurvey` / `attribution` (manifest source and attribution text of the
region's land source), `sources.albedo.deshadeFitMinHeightM` (ground used for the regional de-shading fit; default
1500 m as at Ka Lae: on Madrakah's desert coast every height is sparsely vegetated). Added in the follow-up:
`sources.height.id` "copernicus-glo30" (`glo30.py`), `sources.height.seaFloorNearShore` ("shallower" default,
"deeper": the lead's rule), `sources.height.despikeBelow`, `sources.albedo.deshadeFitMinSlopeDeg`,
`sources.watermask.inlandMaxRangeM` / `inlandMaxSlopeDeg` / `inlandMinAreaM2` (false inland water), `verifyWaivers`
(a check prefix -> the lead's words: `verify.py` prints WAIVED BY THE LEAD with the measured numbers and does not
fail on it). Python: `stage.begin(region_id, replace=False)`, `stage.is_replace(region_id)`,
`swaptree.replace_tree(stage, live, allowed, *, delay_s=0.0, log=print) -> dict` (refuses unless the staged files
are exactly `allowed`; `os.replace` per file).

## 3. Pads (round 1: WITHDRAWN, see sections 0.1-0.3)

Both round-1 layouts below were withdrawn after the review: they gated neither built-up land nor the launch
corridors (the pads were clustered east-west, in one another's launch sectors), and Madrakah's did not keep LC-1's
open-ocean rule. `ka-lae.pads.json` was removed and `madrakah.pads.json` replaced. Kept here as the record.

### The rule and how it was applied

`bake.py pads` (`tools/bake/earth/padresolve.py`) takes the site id, the nominal point, the region and the pads
that stay where they are as arguments and reads no site file. The ground is the BAKED tile set of the region
(staged or live): heights are the bilinear interpolation of the level-12 vertex grid (the collision surface and
the rendered surface), water is height below 0 m or water mask at least 50 %, land cover the level-12 classes;
global level 7 beyond the finest coverage.

Gates per pad (the brief's "flat, dry, clear of the shore", with the numbers of the rule that placed LC-1, from the
region's `siteResolution`; both regions use LC-1's: 500 m disc, slope < 4 deg, relief <= 12 m, shore >= 600 m,
height >= 15 m, 80 %, latitude < 20.5 deg):

- FLAT: the least-squares plane through the heights of the 500 m disc (10 m grid) is less than 4 deg steep and no
  point lies more than 12 m from it.
- DRY: the centre and at least 80 % of the disc are bare, dry ground: WorldCover "bare / sparse vegetation" or
  "moss and lichen" (site.py's `ALLOWED_WC`, the test that put LC-1 on lava), stored by the regional land cover as
  `bareRock`, `sand` or `sparseScrub`. Never water, wetland, trees, crops, grass or built-up.
- CLEAR OF THE SHORE: no water (sea or inland) within 600 m (10 m grid), natural height at least 15 m; latitude
  below 20.5 deg.
- REPORTED, not gated: LC-1's site-selection test, the open-ocean sector (every azimuth 60-130 deg reaches the sea
  within 6 km, then no land out to 100 km).

Why the ocean sector is not a gate (measured on Ka Lae's tiles, 60 m gridded exploration within 45 km of LC-1):
every test of LC-1's rule together admits NO pad but LC-1 itself (LC-1 sits exactly at the 80 % bare-ground
bound); the ocean sector without the land-cover test admits 5. The design's own words for the pad rule are
"flat, dry, clear of the shore" (brief; fleet-docking 5.1) and the brief's acceptance names the slope and distance
rules only. "Dry" was first read as "not water or wetland": that run put 15 pads on pasture and tree cover around
LC-1 (`out/bake/earth/site-bake/quality-ka-lae-overview.png` of 01:22, superseded); LOOKING at it settled the
reading: dry is LC-1's bare-ground test, and the brief's clause "if no acceptable ground exists near the nominal
point, move along the coast and say so" applies.

Spacing (ARCHITECTURE 9.3: heavy 2.5 km, medium 1.5 km, light 1 km between pads of a class): each pad owns a disc
of half its class spacing and no two discs overlap, so pads of two classes are at least the mean of their
spacings apart (heavy-medium 2.0 km, heavy-light 1.75 km, medium-light 1.25 km). The brief gives same-class
spacings only; this rule keeps every flatten blend disc apart (section 6).

Placement: the fixed pads first (LC-1 at Ka Lae, as given: `--fixed lc-1:heavy:18.987556:-155.603239:21.62`), then
heavy, medium, light, each on the passing point of a 30 m grid nearest to the nominal point that keeps the spacing
to every pad placed before it. A gridded pre-filter (necessary conditions only: height, 30 m shore distance, plane
slope + 0.5 deg, plane RMS <= the relief limit, bare share - 5 %, latitude, search radius) orders the candidates;
each is then evaluated exactly. Deterministic: the same tiles and arguments give byte-identical pads (checked: the
Ka Lae run before and after the resolver was sped up is identical).

### Resolved pads

### Ka Lae (`ka-lae`, region `earth-ka-lae`, nominal = LC-1, search 20 km)

| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Dry | Bare | Centre class | Ocean sector 60-130 | From nominal km |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lc-1 (fixed) | heavy | 18.987556, -155.603239 | 21.62 | 0.89 | 4.2 | 0.20 | 1.25 | 601 | 1.00 | 0.80 | bareRock | open | 0.00 |
| lc-2 | heavy | 19.004623, -155.690461 | 216.76 | 2.40 | 11.1 | 0.42 | 2.73 | > 3000 | 1.00 | 0.81 | bareRock | no: 60 deg, no sea within reach | 9.37 |
| lc-3 | heavy | 18.982766, -155.696726 | 84.01 | 2.49 | 8.4 | 0.48 | 2.38 | 3138 | 1.00 | 0.99 | bareRock | no: 60 deg, no sea within reach | 9.84 |
| lc-4 | heavy | 18.960103, -155.697284 | 31.75 | 0.52 | 6.4 | 0.25 | 2.23 | 1186 | 1.00 | 0.99 | bareRock | no: 60 deg, no sea within reach | 10.35 |
| lc-5 | medium | 19.029711, -155.697038 | 368.99 | 3.99 | 6.5 | 0.59 | 1.91 | > 3000 | 1.00 | 0.80 | bareRock | no: 60 deg, no sea within reach | 10.92 |
| lc-6 | medium | 18.997329, -155.708148 | 139.82 | 3.20 | 8.4 | 0.55 | 2.60 | 4035 | 1.00 | 0.99 | bareRock | no: 60 deg, no sea within reach | 11.08 |
| lc-7 | medium | 19.011898, -155.708443 | 243.76 | 3.26 | 11.8 | 0.52 | 3.38 | > 3000 | 1.00 | 0.83 | bareRock | no: 60 deg, no sea within reach | 11.39 |
| lc-8 | medium | 18.971696, -155.711841 | 39.63 | 0.99 | 4.1 | 0.16 | 1.44 | 1226 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 11.55 |
| lc-9 | medium | 18.985723, -155.715559 | 61.67 | 2.13 | 9.6 | 0.43 | 2.85 | 2254 | 1.00 | 0.97 | bareRock | no: 60 deg, no sea within reach | 11.81 |
| lc-10 | medium | 19.004336, -155.720423 | 175.39 | 3.00 | 6.8 | 0.45 | 1.92 | > 3000 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 12.46 |
| lc-11 | light | 19.066407, -155.688210 | 661.30 | 2.31 | 5.5 | 0.34 | 1.97 | > 3000 | 1.00 | 0.81 | bareRock | no: 60 deg, no sea within reach | 12.52 |
| lc-12 | light | 18.976546, -155.722686 | 46.50 | 1.10 | 6.1 | 0.23 | 1.73 | 1026 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 12.62 |
| lc-13 | light | 19.016748, -155.719290 | 242.37 | 3.95 | 11.2 | 0.63 | 3.74 | > 3000 | 1.00 | 0.97 | bareRock | no: 60 deg, no sea within reach | 12.62 |
| lc-14 | light | 18.993542, -155.724124 | 104.96 | 3.03 | 7.5 | 0.47 | 1.97 | 2745 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 12.73 |
| lc-15 | light | 19.075311, -155.685931 | 706.23 | 2.15 | 6.8 | 0.35 | 2.17 | > 3000 | 1.00 | 0.81 | bareRock | no: 60 deg, no sea within reach | 13.07 |
| lc-16 | light | 18.984906, -155.727542 | 72.15 | 1.46 | 5.5 | 0.23 | 1.66 | 1721 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 13.07 |

### Madrakah (`madrakah`, region `earth-madrakah`, nominal 19.0 N 57.8 E, search 20 km)

| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Dry | Bare | Centre class | Ocean sector 60-130 | From nominal km |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lc-1 | heavy | 18.996043, 57.793818 | 37.04 | 2.95 | 11.5 | 0.68 | 3.38 | 1038 | 1.00 | 1.00 | sand | open | 0.79 |
| lc-2 | heavy | 19.009531, 57.774698 | 78.47 | 1.53 | 10.2 | 0.53 | 3.56 | 3539 | 1.00 | 1.00 | sand | no: 92 deg, land at 7.5 km | 2.86 |
| lc-3 | heavy | 19.028688, 57.787538 | 122.19 | 1.30 | 11.9 | 0.53 | 4.38 | 2889 | 1.00 | 0.98 | bareRock | no: 112 deg, land at 6.6 km | 3.45 |
| lc-4 | heavy | 18.981742, 57.772705 | 15.47 | 1.36 | 8.9 | 0.50 | 3.16 | 1511 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 3.52 |
| lc-5 | medium | 18.996579, 57.761289 | 75.57 | 1.27 | 9.7 | 0.43 | 3.37 | 3793 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 4.09 |
| lc-6 | medium | 19.026527, 57.768417 | 121.09 | 0.43 | 8.5 | 0.44 | 2.52 | > 3000 | 1.00 | 0.99 | sand | no: 104 deg, no sea within reach | 4.44 |
| lc-7 | medium | 19.008988, 57.755579 | 90.85 | 0.85 | 5.3 | 0.36 | 1.73 | > 3000 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 4.78 |
| lc-8 | medium | 19.043527, 57.798668 | 161.13 | 0.92 | 11.6 | 0.41 | 2.55 | 1590 | 1.00 | 0.89 | bareRock | no: 128 deg, land at 6.5 km | 4.84 |
| lc-9 | medium | 18.984976, 57.753874 | 54.19 | 1.30 | 11.1 | 0.46 | 2.79 | 2059 | 1.00 | 1.00 | bareRock | no: 60 deg, no sea within reach | 5.13 |
| lc-10 | medium | 19.039748, 57.772410 | 122.94 | 0.42 | 7.6 | 0.46 | 1.89 | 4214 | 1.00 | 1.00 | sand | no: 116 deg, land at 8.6 km | 5.29 |
| lc-11 | light | 19.020050, 57.758430 | 106.10 | 0.85 | 7.3 | 0.42 | 2.38 | > 3000 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 4.91 |
| lc-12 | light | 19.044606, 57.786680 | 145.49 | 1.64 | 7.7 | 0.40 | 2.07 | 2784 | 1.00 | 0.99 | sand | no: 124 deg, land at 7.5 km | 5.15 |
| lc-13 | light | 18.973106, 57.758727 | 15.21 | 1.85 | 11.8 | 0.53 | 3.36 | 680 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 5.27 |
| lc-14 | light | 18.999274, 57.749590 | 73.24 | 0.85 | 7.8 | 0.35 | 2.46 | > 3000 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 5.30 |
| lc-15 | light | 19.018429, 57.749013 | 97.70 | 0.74 | 6.0 | 0.37 | 1.60 | > 3000 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 5.74 |
| lc-16 | light | 19.006557, 57.743880 | 86.47 | 0.68 | 6.9 | 0.35 | 1.71 | > 3000 | 1.00 | 1.00 | sand | no: 60 deg, no sea within reach | 5.95 |

Columns: natural height at the centre (padElevation); slope of the plane through the 500 m disc; largest deviation from it (relief); roughness at 10 m = RMS height difference of points 10 m apart in the disc; RMS deviation from the plane; distance to the nearest water (sea or inland; "> 3000" = none in the 6 x 6 km window); dry = share of the disc not water or wetland; bare = share of bare ground (the gate, >= 0.80); the open-ocean sector (reported).

## 4. The Madrakah regional bake (round 1; the land source, sea floor, inland water and de-shading changed in the follow-up re-bake: section 0.5)

`data/defs/regions/earth-madrakah.json`: a disc of 100 km about the nominal point 19.0 N 57.8 E (4 km inside Ras
Madrakah; the pads lie within 6 km of it), levels 8-12 all at 100 km, feather 5 km, one margin tile, height scales
as Ka Lae (0.125 m at 8-10, 0.0625 m at 11-12), the existing pipeline unchanged apart from the region options of
section 2.

| Level | Coverage (face 2) | Tiles | Vertex / texel at the site | sourceCoverage |
|---|---|---|---|---|
| 8 | x 43..51, y 176..184 | 81 | 141 m | 15 tiles in 3 rects |
| 9 | x 87..102, y 353..366 | 224 | 70 m | 43 tiles in 6 rects |
| 10 | x 175..203, y 707..732 | 754 | 35 m | 147 tiles in 12 rects |
| 11 | x 352..404, y 1417..1464 | 2,544 | 17.6 m | 538 tiles in 23 rects |
| 12 | x 706..808, y 2835..2928 | 9,682 | 8.8 m | none (the 30 m source is no finer than level 11's 17.6 m vertices: ARCHITECTURE 10.2, the level-11 procedural detail continues) |

Sources and licences (all credited in the manifest's `sources` and `attribution`):

| Layer | Source | Resolution | Licence |
|---|---|---|---|
| height, land and inland water | AWS Terrain Tiles / Mapzen Terrarium z14 (NASA SRTM 1 arc-second in Oman) | about 30 m (z14 pixels 9 m hold it completely) | free with attribution (joerd attribution: SRTM courtesy of the U.S. Geological Survey) |
| height, sea floor | NOAA ETOPO 2022 15 arc-second, from the WorldCover coastline with a 1:25 slope, ETOPO 1.5 km out | 463 m | public domain |
| albedo | Sentinel-2 cloudless 2020, 2021, 2023, 2024, 2025 (EOX), per-pixel median, z14 within 10 km of land, z12 offshore | 9 m | CC BY-NC-SA 4.0, swappable (non-commercial: OPEN_QUESTIONS Q11) |
| watermask, landcover | ESA WorldCover 2021 v200 + the regional height sign | 10 m | CC BY 4.0 |

Bake facts: WorldCover grid 43,200 x 30,700 px (572 opened water components, 1 the ocean; 24 km2 inland water:
khawrs and sabkhas); 2,204 Terrarium z14 tiles; 12,072 Sentinel-2 tiles per year x 5 years (60,360 requests at 12
per second, 75 minutes); one ETOPO tile (N30E045) and three WorldCover tiles (N15E054, N18E054, N18E057; N15E057 is
open sea). Corrections at level 12: tile-edge sea-level pockets filled (88 vertices in 10 tiles); needles removed,
11,577 vertices in 26 tiles: upward ones (a 22 km strip of corrupt Terrarium values along the south coast at
18.875 N, 57.1-57.3 E, up to 561 m; a cluster on the shore 7 km north of the nominal point, up to 232 m) and downward
ones (the trench of corrupt rows along the SRTM tile boundary at 19.0 N, 56.83-57.0 E, up to 111 m deep in a 110 m
plateau, 75 km west of the pads; found by `verify.py`'s pit check on the first bake, removed by the region option
`despikeBelow`). Regional de-shading fit (level 10, slopes above 10 deg, 73,789 texels): alpha +0.257 (east), beta
-0.174 (north), the morning sun of the Sentinel-2 overpass; colour match land gains (0.946, 1.175, 1.615), water
(0.209, 0.239, 0.629). Sizes: height 246 MB, albedo 237 MB, landcover 25 MB, watermask 16 MB (on disk); 53,140
files, 461,133,283 bytes.

## 5. Ground quality at Madrakah (OPEN_QUESTIONS Q8; round 1 on SRTM: the follow-up's GLO-30 note is section 0.4 and 0.6)

Question: does the 30 m elevation data at Madrakah meet the v1 standard (Ka Lae, 10 m 3DEP) at pad level?

**What the baked tiles hold at pad level** (one pad per class; Ka Lae's for comparison; `bake.py quality`, every
number on the level-12 collision surface within 2 km of the pad, 10 m grid):

Madrakah:

| Pad | Class | RMS diff 10 / 30 / 100 m | RMS curvature 10 / 30 m (ratio) | Finer than 30 m RMS | Slope median / p95 deg | Slope histogram 0-1/1-2/2-4/4-8/8-16/16-32/>32 % | Albedo neighbour RMS (sRGB) |
|---|---|---|---|---|---|---|---|
| lc-1 | heavy | 0.99 / 2.88 / 8.09 | 0.297 / 2.050 (0.14) | 0.43 | 4.6 / 16.3 | 5/9/28/36/17/5/0 | 11.6 |
| lc-5 | medium | 0.53 / 1.53 / 3.95 | 0.208 / 1.301 (0.16) | 0.28 | 3.1 / 7.9 | 11/15/42/28/5/0/0 | 9.1 |
| lc-11 | light | 0.51 / 1.44 / 3.68 | 0.227 / 1.285 (0.18) | 0.28 | 2.7 / 7.7 | 16/16/43/20/4/0/0 | 10.1 |

Ka Lae (v1 standard):

| Pad | Class | RMS diff 10 / 30 / 100 m | RMS curvature 10 / 30 m (ratio) | Finer than 30 m RMS | Slope median / p95 deg | Slope histogram 0-1/1-2/2-4/4-8/8-16/16-32/>32 % | Albedo neighbour RMS (sRGB) |
|---|---|---|---|---|---|---|---|
| lc-1 | heavy | 0.40 / 1.11 / 3.21 | 0.172 / 0.709 (0.24) | 0.19 | 1.9 / 6.0 | 24/28/31/14/2/0/0 | 5.9 |
| lc-5 | medium | 1.28 / 3.75 / 11.29 | 0.378 / 2.225 (0.17) | 0.48 | 4.0 / 18.4 | 1/5/44/41/4/2/3 | 5.1 |
| lc-11 | light | 0.62 / 1.82 / 5.47 | 0.189 / 1.081 (0.17) | 0.23 | 3.2 / 7.2 | 1/13/56/27/3/1/0 | 3.8 |

- Imagery: the same source and resolution at both sites (Sentinel-2 cloudless, about 9-10 m texels at level 12).
  Madrakah's imagery shows a dissected desert gravel plain with clear wadi networks, dark ophiolite hills on the
  headland, sand streaks, the town and the bay; no cloud remnants; natural colours after the colour match.
- Heights: Ka Lae's 10 m surface carries coherent geology at pad level (lava-flow fronts, channels, small cones
  that match the imagery). Madrakah's carries the 30 m SRTM signal: hills, escarpments and the larger wadis are
  there, the small wadis of the imagery are not, and the band finer than about 60 m is dominated by SRTM noise, a
  pebbly undulation of about 0.3-0.5 m RMS (in a hillshade with relief x3 it is obvious, at x1 under a 45 deg sun
  it is faint). Measured: RMS curvature at 10 m 0.21-0.30 m (Ka Lae 0.17-0.38 m), curvature ratio 10/30 m
  0.14-0.18 (Ka Lae 0.17-0.24): similar amplitudes, different character (noise against geology).
- Defects found and removed: corrupt Terrarium rows along the SRTM tile boundary at 19.0 N (a straight trench up to
  111 m deep, 56.83-57.0 E, 75 km west of the pads) and corrupt shore values (needles up to 561 m); both removed by
  the despike pass (section 4). Remaining: Terrarium z14 tile edges carry a kink of 0.1-0.2 m (median second
  difference 0.27 m at the edge against 0.15 m inside), a faint line every 2.3 km in a low-sun hillshade.
- Imagery de-shading: relief shading of the Sentinel-2 morning overpass remains on the headland's hills (east-facing
  slopes 10-20 % brighter than west-facing ones against their surroundings: section 8); the 30 m normals cannot
  carry the correction the imagery needs.

Pictures (`out/bake/earth/site-bake/`; each: imagery | hillshade x3 | imagery lit by a 45 deg sun | land cover; red
= the 500 m disc of the pad rule, yellow = the other pads): `quality-madrakah-overview.png` (every pad, 17 km),
`quality-madrakah-lc-{1,5,11}-{pad,2km,20km}.png` (600 m at 1 m pixels, 2 km, 20 km), the same for Ka Lae
(`quality-ka-lae-*`); contact sheets `out/bake/earth/contact/region-earth-madrakah-*` (every level and layer,
coverage-edge crops, a 3 km and 20 km hillshade about the nominal point).

**Decision the data supports: keep the Madrakah site (Q8 option A).** The ground does not clearly fail the v1
standard at pad level: the imagery is as detailed as Ka Lae's, the pad discs are flat by construction (flatten
discs), and the 30 m surface around them is clean of gross artefacts after the despike. What it lacks is real
relief finer than about 60 m; what it adds is a low-amplitude SRTM noise texture, and planet-render's in-browser
ground checkpoints (ARCHITECTURE 31.3: pad level at noon and low sun, 300 m up) are the place to judge whether that
texture shows under the procedural detail. If it does, the data-side remedy is a source swap, not the fall-back:
Copernicus DEM GLO-30 (TanDEM-X based, lower noise, free with attribution; `regsrc.py` reads Terrarium today) or a
low-pass of the land source below 60 m wavelength. The fall-back (all 32 pads at Ka Lae) was not resolved.

## 6. The terrain guard: exactly what changes (round 1, the additive swap; the follow-up replace: section 0.7)

**Tile directories added to the Earth set** (all NEW; no directory that existed before holds a new, removed or
changed file; checked byte for byte in section 8): for each layer `height` (`.hgt`), `albedo` (`.webp`), `watermask`
(`.u8`) and `landcover` (`.u8`), on
face 2, the column directories `{layer}/2/{level}/{x}` of the coverage rectangles of `earth-madrakah`:

| Level | x (directories) | y (files per directory) | Tiles per layer |
|---|---|---|---|
| 8 | 43..51 (9) | 176..184 (9) | 81 |
| 9 | 87..102 (16) | 353..366 (14) | 224 |
| 10 | 175..203 (29) | 707..732 (26) | 754 |
| 11 | 352..404 (53) | 1417..1464 (48) | 2,544 |
| 12 | 706..808 (103) | 2835..2928 (94) | 9,682 |
| all | 210 per layer, **840 directories** | | 13,285 per layer, **53,140 files** |

The tile set's root directory `.` changes in one file only: `manifest.json` (additive: section 4). Nothing under
`globals/`, `night/`, any other face or any level 0-7 directory changes; the Moon set is not touched. No stored
guard direction lies in the new coverage: the nearest of the 2,000 Earth directions is 226 km from the region centre
(17.211 N 58.820 E, level-8 tile 2/50/174, two tiles south of the level-8 coverage), the next 396 km; the guard's
heights stay bit-identical (section 8). Madrakah is a new place (site `madrakah`, reference pad lc-1 at
18.996043 N 57.793818 E): the lead appends its group (`--add-place`). Ka Lae's fifteen new pads are new flatten discs
9-13 km west of LC-1, outside the existing place's 2 km and 200 m discs but inside its 20 km and 200 km ones: guard
points there change only once fleet-data writes the pads (the discs are derived from the site at load).

**Flatten discs of the new pads** (for the guard's place groups; fleet-data sets the final radii). Each pad's ground
was checked over a disc of 500 m radius about its centre (the pad rule, every class); the spacing keeps the blend
discs apart for the radii below (heavy 2.5 km >= 900 + 900 m, heavy-medium 2.0 km >= 1.5 km, heavy-light 1.75 km >=
1.2 km, medium 1.5 km >= 1.2 km, medium-light 1.25 km >= 0.9 km, light 1 km >= 0.6 km):

| Class | Flat radius m | Blend radius m | Source |
|---|---|---|---|
| heavy | 450 | 900 | LC-1 (`data/defs/sites/ka-lae.json` `pad`) |
| medium | 300 | 600 | between the two (fleet-docking 5.1 gives heavy and light only) |
| light | 150 | 300 | fleet-docking 5.1 |

The pad centres (site id, pad id, class, latitude, longitude) are the tables of section 3; LC-1's disc exists today
and does not move.

## 7. How to run and verify

Every heavy step through the gate (one at a time; 6 workers at most; the bake re-executes itself in
`data/cache/earth/venv`):

```
node tools/dev/heavy.mjs --class=bake --label=site-bake-stage -- python -I tools/bake/earth/bake.py stage --region earth-madrakah
node tools/dev/heavy.mjs --class=bake --label=site-bake-pads  -- python -I tools/bake/earth/bake.py pads --region earth-madrakah --site madrakah --nominal 19.0,57.8 --search-km 20
node tools/dev/heavy.mjs --class=bake --label=site-bake-pads  -- python -I tools/bake/earth/bake.py pads --region earth-ka-lae --site ka-lae --nominal 18.987556,-155.603239 --fixed lc-1:heavy:18.987556:-155.603239:21.62 --search-km 20
node tools/dev/heavy.mjs --class=bake --label=site-bake-q     -- python -I tools/bake/earth/bake.py quality --region earth-madrakah --site madrakah
node tools/dev/heavy.mjs --class=bake --label=site-bake-verify -- python -I tools/bake/earth/verify.py --region earth-madrakah
node tools/dev/heavy.mjs --class=bake --label=site-bake-swap  -- python -I tools/bake/earth/bake.py swap --region earth-madrakah
node tools/dev/heavy.mjs --class=cpu  -- npx vitest run tests/unit/site-bake tests/unit/terrain-core/terrain-guard.test.ts
```

Every step is resumable: finished work units are recorded in `data/cache/earth/state/` with the hash of their
configuration; the stage marker says where the region stands. After an interruption, check the stage and the live
tree for `.partial` or zero-length files before resuming (`layout.write_atomic` never leaves a truncated tile under
its final name).

## 8. Acceptance, measured

| Criterion | Result |
|---|---|
| Existing Earth and Moon tiles outside the new region byte-identical (the guard's hash summary) | **Met.** Full form (every file read, name + bytes + content hash per directory, against the lead's recording of cde7b30) after the swap: Earth 8,379 directories unchanged, 840 added (exactly `{height,albedo,watermask,landcover}/2/{8..12}/{x}` of section 6: 53,140 files, 461,133,283 bytes), 0 removed, 1 changed: `.` (`manifest.json`, 15,109 -> 21,925 bytes); Moon 2,344 of 2,344 unchanged. Before the swap the every-commit guard passed 6 of 6. |
| Terrain guard heights bit-identical | **Met.** After the swap the guard's height test passes bit for bit (2,000 Earth and 2,000 Moon directions, three queries each); only the directory test fails, by design, on the 840 new directories and `manifest.json` (request site-bake-1). |
| Manifest swap atomic; a reader never sees a promised tile that is missing | **Met.** Unit test `tests/unit/site-bake/swap.test.ts` (real swap code in a separate Python process, a reader in the test process, 2 of 2). On the real swap a reader polled the live manifest for 176 s: 7,521 reads (7,504 of the old manifest `ab20fdfc579d4015`, 17 of the new `f70a61d55dca902f`), 0 failed reads, 903,380 existence checks of promised Madrakah tiles, 0 missing. The swap moved 20 directories by one rename each and wrote the manifest once; 750,486 promised tiles checked present before the write. |
| Every resolved pad meets the slope and distance rules; report table; spacing verified by a test | **Met.** Tables in section 3; `tests/unit/site-bake/pads.test.ts` 10 of 10: counts, classes, ids, spacing (same class and mixed), every recorded gate, LC-1 unchanged, and an independent check with the real TerrainProvider on the live tiles (band limit 100 m): heights within 1.34 m (Ka Lae) and 0.95 m (Madrakah) of padElevation, steepest 500 m disc 3.99 deg and 2.95 deg, no sea within 600 m. |
| data/ under 22 GB, 25 GB free, raw downloads deleted | **Met.** After cleanup: `data/` 33 GB of which `data/packs` 14 GB (separate 20 GB budget, platform-delivery's) and 19 GB of baked data, caches and stack state (tiles 18 GB, cache 1.8 GB, sky 0.13 GB, stack 0.35 GB); this package added 0.46 GB of tiles and left `data/cache/earth` at 0.92 GB as found (5.95 GB of downloads and intermediates deleted). Disk free 36 GB (lowest during the work 31.9 GB). |
| Bakes through the gate, at most 6 workers | **Met** for every bake (stage x 3, the last with 4 workers after a worker ran out of commit memory while the machine was loaded), the guard runs and both region verifications. Light single-process analysis outside the gate: section 10, item 7. |
| `python -I tools/bake/earth/verify.py --region earth-madrakah` | **24 of 27 pass** (live, after the swap; the same before it). Fails: (1) `no baked hillshade` level 10: paired east/west 1.205, north/south 0.954; level 12: 1.099 and 0.984 (need 1 +/- 0.03) within 10 km of the site. The regional de-shading fit is physically sound (alpha +0.26, beta -0.17, converged from slopes of 8 deg up) but the 30 m normals under-represent the slopes the 10 m imagery's shading follows; a correction strong enough for the gate (alpha about 0.9) lies outside the Lambertian bound of the morning sun. Before the fit fix the values were 1.307 / 0.929 and 1.193 / 0.961. (2) `albedo seams` level 11: border excess +0.033 sRGB levels against a 2-s.e. bound of 0.031 (300 borders). On 1,000 other borders per direction: +0.025 +/- 0.024 (east), +0.015 +/- 0.022 (north); Ka Lae's own regional levels show the same small positive excess (+0.008 +/- 0.013 at level 11), about 1-2 % of the neighbour difference at both sites; a real seam (lossy tiles) is about 60 %. Invisible; the absolute gate trips at Madrakah because its imagery has twice Ka Lae's texel contrast. Every other check passes: 53,140 files present and decoded, no alpha, pyramid complete, pads, sourceCoverage, 1,500 shared height edges identical, albedo seams at levels 8, 9, 10, 12, coverage edges at every level (height RMS 0.02-0.34 m, outermost texels = parent), coastline at every level, no inland pits, no needles, TypeScript decode 5 of 5. |
| `npx vitest run tests/unit/site-bake tests/unit/terrain-core/terrain-guard.test.ts` | site-bake 12 of 12; terrain guard 5 of 6 (the directory test, by design: section 6). Also `npm run typecheck:paths -- tests/unit/site-bake/*.ts` OK, `tools/dev/boundaries.test.ts` 93 of 93, `check-stubs` OK. |

## 9. Disk and machine

| | Before | Peak | After |
|---|---|---|---|
| `data/tiles/earth` | 10.30 GB, 697,349 files | | 10.76 GB, 750,489 files |
| `data/cache/earth` | 0.92 GB | 7.3 GB (Sentinel-2 5 years 1.5 GB, median stacks 2.4 GB, WorldCover grid 1.35 GB, coast grids 0.9 GB, Terrarium stack 0.6 GB, staged tiles 0.46 GB) | 0.92 GB |
| Disk free | 61 GB | lowest 31.9 GB | 36 GB |

Largest process: the ocean-connectivity step at about 4 GB (rewritten from about 13 GB). Timings (shared machine):
Terrarium and WorldCover fetch 2 min, heights 15 min, water mask 3 min, Sentinel-2 fetch 75 min (rate-limited),
regional albedo 12 min, land cover 3 min, pads 15-30 s per site, quality pictures 1 min, region verify 5 min, swap
2 min (most of it the presence check of 750,486 tiles), cleanup 1 min.

## 10. Deviations, known limits, requests

Deviations from the brief (each within the design; say if one is unwelcome):

1. [Round 1; reversed by the lead: Madrakah now gates it, section 0.2] **The open-ocean sector of LC-1's rule is
   reported per pad, not gated** (section 3): with it no second pad exists
   near LC-1. Ka Lae's fifteen new pads therefore lie 9-13 km west of LC-1 on the Kahuku lava flows ("move along the
   coast"), where a launch to the east crosses about 10 km of the South Point peninsula before the sea; at Madrakah
   one pad (lc-1) has the open sector, the others are 3-6 km inland behind the headland's hills.
2. **Pads are resolved on the baked tiles**, not on the regional source as LC-1 was: the ground the game uses, and
   Ka Lae's sources were deleted by its cleanup. LC-1 on the tiles: 21.64 m against its recorded 21.62 m.
3. **Spacing between classes** is the mean of the class spacings (the brief gives same-class spacings only).
4. **Region parameters chosen for Madrakah** (data, region file): `landZoom` 14 (holds the 30 m source), near-shore
   slope 1:25 (a sand shore), `resolutionM` 30 (no level-12 sourceCoverage), `despikeBelow`, de-shading fit on ground
   above 5 m and slopes above 10 deg.
5. **`verify.py --region`** is new (the brief's self-verify names it); the full `verify.py` skips staged regions.
6. The ocean-connectivity step of `regsrc.py` was rewritten for memory (identical output: same labels and the
   same random draw; peak about 4 GB instead of about 13 GB on Madrakah's 1.3 G-pixel WorldCover grid).
7. Single-process analysis steps (pad resolution, quality pictures, contact sheets) ran outside the gate at
   below-normal priority while another package's bake held the one bake slot; every bake and the region
   verification went through it.

Known limits:

- SRTM noise texture and missing relief below about 60 m at Madrakah (section 5); Terrarium z14 tile-edge kinks of
  0.1-0.2 m.
- Baked relief shading near Madrakah's headland is reduced but not removed (section 8).
- The Ka Lae region's unit records in `data/cache/earth/state` no longer match its configuration since sim-core-v2
  renamed the site in `earth-ka-lae.json` (a2c6318: the region dict is part of every unit's configuration hash).
  No tile changed, but `bake.py heights|region` WITHOUT `--region` would now re-bake Ka Lae from re-downloaded
  sources. Run regional steps with `--region` until the records are re-stamped (as `bake.py despike` does after a
  repair).
- Two Ka Lae light pads sit at 661 and 706 m, 7-8 km inland (lc-11, lc-15): nearest passing ground, as the rule
  orders.
- `data/cache/earth/backup-height-regional` (282 MB) is core-support's backup from the despike repair; left as found.

Requests filed: `docs/requests/site-bake-1.md` (lead: the mission golden and baseline record the earth manifest's
contentHash, which the swap changes). Open requests against this package's paths: none found.

## 11. What the next packages must know (round 1; superseded by section 0.9)

- **fleet-data** (wave 4.1, `data/defs/sites/*`): take the pads from `data/staged/sites/{ka-lae,madrakah}.pads.json`:
  `id`, `class`, `azimuthDeg`, `offsetEnu` into `PadDef`; `latDeg`, `lonDeg`, `padElevation` into
  `location.pads[id]`; `pads[0]` is the reference point (`location`). Ka Lae's `lc-1` is the existing pad. Flat and
  blend radii are yours; the spacing keeps blend discs apart up to heavy 900 / medium 600 / light 300 m, and the
  ground was checked over 500 m discs (keep `flatRadius` <= 500 m). Madrakah needs a site file and recovery zones
  (the Arabian Sea east and south of the site is open water). Every pad faces 90 deg (LC-1's azimuth).
- **fleet-models-pads**: Ka Lae's new pads are on dark bare lava like LC-1 (Kahuku flows, beside the Kahuku pali
  fault scarp); Madrakah's on sand and gravel with dark ophiolite hills to the east and the town of Madrakah 2-4 km
  south-east of the southern pads [WRONG: built-up land lay 0.44 km from round-1 lc-4; section 0.9]. Site
  dressing per coast accordingly.
- **planet-render**: the ground checkpoints at one pad per class per site (31.3): Madrakah lc-1 (heavy, 37 m, the
  only pad with the open sea sector, 1 km from the shore), lc-5 (medium), lc-11 (light); Ka Lae lc-1, lc-5, lc-11.
  Look for the SRTM noise texture and the faint tile-edge lines (section 5) and the residual relief shading on the
  headland's hills (section 8). Level 12 at Madrakah has coverage but no sourceCoverage: E stays at 11 there and
  the level-11 procedural detail continues (by design).
- **The lead**: re-records the terrain guard's tile summary (section 6), appends the two new places' height groups,
  and updates the mission golden's earth hash (request site-bake-1).

## 12. Running log

- 2026-11-12 00:45 Pacific. Start. Read the brief, ARCHITECTURE 9.3/9.4/10.1/10.2/31.3, MIGRATION_V2, PACKAGE_RULES,
  user decisions, OPEN_QUESTIONS Q8/Q14, the bake-earth and lead-baseline-v2 hand-offs, the earth bake code.
  Disk 61 GB free; `data/` 17 GB (tiles 15 GB, cache 1.8 GB). Terrain guard (quick form) passes on the tree as
  found (4 of 4). The live earth manifest contentHash is `ab20fdfc579d4015`.
- Plan: (1) staging in the bake code: a region marked as staged has all its tile I/O routed to
  `data/cache/earth/stage/<region>/tiles/` and is invisible to every default region loop (`bake.py` without
  `--region`, `manifest`, `contact`, `verify`) until it is swapped in; (2) the Madrakah region file and its
  regional bake into the stage; (3) the pad-resolve tool (`bake.py pads`) evaluated on the baked tiles (level-12
  bilinear heights = the collision surface, level-12 water mask and land cover), for both sites; (4) region checks
  (`verify.py --region`), hillshades, contact sheets and the Q8 ground-quality note; (5) the swap: tiles moved into
  `data/tiles/earth` (new directories only, by rename), then the manifest written once, atomically.
- 00:49. Full terrain guard (`TERRAIN_GUARD_FULL=1`, bytes of every file) passes on the tree as found.
- 00:55. Reconnaissance (Terrarium z12 over the coverage box, 1,496 tiles): the nominal point 19.0 N 57.8 E is 4 km
  inside Ras Madrakah; the coast runs north-south from the headland to Duqm, the south coast turns west; inland a
  very flat gravel plain (12-60 m) with hills of 50-110 m on the headland. Region centred on the nominal point.
- 00:59. Commit 6fcc425 (staging code, region file). Stage bake started (`bake.py stage --region earth-madrakah`,
  gate class bake, 6 workers). WorldCover grid 43,200 x 30,700 px (3x Ka Lae's): the ocean-connectivity step was
  rewritten to give identical output in about 4 GB instead of about 13 GB (uint16 labels, row-chunked sampling).
  572 water components, 1 of them the ocean; 24 km2 inland water; 2,204 Terrarium z14 tiles.
- 01:10. Pad rule question found on Ka Lae's own tiles (60 m gridded exploration within 45 km of LC-1): with every
  test of LC-1's rule gated (incl. bare land cover and the open-ocean sector 60-130 deg), NO second pad fits; LC-1
  itself reaches the bare-ground share exactly (0.80). Flat + dry + clear of the shore: 16 pads within 4.8 km of
  LC-1; + bare land cover: 16 pads 7-13 km west on the Kahuku lava flows (sector to the east blocked by the
  island); + ocean sector without land cover: 5 pads. First decision: gates flat, dry (= not water or wetland),
  clear of the shore; bare ground and the ocean sector reported.
- 01:14. Commit 08b23d2 (pad resolver, ground-quality tool, `verify.py --region`, tests). Swap atomicity test
  green (2 of 2).
- 01:22. Revised after LOOKING at the Ka Lae overview of that run: those 16 pads sit on pasture and tree cover on
  slopes of up to 4 deg at 60-260 m (LC-1 is the only one on bare lava). "Dry" in the brief is LC-1's land-cover test
  (bare, dry ground: WorldCover bare / sparse vegetation, the reason LC-1 is on lava), and the brief's own clause
  "if no acceptable ground exists near the nominal point, move along the coast and say so" covers exactly this.
  Final rule: flat + dry (bare ground) + clear of the shore + height + latitude, i.e. every test of LC-1's rule except
  the open-ocean sector, which is reported per pad (`--strict` gates it as a measurement).
- 01:28. Ka Lae resolved on the live tiles (`--search-km 20`): LC-1 kept; 15 pads on the bare Kahuku lava flows
  9.4-13.1 km west of LC-1, 32-706 m high, slopes 0.5-4.0 deg; open-ocean sector open only at LC-1. Commit a58c2a2.
  Pads test: Ka Lae parts green, including the independent check on the real TerrainProvider (heights within
  1.34 m of padElevation, steepest disc 3.99 deg).
- 01:36. Coordinator: the terrain guard was re-recorded on stored directions (cde7b30); a new place is appended by
  the lead (`--add-place`). This package must state exactly which tile directories it adds and where each new pad's
  flatten disc lies (section 6), and must leave every existing tile byte-identical (the every-commit guard now
  compares bytes per directory by stat).
- 02:57. Stage bake done (53,140 tiles, 0.46 GB staged). Madrakah pads resolved on the staged tiles: 16 within 6 km
  of the nominal point. Quality pictures and contact sheets LOOKED at (pad level, 2 km, 20 km): imagery clean and
  natural; heights carry SRTM noise and faint Terrarium tile-edge lines; decision: keep Madrakah (section 5).
- 03:30. `verify.py --region` on the staged region: 23 of 27. Found: a straight trench up to 111 m deep along 19.0 N
  (corrupt Terrarium rows at an SRTM tile boundary; three pits) and relief shading in the imagery (paired E/W 1.31,
  the de-shading fit diluted by noise slopes gave alpha -0.05). Fixes as region options (Ka Lae's configuration
  hashes unchanged): `despikeBelow`, `deshadeFitMinSlopeDeg` 10. Commit 62a769e.
- 03:53-04:45. Re-bake through the gate. One run failed with a worker out of commit memory (six workers each
  rebuilding the Sentinel-2 tile lists on a loaded machine); the tile lists are now cached (s2.py) and the run
  resumed with 4 workers. A duplicate queued run was stopped before it wrote anything (no partial files).
- 04:50. Pads re-resolved: positions unchanged. Region verify: 24 of 27 (trench and pits gone; residual shading and a
  marginal seam excess: section 8). Every-commit guard before the swap: 6 of 6.
- 04:59. Swap: 20 directory renames, manifest `ab20fdfc579d4015` -> `f70a61d55dca902f`, a concurrent reader saw no
  missing tile in 7,521 reads. Guard after: heights bit-identical; full-form directory comparison: only the 840 new
  directories and `manifest.json`. site-bake tests 12 of 12 (the TerrainProvider check now covers Madrakah). Cleanup
  freed 5.95 GB. Request site-bake-1 filed.
- After 05:00 (follow-up). Coordinator's review: pads withdrawn (no built-up or corridor gate; Madrakah must keep the
  full LC-1 rule), one more Madrakah bake (land source test, near-shore sea floor, false inland water, de-shading
  refit), REPLACE swap, request for `realData.test.ts`, `bareFraction` and the tile-set hash in the pads test.
- 05:42. GLO-30 against SRTM at three points of the coastal plain, LOOKED at (section 0.4): GLO-30 clean, SRTM
  blocky noise. GLO-30 chosen. Commit 8c97640 (GLO-30 source, REPLACE mode, inland filter, waivers).
- 06:03. Replace re-bake started. 06:15-06:30 Ka Lae measured under the new gates: 9 of 16 pads (bare ground), 16
  with dry = any land (pasture, roads), Q8 fall-back 8 of 32. Commit 6c3cd4c (gates, corridors, sheets).
- 06:31. The staged sea floor LOOKED at on a profile at 19.075 N showed a sill (the ramp at -39 m 1 km out, ETOPO
  -3.5 m at 1.3 km); one review water point still water (three specks of 92 m2). Re-bake stopped; rule rewritten to
  the lead's words with a 1:50 ramp (profiles at six latitudes: section 0.5), inland specks under 2,000 m2 to land.
  Commit f9ae0b7 (also: `ka-lae.pads.json` removed, two Ka Lae candidates). Re-bake restarted 06:39 (waited for the
  bake slot), done 08:31.
- 06:50. The strict pad search took hours (LC-1's ocean test on every candidate): a grid pre-filter for it. Commit
  540d8d4.
- 08:33-09:40. Madrakah pads resolved on the staged tiles and LOOKED at, pad by pad, thirteen runs, 42 exclusions
  (roads, wadi beds, broken ground). The exclusions moved into the grid pre-filter and the ocean rays ahead of the
  windows (the runs went from 10+ minutes to 3).
- 08:35. Staged verify: 23 of 27, 2 waived (relief shading), 2 failed (the old pads file on the new heights; the
  level-11 albedo seam statistic).
- 09:42-09:44. Replace swap: 53,140 files replaced, manifest f70a61d55dca902f -> f5e6ef420bda7cea; concurrent reader
  0 missing in 174 reads. Full-form before/after: 506 region directories and `.` changed, nothing else.
- 09:55. Final Madrakah pads on the live tiles (commit a0c258b). Live verify 24 of 27, 2 waived, 1 failed. Ka Lae
  candidates re-resolved on the live tile set (identical layouts, new hash). Cleanup freed 6.33 GB (run outside the
  gate while planet-bake held the bake slot and the disk was at 26 GB: deletion only); commit ec38893.
- 10:30-10:56. Lead decisions on the report (section 0.10). Pad tool: per-site dry classes, outer-ring land cover,
  land-cover fractions per pad, fixed pads reported only, partial layouts from a minimum count; verify: bounded
  waivers. Madrakah re-resolved identically with the new fields; verify 24 of 27, 3 waived, 0 failed. Ka Lae under
  the lead's rule: 8 pads within 40 km (funnel: the corridor's built-up test removes almost everything near LC-1):
  stopped, reported. Candidate files deleted; pads test split for CI (request platform-delivery-1).
- 10:58-11:05. Lead's settlement rule for Ka Lae's corridor (section 0.11): implemented (settlement mask at 10 m,
  own-ground exception), 15 km 5 pads, 25 km 10 pads: stopped and reported.
- 11:07-11:19. The lead accepted the 25 km field. Looked at every placement; 8 exclusions, seven pads kept as seeds,
  four re-resolves: 9 pads. `ka-lae.pads.json` written; site-bake tests 16 of 16. Package closed (section 0.12).
