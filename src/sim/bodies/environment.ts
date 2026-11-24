/**
 * The body-system part of a VesselEnvironment (src/core/contracts/simInternal.ts): gravity, orientation,
 * spin, atmosphere, heating constants and sunlight for a vessel at a BCI position. The world orchestrator
 * adds the terrain, surface and ocean members from the TerrainProvider.
 */
import type { VesselEnvironment } from '../../core/contracts/simInternal';
import { v3, type Vec3 } from '../../core/math/vec3';
import { atmosphereFunction } from './atmosphere';
import type { BodySystem } from './bodySystem';

export type OrbitalEnvironment = Pick<VesselEnvironment, 'ut' | 'bodyId' | 'mu' | 'radius' | 'qFixedToInertial' | 'spin' | 'atmosphereAt' | 'heating' | 'sunDir' | 'sunVisibility'>;

/** Environment members that depend only on the body system, for a vessel at `rBci` (BCI of bodyId) at ut. */
export function orbitalEnvironment(system: BodySystem, bodyId: string, ut: number, rBci: Vec3): OrbitalEnvironment {
  const body = system.body(bodyId);
  return {
    ut,
    bodyId,
    mu: body.mu,
    radius: body.radius,
    qFixedToInertial: system.orientation(bodyId, ut),
    spin: v3.clone(body.spin),
    atmosphereAt: atmosphereFunction(body.def),
    heating: body.def.atmosphere ? body.def.atmosphere.heating : null,
    // in the frame of the planet system (sunDirectionAt): v1's numbers in a library rooted at a planet
    sunDir: system.sunDirectionAt(bodyId, rBci, ut).dir,
    sunVisibility: system.sunVisibilityAt(bodyId, rBci, ut),
  };
}
