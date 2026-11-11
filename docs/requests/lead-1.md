Status: open
From: lead (data change of requests ocean-5 / ocean-6: eight swell components in data/defs/bodies/earth.json)
Owner path: src/core/defs/loader.test.ts (shared-code maintainer)
Blocking: no        (the mission and the ocean's specs do not depend on it; `npx vitest run src/core/defs` is red until it is done)

## Problem
The lead decision on ocean-5 / ocean-6 replaces the four physics swell components of `data/defs/bodies/earth.json`
(`ocean.swell`) with eight (a NW swell system of three and a wind sea of five; derivation in
`docs/handoff/lead-swell.md`). The loader test pins the old count, so it now fails although the data is valid
(every direction is unit to 1e-12, the renderer takes up to `MAX_SWELL` = 8 and `oceanSwellHeight` any number).

## Evidence
`src/core/defs/loader.test.ts` line 27, "loads the repository definitions and resolves every $ref":

    expect(earth.ocean?.swell.length).toBe(4);

fails with `expected 8 to be 4` after the data change (`npx vitest run src/core/defs/loader.test.ts`).

## Requested change
Line 27: hold the count to what the consumers accept instead of a fixed number, for example

    expect(earth.ocean?.swell.length).toBeGreaterThan(0);
    expect(earth.ocean!.swell.length).toBeLessThanOrEqual(8);   // MAX_SWELL of src/render/ocean/swell.ts

(or `toBe(8)` if a pinned count is preferred). Must NOT change: the unit-length check of every `dir` on the next
line, anything else in the test, the data itself (lead-owned).
