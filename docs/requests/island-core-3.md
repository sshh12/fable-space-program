Status: resolved (solar-system-sim, the provider side; island-core takes it in src/sim)
From: island-core
Owner path: src/terrain/provider.ts, src/terrain/evaluator.ts (the terrain package); src/core/contracts/terrain.ts (the lead)
Blocking: no        (the EXACT comparison of the mission record differs in one read-out between two flights with identical state; nothing of the flight depends on it that the golden shows)

## Problem
A band-limited height query, `TerrainProvider.heightAt(bodyId, dir, lambdaMin)`, answers from whatever tiles
are resident at the point: with a band finer than the body's pinned pyramid it truncates at the finest
RESIDENT level. The same query on the same simulation state therefore gives different numbers depending on
which discs earlier, unrelated requests left in the cache. The simulation and the view ask such queries at
`lambdaMin = max(0.3, 0.02 x altitude)` (radar altitude: `probeClearance` in src/sim/vessel/facade.ts,
the island's terrain regime in `terrainWork`) and at 150 m (the events of a conic and the impact marker:
`IMPACT_PREDICTION_LAMBDA`), i.e. finer than the Moon's pinned pyramid below about 200 km.
This is the cause of review finding 16: `LUNAR_ORBIT.data.radarAltitude` was 104688.159 in the records of
2026-11-24 and is 104688.063 since commit 4c9a569, which changed what the view predicts (the three-period
encounter search, and with it the impact hints) and how the real-world tools preload terrain; which of the
two moved the resident tiles near that sub-point was not isolated. State, position and altitude are equal
to the bit in both.

## Evidence
`createRealTerrain`, the Moon, the direction of latitude 2.5877 deg, longitude 171.5265 deg (the milestone's
sub-point), `lambdaMin` = 2,100 m:
- a fresh provider (the pinned pyramid only): 313.59768311058315 m, and the same number for every band from
  500 m to 2,100 m (the answer is the pyramid's finest level, whatever was asked);
- after `ensureLoaded` of a 30 km disc centred 24 km from the point: 313.69507630361676 m (lambda 2,000:
  313.745; 1,000: 317.290; 500: 324.470);
- bands of 4,000 m and coarser: equal in both (347.61297117547895 at 4,000 m).
The difference at 2,100 m, 0.097 m, is the difference of the two records.

## Requested change
One of, in the provider (the contract's sentence "deterministic and pure given the same resident data" is
what makes a read-out depend on the cache):
1. a band-limited query answers from the PINNED pyramid only unless the caller holds a slot that covers the
   point (`ensureLoaded`), so that its value is a function of the body, the direction, the band and the
   caller's own requests; or
2. `TerrainProvider.pinnedBand(bodyId): number` (the finest wavelength the pinned pyramid resolves
   everywhere), so that the simulation can clamp `lambdaMin` to it wherever it has not asked for final data.
With either, `radarAltitude` above the terrain regime, the events of a conic and the impact marker are
functions of the state. island-core then uses it in src/sim/island (`IslandEnv.terrainHeight`) and
src/sim/vessel/facade.ts. Must NOT change: full-detail queries (`lambdaMin` absent) and the collision
surface, which contact uses on final data only.

## Resolution (solar-system-sim)
Option 2, on the provider's authority (src/terrain/provider.ts, `TerrainAuthority`; the contract's
`TerrainProvider` is unchanged, so nothing of the lead's moves):
- `pinnedBand(bodyId): number` - the data wavelength of the body's resident (pinned) level R, lambda0 2^-R: the
  Moon's is 2,665.1 m. At or above it the data chain reads levels 0..R only (level R + 1 has weight zero there) and
  the amplification's data scale is capped at R, so the answer does not depend on the cache.
- `stableHeightAt(bodyId, dir, lambdaMin)` = `heightAt(bodyId, dir, max(lambdaMin, pinnedBand(bodyId)))`: the
  height a read-out takes, a function of the body, the direction and the band once the body's resident pyramid is
  in (always for a preloaded body; a lazy body not loaded yet answers the datum, as heightAt does).
Test: tests/unit/terrain-core/readoutHeight.test.ts, the request's point and disc: `heightAt(moon, p, 2100)`
313.6666245059246 m before and 313.76469109250087 m after a 30 km disc 24 km away is made resident;
`stableHeightAt` 313.6666245059246 m both times, equal to the bit; at 4,000 m and above the two are one query.
For island-core: take `stableHeightAt` (or clamp to `pinnedBand`) wherever a read-out or an event is computed from
a band-limited height and no slot of the caller covers the point: `probeClearance` (radar altitude) in
src/sim/vessel/facade.ts above the terrain regime, the coarse height of the conic's events and of the impact marker
(`IMPACT_PREDICTION_LAMBDA`, `frames.coarseHeight`). Full-detail queries and the collision surface are unchanged.
