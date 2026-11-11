/**
 * The effect domain: the local frame in which particles, fireballs, drifting canopies and foam live.
 * Pure float64 bookkeeping; the GPU only ever sees small numbers relative to the domain origin.
 *
 *  - 'surface': origin fixed on the body under the focus vessel, axes = the body-fixed axes. The air is at
 *    rest in it, the ground does not move in it, gravity is uniform along -up. Used below the top of the
 *    atmosphere or below 1 % of the body radius over an airless body.
 *  - 'space': origin in free fall with the velocity the focus vessel had when the origin was (re)placed,
 *    axes = ROOT axes. No gravity relative to the frame, no air: a puff released by a coasting vessel stays
 *    with it, a burning vessel leaves it behind.
 *
 * The origin is re-based when the focus vessel has moved away; a re-base (and a change of kind) is an
 * affine map of every particle position and velocity, returned for the particle pass to apply once.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodySnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { mat3, quat, v3, type Mat3, type Vec3 } from '@/core/math';

export type DomainKind = 'surface' | 'space';

/** p' = A p + a,  v' = A v + B p + b  (all in domain coordinates before / after). */
export interface DomainRebase {
  A: Mat3;
  a: Vec3;
  B: Mat3;
  b: Vec3;
}

export interface DomainState {
  kind: DomainKind;
  bodyId: string;
  /** surface: origin in body-fixed coordinates. space: origin relative to the body centre, ROOT axes. */
  origin: Vec3;
  /** space: velocity of the origin relative to the body centre, ROOT axes, m/s. */
  velocity: Vec3;
}

export interface DomainFrame {
  state: DomainState;
  /** Map to apply to everything stored in domain coordinates this frame (null = none). */
  rebase: DomainRebase | null;
  /** True when everything stored must be dropped (first frame, or the body changed). */
  reset: boolean;
  /** Origin in the ROOT frame and velocity of the origin in ROOT axes (m/s), now. */
  originRoot: Vec3;
  velocityRoot: Vec3;
  /** Domain axes -> ROOT rotation, now. */
  q: { x: number; y: number; z: number; w: number };
  /** Local vertical at the origin in domain axes; gravity m/s^2 (0 in a space domain). */
  up: Vec3;
  gravity: number;
  /** Altitude of the origin above the reference radius, m. */
  altitude: number;
}

/** Surface domain re-base distance and space domain re-base distance / speed. */
export const SURFACE_REBASE = 3000;
export const SPACE_REBASE = 2000;
export const SPACE_REBASE_SPEED = 80;

const skew = (w: Vec3): Mat3 => [0, -w.z, w.y, w.z, 0, -w.x, -w.y, w.x, 0];
const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];

function surfaceCeiling(defs: DefLibrary, bodyId: string): number {
  const def = defs.bodies[bodyId]!;
  return Math.max(def.atmosphere ? def.atmosphere.simTop * 1.02 : 0, 0.01 * def.radius);
}

export class EffectDomain {
  private state: DomainState | null = null;

  get current(): DomainState | null {
    return this.state;
  }

  /** Advance to this snapshot. `dt` = simulated seconds since the previous call. */
  update(defs: DefLibrary, snap: SimSnapshot, focus: VesselSnapshot, dt: number): DomainFrame {
    const body = snap.bodies.find((b) => b.id === focus.bodyId)!;
    const def = defs.bodies[focus.bodyId]!;
    const altitude = v3.len(focus.r) - def.radius;
    const ceiling = surfaceCeiling(defs, focus.bodyId);
    const prev = this.state;
    let kind: DomainKind;
    if (!prev || prev.bodyId !== focus.bodyId) kind = altitude < ceiling ? 'surface' : 'space';
    else if (prev.kind === 'surface') kind = altitude > ceiling * 1.15 ? 'space' : 'surface';
    else kind = altitude < ceiling ? 'surface' : 'space';

    const R = mat3.fromQuat(body.qFixedToRoot);
    const Rt = mat3.transpose(R);
    const rFixed = mat3.mulVec(Rt, focus.r);
    let rebase: DomainRebase | null = null;
    let reset = false;

    if (!prev || prev.bodyId !== focus.bodyId) {
      reset = true;
      this.state = kind === 'surface' ? { kind, bodyId: focus.bodyId, origin: rFixed, velocity: v3.zero() } : { kind, bodyId: focus.bodyId, origin: v3.clone(focus.r), velocity: v3.clone(focus.v) };
    } else if (prev.kind === 'space') {
      // Free fall of the origin (symplectic Euler about the body centre).
      const r = v3.len(prev.origin);
      prev.velocity = v3.addScaled(prev.velocity, prev.origin, (-def.mu / (r * r * r)) * dt);
      prev.origin = v3.addScaled(prev.origin, prev.velocity, dt);
      if (kind === 'space') {
        if (v3.dist(focus.r, prev.origin) > SPACE_REBASE || v3.dist(focus.v, prev.velocity) > SPACE_REBASE_SPEED) {
          rebase = { A: IDENT, a: v3.sub(prev.origin, focus.r), B: ZERO, b: v3.sub(prev.velocity, focus.v) };
          this.state = { kind, bodyId: focus.bodyId, origin: v3.clone(focus.r), velocity: v3.clone(focus.v) };
        }
      } else {
        // space -> surface: p' = Rt (p + o) - o',  v' = Rt (v + vel - spin x (p + o)).
        const spinX = skew(body.spinRoot);
        rebase = {
          A: Rt,
          a: v3.sub(mat3.mulVec(Rt, prev.origin), rFixed),
          B: mat3.scale(mat3.mul(Rt, spinX), -1),
          b: mat3.mulVec(Rt, v3.sub(prev.velocity, v3.cross(body.spinRoot, prev.origin))),
        };
        this.state = { kind, bodyId: focus.bodyId, origin: rFixed, velocity: v3.zero() };
      }
    } else if (kind === 'surface') {
      if (v3.dist(rFixed, prev.origin) > SURFACE_REBASE) {
        rebase = { A: IDENT, a: v3.sub(prev.origin, rFixed), B: ZERO, b: v3.zero() };
        this.state = { kind, bodyId: focus.bodyId, origin: rFixed, velocity: v3.zero() };
      }
    } else {
      // surface -> space: p' = R (p + o) - o',  v' = R v + spin x R (p + o) - vel'.
      const spinX = skew(body.spinRoot);
      const oRoot = mat3.mulVec(R, prev.origin);
      rebase = {
        A: R,
        a: v3.sub(oRoot, focus.r),
        B: mat3.mul(spinX, R),
        b: v3.sub(v3.cross(body.spinRoot, oRoot), focus.v),
      };
      this.state = { kind, bodyId: focus.bodyId, origin: v3.clone(focus.r), velocity: v3.clone(focus.v) };
    }
    return this.frame(defs, body, rebase, reset);
  }

  private frame(defs: DefLibrary, body: BodySnapshot, rebase: DomainRebase | null, reset: boolean): DomainFrame {
    const s = this.state!;
    const def = defs.bodies[s.bodyId]!;
    if (s.kind === 'surface') {
      const rel = quat.rotate(body.qFixedToRoot, s.origin);
      const r = v3.len(s.origin);
      return {
        state: s,
        rebase,
        reset,
        originRoot: v3.add(body.rRoot, rel),
        velocityRoot: v3.add(body.vRoot, v3.cross(body.spinRoot, rel)),
        q: body.qFixedToRoot,
        up: v3.scale(s.origin, 1 / r),
        gravity: def.mu / (r * r),
        altitude: r - def.radius,
      };
    }
    const r = v3.len(s.origin);
    return {
      state: s,
      rebase,
      reset,
      originRoot: v3.add(body.rRoot, s.origin),
      velocityRoot: v3.add(body.vRoot, s.velocity),
      q: quat.identity(),
      up: v3.scale(s.origin, 1 / r),
      gravity: 0,
      altitude: r - def.radius,
    };
  }

  /** A ROOT-frame position / velocity in the coordinates of the domain as of `frame`. */
  static toDomain(frame: DomainFrame, posRoot: Vec3): Vec3 {
    return quat.rotateInv(frame.q, v3.sub(posRoot, frame.originRoot));
  }
  static velToDomain(frame: DomainFrame, snap: SimSnapshot, posRoot: Vec3, velRoot: Vec3): Vec3 {
    if (frame.state.kind === 'space') return v3.sub(velRoot, frame.velocityRoot);
    const body = snap.bodies.find((b) => b.id === frame.state.bodyId)!;
    const rel = v3.sub(posRoot, body.rRoot);
    return quat.rotateInv(frame.q, v3.sub(v3.sub(velRoot, body.vRoot), v3.cross(body.spinRoot, rel)));
  }
  static dirToDomain(frame: DomainFrame, dirRoot: Vec3): Vec3 {
    return quat.rotateInv(frame.q, dirRoot);
  }
}
