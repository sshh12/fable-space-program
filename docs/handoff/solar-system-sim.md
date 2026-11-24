# solar-system-sim: hand-off (RUNNING STATE)

Wave 4.1, MIGRATION_V2 step 4.1c. The Sun-rooted body system, prediction and navigation at solar-system scale,
lazy terrain residency, reach, the transfer pilot and the activation tool. This file is kept current while the
package runs; a successor continues from it and `git log -- <owned paths>`.

## 0. Running state

Done (commit ids in `git log --oneline -- src/sim/bodies src/sim/orbit src/sim/nav tests/unit/solar-system`):
- Body system v2 (src/sim/bodies): root may be the star; `SecularKeplerEphemeris` (rates, fitted mean motion,
  exact derivative); pole frames; inverted Almanac orbit; SOI 'auto' v2 rule; `shape.ts` (surfaceRadius, floor,
  warp limits by default); `stateRelative` through the lowest common ancestor; `sunDirectionAt` /
  `sunVisibilityAt` in the planet frame; `sunVisibility` restricted to the planet system; `boundaryOf` (lost,
  photosphere); `orbitNormal`.
- Prediction (src/sim/orbit): per-patch horizon (open patch inside an SOI runs to its exit; about the root the
  horizon restarts at every SOI change), 16 patches, SOI step floor min(30 s, SOI/(4V)), adaptive closest
  approach over the patch window, `encounterRevolutions` (default 1, see request solar-system-sim-1), floors
  and spheroids in findImpact, closest approaches between two chains (chainApproach.ts) and targetApproach
  markers.
- Navigation (src/sim/nav): target.ts (relative state, LVLH, vessel target readout, navball vectors); navball
  relative markers and target mode.
- Tests: tests/unit/solar-system (bodySystem, startTime, chainApproach). One sim-orbits assertion changed: the
  'auto' SOI rule test now asserts the v2 rule (the Moon's Hill radius binds: 61.5e6 m, v1's rule gave 66.1e6 m);
  the shipped Moon states its SOI as a number and is unchanged.

Left, in order: Lambert + Hohmann/phase/windows + launch windows per pad; reach (deltaVToOrbit); acceptance
predictions on the staged library (LEO 3,600 m/s, Mars flyby with periapsis, Phobos, Triton); rails 250 years
at 1e7x; terrain lazy residency + shared store interface + measurements; transfer pilot + transfer-*.json
scenarios + flights; tools/bodies/activate.mjs; warp-level request to the lead; final hand-off.

## 1. Verification so far

- `npx vitest run src/sim/orbit src/sim/bodies src/sim/frames src/sim/nav tests/unit/sim-orbits tests/unit/bodies
  tests/unit/solar-system`: all pass.
- `npm run test:mission` (gated): 36 of 36, golden 72c0893583aa427d unchanged.
- island-core's `tests/unit/sim-world/viewReference.test.ts`: passes (3 of 3).

## 2. Public API (being written)

See the module comments of src/sim/bodies/bodySystem.ts, shape.ts, ephemeris.ts, src/sim/orbit/chainApproach.ts,
src/sim/nav/target.ts until this section is filled at the end.
