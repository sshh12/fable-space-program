Status: resolved (commit 2c879f1)
From: lead
Owner path: tests/unit/terrain-core/realData.test.ts (shared-code maintainer), src/terrain/modifiers.ts
Blocking: no

## Problem
`tests/unit/terrain-core/realData.test.ts > launch-site pads are flat within 5 cm` fails (worst 2.67 m). It was
red before the v2 lead step and is the only failing unit test in the tree. The pad shape changed with request
terrain-render-6 (a quarter of the natural relief and the rocks came back around the pad; `pad.flatRadius` /
`blendRadius` in data/defs/sites/ka-lae-lc1.json), but the test still asserts the whole disc.

## Evidence
`node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/terrain-core/realData.test.ts` (reported by
the lead-baseline-v2 step, docs/handoff/lead-baseline-v2.md).

## Requested change
Decide which is right and make the suite green at the cause: the test asserts flatness only where the site
definition says the pad is flat (inside `flatRadius`), and the blend ring is asserted to be continuous and
bounded instead; or, if the vehicle's footprint or the launch mount needs the wider disc flat, restore that and
say so. The vehicle must still stand on the pad in the mission (tests/mission) and the site meshes must still
meet the ground (vehicle-pad's pad views).

## Resolution (shared-code maintainer)
The shaped pad is right and the test was stale: fixed in `2c879f1` (the request crossed with it), nothing in
`src/terrain/modifiers.ts`.

- What is flat is what the site definition says is flat. The contract (`SitePadShapeDef`, request
  terrain-render-6): with `pad.shape` the ground is EXACTLY flat only inside `shape.coreRadius` and on
  `shape.areas`; elsewhere inside `pad.flatRadius` the natural relief keeps the share `shape.reliefShare`,
  returning fully by `pad.blendRadius`. A site without `shape` is flat over `flatRadius` as before.
- `tests/unit/terrain-core/realData.test.ts`, "launch-site pads are flat within 5 cm: over flatRadius, or over the
  core and the areas of a shaped pad": for `ka-lae-lc1` on the real tiles the largest deviation over the core
  (115 m) is 8.4e-7 m and on the five areas 8.4e-7 m (asserted under 5 cm), and inside `flatRadius` (450 m,
  relief share 0.25) it is 2.65 m (asserted above 5 cm, since a share of the relief is kept, and under 15 m).
  The pad elevation still equals `location.padElevation` to six digits.
- The ragged blends and their continuity are held by the package's synthetic tests, unchanged
  (`tests/unit/terrain-core/pad.test.ts`: "has ragged edges", "level the core and every area exactly";
  `continuity.test.ts`).
- The vehicle and the mount do not need the wider disc: the stack's footprint is 9 m and the site's slabs are
  the five areas, all inside the flat parts. The mission's lift-off and the site meshes are as they were (no
  terrain data or modifier changed in this round).

The unit suite on the tree at 00:10: 111 files, 1,252 tests, all green.

