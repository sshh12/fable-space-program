Status: open
From: fleet-data
Owner path: tools/vehicle/site-ground.ts (vehicle-pad's tool), data/defs/visuals/sites/** (its section files)
Blocking: no (the new pads carry no structures until surveyed)

## Problem
`tools/vehicle/site-ground.ts` surveys the FIRST pad of a site only (lead-baseline-v2 section 27, item 5): the
section `visuals/sites/<site>` holds `survey` for the first pad and `pads[<id>].survey` for others, and
`siteGround` throws for a pad with structures and no survey. fleet-data wrote 24 new pads (Ka Lae lc-2 .. lc-9,
Madrakah lc-1 .. lc-16) with `structures: []`, because no survey supports them; the launch-complex visuals of
those pads are fleet-models-pads' (wave 5.1).

## Evidence
data/defs/sites/ka-lae.json, data/defs/sites/madrakah.json (every new pad: `"structures": []`);
src/render/vehicle/site/survey.ts lines 54-61.

## Requested change
Survey every pad of a site: write `pads[<pad id>].survey` into `visuals/sites/<site>.json` for each pad that is not
the first (and a section `visuals/sites/madrakah.json` with the first pad's `survey`), with the pad's own flat
and blend radii from the site file (heavy 450 / 900 m, medium 300 / 600 m, light 150 / 300 m), its mount height
(heavy 18 m, medium 10 m, light 4 m) and its centre from `location.pads`. What the files need from the survey: the
ground under each structure a pad of its class will carry (fleet-models-pads chooses them), so `siteGround`
answers for every pad. Must NOT change: LC-1's survey (the reference images of the pad rest on it).
