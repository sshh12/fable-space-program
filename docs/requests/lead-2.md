Status: open
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
