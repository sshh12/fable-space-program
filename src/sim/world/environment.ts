/**
 * VesselEnvironment instances of the world orchestrator (src/core/contracts/simInternal.ts): the body
 * system supplies gravity, orientation, spin, atmosphere, heating and sunlight; the TerrainProvider
 * supplies the solid surface; the ocean is sea level plus the shared analytic swell.
 *
 * One WorldEnv object is kept per vessel and re-aimed (`aim`) at the start of every step, so stepping
 * allocates nothing. The environment describes the START of the step it is passed to.
 */
import type { BodyDef } from '@/core/contracts/defs';
import type { AtmosphereSample, VesselEnvironment } from '@/core/contracts/simInternal';
import { VACUUM } from '@/core/contracts/simInternal';
import type { SurfaceKind, TerrainProvider } from '@/core/contracts/terrain';
import { oceanSwellHeight } from '@/core/geo/oceanSwell';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';
import { atmosphereFunction } from '../bodies/atmosphere';
import type { BodyInfo, BodySystem } from '../bodies/bodySystem';

/** Altitude above which `surfaceKind` is decided from the band-limited surface instead of the collision surface, m. */
const SURFACE_KIND_COLLISION_CEILING = 3000;

const NO_ATMOSPHERE = (): AtmosphereSample => VACUUM;

/** Per-body constants shared by every environment on that body. */
export interface BodyEnvBase {
  info: BodyInfo;
  def: BodyDef;
  hasTerrain: boolean;
  atmosphereAt: (altitude: number) => AtmosphereSample;
  seaLevel: number;
  surfaceGravity: number;
}

export function bodyEnvBase(info: BodyInfo): BodyEnvBase {
  const def = info.def;
  return {
    info,
    def,
    hasTerrain: def.terrain !== null,
    atmosphereAt: def.atmosphere ? atmosphereFunction(def) : NO_ATMOSPHERE,
    seaLevel: def.ocean ? def.ocean.seaLevel : 0,
    surfaceGravity: info.mu / (info.radius * info.radius),
  };
}

export class WorldEnv implements VesselEnvironment {
  ut = 0;
  bodyId = '';
  mu = 0;
  radius = 0;
  qFixedToInertial: Quat = { x: 0, y: 0, z: 0, w: 1 };
  spin: Vec3 = { x: 0, y: 0, z: 0 };
  atmosphereAt: (altitude: number) => AtmosphereSample = NO_ATMOSPHERE;
  heating: VesselEnvironment['heating'] = null;
  surfaceFriction = 0.8;
  ocean: VesselEnvironment['ocean'] = null;
  sunDir: Vec3 = { x: 1, y: 0, z: 0 };
  sunVisibility = 1;

  /** Altitude of the vessel this environment is aimed at (selects how surfaceKind is evaluated). */
  private vesselAltitude = 0;
  private base: BodyEnvBase | null = null;
  private readonly oceanImpl: NonNullable<VesselEnvironment['ocean']>;

  constructor(private readonly terrain: TerrainProvider) {
    this.oceanImpl = {
      density: 0,
      waterHeight: (dirFixed: Vec3): number => {
        const b = this.base!;
        const o = b.def.ocean!;
        return o.seaLevel + oceanSwellHeight(o.swell, b.surfaceGravity, b.info.radius + o.seaLevel, dirFixed, this.ut);
      },
    };
  }

  readonly terrainHeight = (dirFixed: Vec3, lambdaMin?: number): number => {
    if (!this.base!.hasTerrain) return 0;
    return this.terrain.heightAt(this.bodyId, dirFixed, lambdaMin);
  };

  readonly terrainNormal = (dirFixed: Vec3, baseline = 1): Vec3 => {
    if (!this.base!.hasTerrain) return { x: dirFixed.x, y: dirFixed.y, z: dirFixed.z };
    return this.terrain.normalAt(this.bodyId, dirFixed, baseline);
  };

  readonly surfaceKind = (dirFixed: Vec3): SurfaceKind => {
    const b = this.base!;
    if (!b.def.ocean) return 'land';
    if (!b.hasTerrain) return 'water';
    // High above the surface the answer only selects which level the altimetry refers to: use the cheap
    // band-limited surface there and the collision surface (what contact sees) near the ground.
    if (this.vesselAltitude > SURFACE_KIND_COLLISION_CEILING) {
      return this.terrain.heightAt(this.bodyId, dirFixed, Math.max(0.3, 0.02 * this.vesselAltitude)) < b.seaLevel ? 'water' : 'land';
    }
    return this.terrain.surfaceKind(this.bodyId, dirFixed);
  };

  /** Point the environment at body `base` at time `ut` for a vessel at altitude `altitude` above the datum. */
  aim(base: BodyEnvBase, ut: number, qFixedToInertial: Quat, altitude: number): void {
    this.base = base;
    this.ut = ut;
    this.bodyId = base.info.id;
    this.mu = base.info.mu;
    this.radius = base.info.radius;
    this.qFixedToInertial = qFixedToInertial;
    this.spin = base.info.spin;
    this.atmosphereAt = base.atmosphereAt;
    this.heating = base.def.atmosphere ? base.def.atmosphere.heating : null;
    this.surfaceFriction = base.def.terrain ? base.def.terrain.surfaceFriction : 0.8;
    this.vesselAltitude = altitude;
    if (base.def.ocean) {
      this.oceanImpl.density = base.def.ocean.density;
      this.ocean = this.oceanImpl;
    } else this.ocean = null;
  }
}

/** Body orientation cache for one instant: orientation quaternions are evaluated once per body per time. */
export class OrientationCache {
  private ut = NaN;
  private readonly q = new Map<string, Quat>();
  constructor(private readonly system: BodySystem) {}
  at(bodyId: string, ut: number): Quat {
    if (ut !== this.ut) {
      this.q.clear();
      this.ut = ut;
    }
    let q = this.q.get(bodyId);
    if (!q) {
      q = this.system.orientation(bodyId, ut);
      this.q.set(bodyId, q);
    }
    return q;
  }
}
