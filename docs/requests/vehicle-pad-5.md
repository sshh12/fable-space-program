Status: open
From: vehicle-pad
Owner path: labs/integration/main.ts (FakeSim scene `lunarSurface`: leg state and placement), src/core/fakes/fakeSim.ts if the leg state has to start there
Blocking: no (visual QA round 1, items 3, 19 and 24 are judged in these views; the vehicle lab shows the lander correctly)

## Problem
In the integration lab's `lunarSurface` scene the lander stands on the Moon with its legs STOWED: the FakeSim
starts with `legsDeployed = false`, so every legs module reports `deploy: 0`, the vessel feature draws the four
legs folded up along the descent stage (foot pads at shoulder height, pointing at the sky), and
`stackExtent` places the vessel by the stowed legs' hinge. A landed lander never looks like that; it is the
first thing a player would see after touchdown, and the three lunar views of the vehicle package are useless
for judging the legs, the foot pads and their shadows.

## Evidence
`out/screens/vehicle/game-moon-lander-landed.png`, `game-moon-lander-low-sun.png`,
`game-moon-lander-foot-pad.png` (written by `tests/browser/vehicle/game.spec.ts`, test "the lander on the real
lunar surface"); URL `/labs/integration/?hud=0&governor=off&without=cockpit&scene=lunarSurface`. Compare the
vehicle lab's `out/screens/vehicle/lander-deployed.png` (legs deployed, pads on the slab).

## Requested change
In the `lunarSurface` scene (only there), start with the legs deployed (`deploy: 1`, and `compression` at the
static value the sim uses for a landed vessel, 0 if the FakeSim has none) and place the vessel by its deployed
legs: the lowest foot-pad point is `legPose(leg, 1, compression)` from `@/render/vehicle` (foot joint in the
part frame) minus the pad's radius, or `PartDef.bounds.yMin` of the legs part as an approximation (what
`stackExtent` already uses once `deploy` is 0.5 or more). A query switch (`&legs=0`) to get the stowed state back is welcome.
Must not change: other scenes, the FakeSim's `toggleLegs` command, `hover=<m>`.

Workaround in my paths: none for the integration views; the vehicle lab (`scene=lunarSurface`) deploys the legs
and stands the lander on its pads (`lander-*` views).
