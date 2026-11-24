/**
 * Bodies as the island, its host and the view evaluate them (ARCHITECTURE section 3, "State at a tick is a
 * function of the tick"; src/sim/clock.ts).
 *
 * Everything here is a fixed function of the instant: a body's orientation is the orientation at the clock
 * base of the tick (the last whole day) plus the rotation over the seconds since, the same expression for a
 * step, a rails landing and a presentation time. Nothing remembers how a clock came to a tick.
 */
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodyInfo, BodySystem } from '../bodies/bodySystem';
import { baseTickOf, baseUtOfTick, floorTick, nearestTick, offsetOfTick, utOfTick } from '../clock';
import type { Vessel } from '../vessel';
import { bodyEnvBase, IslandEnv, OrientationCache, type BodyEnvBase } from './environment';

/** Band limit of the terrain used for impact prediction and for the events of a vessel on rails, m. */
export const IMPACT_PREDICTION_LAMBDA = 150;

export class BodyFrames {
  readonly bases = new Map<string, BodyEnvBase>();
  private readonly orient: OrientationCache;

  constructor(
    readonly system: BodySystem,
    readonly terrain: TerrainProvider,
  ) {
    this.orient = new OrientationCache(system);
    for (const id of system.ids) this.bases.set(id, bodyEnvBase(system.body(id)));
  }

  base(bodyId: string): BodyEnvBase {
    return this.bases.get(bodyId)!;
  }

  info(bodyId: string): BodyInfo {
    return this.bases.get(bodyId)!.info;
  }

  /**
   * BCBF -> ROOT orientation of a body at `ut`: the orientation at the clock base of that instant plus the
   * rotation over the seconds since. A function of the instant alone.
   */
  orientAt(bodyId: string, ut: number): Quat {
    const tick = nearestTick(ut);
    if (utOfTick(tick) === ut) {
      // An instant on the grid: whole ticks times the step (exactly uniform from step to step).
      return this.orient.at(bodyId, baseUtOfTick(tick), offsetOfTick(tick));
    }
    // An event instant inside a tick: the base of the tick it lies in, and the plain difference.
    const baseUt = utOfTick(baseTickOf(floorTick(ut)));
    return this.orient.at(bodyId, baseUt, ut - baseUt);
  }

  /** Orientation at a presentation time: `lag` seconds before `tick`, from that tick's base. */
  orientPresented(bodyId: string, tick: number, lag: number): Quat {
    return this.orient.at(bodyId, baseUtOfTick(tick), offsetOfTick(tick) - lag);
  }

  /** Aim an environment at a vessel whose BCI position about `bodyId` is `r`, at `ut` (the start of the step it is passed to). */
  aim(env: IslandEnv, bodyId: string, r: Vec3, ut: number): IslandEnv {
    const base = this.bases.get(bodyId)!;
    env.aim(base, ut, this.orientAt(bodyId, ut), Math.hypot(r.x, r.y, r.z) - base.info.radius);
    return env;
  }

  /** The sun sample of a point at BCI position `r` about `bodyId` at `ut` (`Vessel.sun`). */
  sunSample(bodyId: string, r: Vec3, ut: number): { dir: Vec3; visibility: number } {
    const posRoot = v3.add(this.system.stateRoot(bodyId, ut).r, r);
    return { dir: this.system.sunDirection(posRoot, ut).dir, visibility: this.system.sunVisibility(posRoot, ut) };
  }

  /** The band-limited surface the events of a conic are found against. */
  readonly coarseHeight = (bodyId: string, dirFixed: Vec3): number => this.terrain.heightAt(bodyId, dirFixed, IMPACT_PREDICTION_LAMBDA);

  /** Gravitational acceleration of a body at a position about it, m/s^2 (the surface value at the centre). */
  gravityAt(bodyId: string, r: Vec3): number {
    const info = this.info(bodyId);
    const rl2 = r.x * r.x + r.y * r.y + r.z * r.z;
    return info.mu / (rl2 > 0 ? rl2 : info.radius * info.radius);
  }
}

/** Centre-of-mass state of a vessel in the frame its `r`, `v` are in. */
export function comStateOf(v: Vessel): { r: Vec3; v: Vec3 } {
  const com = v.mp.com;
  return { r: v3.add(v.r, quat.rotate(v.q, com)), v: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, com))) };
}

/** Set a vessel's origin state from the state of its centre of mass (the attitude and the body rate stand). */
export function setFromCom(v: Vessel, rCom: Vec3, vCom: Vec3): void {
  const com = v.mp.com;
  const off = quat.rotate(v.q, com);
  const voff = quat.rotate(v.q, v3.cross(v.w, com));
  v.r.x = rCom.x - off.x;
  v.r.y = rCom.y - off.y;
  v.r.z = rCom.z - off.z;
  v.v.x = vCom.x - voff.x;
  v.v.y = vCom.y - voff.y;
  v.v.z = vCom.z - voff.z;
}
