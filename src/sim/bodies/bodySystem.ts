/**
 * The body system: every body of a DefLibrary with its ephemeris, rotation, SOI and lighting, as pure
 * functions of `ut`. Built once per library (createBodySystem) and shared by the world, the predictor,
 * the navigation readouts and the tools.
 *
 * Frames: ROOT = BCI of the root body (the root sits at the origin). BCI(b) axes are parallel to ROOT, so
 * a body's BCBF -> BCI orientation is also its BCBF -> ROOT orientation.
 */
import { WARP_LEVELS, MAX_PHYSICS_WARP_INDEX, type BodyDef, type DefLibrary } from '../../core/contracts/defs';
import type { BodySnapshot } from '../../core/contracts/sim';
import type { StateVector } from '../../core/contracts/simInternal';
import { DefError } from '../../core/defs/loader';
import { conicFromState, type ConicElements } from '../../core/math/conic';
import { quat, type Quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import { KeplerEphemeris, Q_ECLIPTIC_TO_EQUATORIAL, SunLowPrecisionEphemeris, type Ephemeris } from './ephemeris';
import { orientationAt, poleQuat, rotationModel, spinVector, type RotationModel } from './rotation';
import { sunVisibleFraction, type OccultingSphere } from './sunVisibility';

/** Number of rails warp levels (entries every attractor's warpAltitudeLimits must have). */
export const RAILS_WARP_LEVEL_COUNT = WARP_LEVELS.length - MAX_PHYSICS_WARP_INDEX - 1;

export interface BodyInfo {
  readonly id: string;
  readonly def: BodyDef;
  readonly mu: number;
  readonly radius: number;
  readonly parentId: string | null;
  /** Attractor bodies orbiting this one (their SOIs nest inside this body's), sorted by id. */
  readonly childIds: readonly string[];
  /** Resolved SOI radius ('auto' = a (m/M)^0.4); null for the root body and light-only bodies (unbounded / none). */
  readonly soiRadius: number | null;
  /** Takes part in patched conics. */
  readonly attractor: boolean;
  /** Emits light (has an emission block). */
  readonly star: boolean;
  /** Kepler ephemeris about the parent, when the orbit is 'kepler'. */
  readonly kepler: KeplerEphemeris | null;
  readonly rotation: RotationModel;
  /** Fixed spin vector in ROOT axes, rad/s. */
  readonly spin: Vec3;
}

export interface BodySystem {
  readonly defs: DefLibrary;
  readonly rootId: string;
  /** The body that lights the system. */
  readonly starId: string;
  /** All body ids, parents before children, siblings by id. */
  readonly ids: readonly string[];
  body(id: string): BodyInfo;
  /** State relative to the parent in the parent's BCI axes (zero for the root). */
  stateRelParent(id: string, ut: number): StateVector;
  /** Body-centre state in ROOT. */
  stateRoot(id: string, ut: number): StateVector;
  /** State of `id` relative to `originId` (ROOT axes). */
  stateRelative(id: string, originId: string, ut: number): StateVector;
  /** BCBF -> ROOT (= BCBF -> BCI) orientation. */
  orientation(id: string, ut: number): Quat;
  /** Spin vector in ROOT axes, rad/s. */
  spin(id: string): Vec3;
  /**
   * Orbit about the parent as a conic in the parent's BCI frame, with tPeriapsis = the periapsis passage
   * nearest `ut`. Null for the root and for non-Kepler orbits (the star).
   */
  orbitConic(id: string, ut: number): ConicElements | null;
  /** Unit direction (ROOT axes) and distance from a ROOT position to the star centre. */
  sunDirection(posRoot: Vec3, ut: number): { dir: Vec3; distance: number };
  /** Visible fraction of the star's disc at a ROOT position, behind every other body (0 umbra .. 1). */
  sunVisibility(posRoot: Vec3, ut: number): number;
  /** One BodySnapshot per body in `ids` order. */
  buildBodySnapshots(ut: number): BodySnapshot[];
}

function sortIds(bodies: Record<string, BodyDef>, rootId: string): string[] {
  const out: string[] = [];
  const visit = (id: string): void => {
    out.push(id);
    const kids = Object.values(bodies)
      .filter((b) => b.parent === id)
      .map((b) => b.id)
      .sort();
    for (const k of kids) visit(k);
  };
  visit(rootId);
  const missing = Object.keys(bodies).filter((id) => !out.includes(id));
  if (missing.length) throw new DefError('bodies', `bodies not connected to the root "${rootId}": ${missing.join(', ')}`);
  return out;
}

class BodySystemImpl implements BodySystem {
  readonly defs: DefLibrary;
  readonly rootId: string;
  readonly starId: string;
  readonly ids: readonly string[];
  private readonly info = new Map<string, BodyInfo>();
  private readonly eph = new Map<string, Ephemeris | null>();
  private readonly baseConic = new Map<string, ConicElements | null>();
  private readonly occulters: string[];

  constructor(defs: DefLibrary) {
    this.defs = defs;
    const roots = Object.values(defs.bodies).filter((b) => b.parent === null);
    if (roots.length !== 1) throw new DefError('bodies', `expected exactly one root body, found ${roots.length}`);
    this.rootId = defs.rootBodyId || roots[0]!.id;
    this.ids = sortIds(defs.bodies, this.rootId);
    const stars = this.ids.filter((id) => defs.bodies[id]!.emission !== null);
    if (stars.length !== 1) throw new DefError('bodies', `expected exactly one body with "emission" (the star), found ${stars.length}`);
    this.starId = stars[0]!;

    // Ephemerides first (parents before children), then rotations and SOIs.
    for (const id of this.ids) {
      const b = defs.bodies[id]!;
      const file = `bodies/${id}.json`;
      if (b.parent === null) {
        this.eph.set(id, null);
        continue;
      }
      const parent = defs.bodies[b.parent]!;
      const o = b.orbit;
      if (!o) throw new DefError(file, 'non-root body needs an orbit');
      if (o.kind === 'kepler') {
        let qPlane: Quat = quat.identity();
        if (o.frame === 'ecliptic') qPlane = Q_ECLIPTIC_TO_EQUATORIAL;
        else if (parent.rotation.mode !== 'none') qPlane = poleQuat(parent.rotation.poleRaDeg, parent.rotation.poleDecDeg);
        this.eph.set(id, new KeplerEphemeris(o, parent.mu + b.mu, qPlane));
      } else {
        if (b.parent !== this.rootId) throw new DefError(file, "orbit 'sunLowPrecision' is defined relative to the root body only");
        this.eph.set(id, new SunLowPrecisionEphemeris());
      }
    }
    for (const id of this.ids) {
      const b = defs.bodies[id]!;
      const file = `bodies/${id}.json`;
      const e = this.eph.get(id);
      const kepler = e instanceof KeplerEphemeris ? e : null;
      const attractor = b.gravityRole === 'attractor';
      let soi: number | null = null;
      if (b.parent !== null && attractor) {
        if (b.soiRadius === null) throw new DefError(file, 'a non-root attractor needs soiRadius (number or "auto")');
        if (b.soiRadius === 'auto') {
          if (!kepler) throw new DefError(file, 'soiRadius "auto" needs a kepler orbit');
          soi = kepler.a * Math.pow(b.mu / defs.bodies[b.parent]!.mu, 0.4);
        } else soi = b.soiRadius;
        if (!(soi > b.radius)) throw new DefError(file, 'soiRadius must exceed the radius');
      }
      if (attractor && b.warpAltitudeLimits.length !== RAILS_WARP_LEVEL_COUNT) {
        throw new DefError(file, `warpAltitudeLimits needs ${RAILS_WARP_LEVEL_COUNT} entries (one per rails warp level), found ${b.warpAltitudeLimits.length}`);
      }
      const rot = rotationModel(b.rotation, kepler, id);
      const childIds = this.ids.filter((c) => defs.bodies[c]!.parent === id && defs.bodies[c]!.gravityRole === 'attractor').sort();
      this.info.set(id, {
        id,
        def: b,
        mu: b.mu,
        radius: b.radius,
        parentId: b.parent,
        childIds,
        soiRadius: soi,
        attractor,
        star: b.emission !== null,
        kepler,
        rotation: rot,
        spin: spinVector(rot),
      });
      this.baseConic.set(id, kepler ? this.makeConic(id, kepler.epochUt) : null);
    }
    this.occulters = this.ids.filter((id) => id !== this.starId);
  }

  private makeConic(id: string, ut: number): ConicElements {
    const b = this.defs.bodies[id]!;
    const parent = this.defs.bodies[b.parent!]!;
    const s = this.eph.get(id)!.stateAt(ut);
    return conicFromState(parent.mu + b.mu, s.r, s.v, ut);
  }

  body(id: string): BodyInfo {
    const b = this.info.get(id);
    if (!b) throw new Error(`BodySystem: unknown body "${id}"`);
    return b;
  }

  stateRelParent(id: string, ut: number): StateVector {
    const e = this.eph.get(id);
    if (e === undefined) throw new Error(`BodySystem: unknown body "${id}"`);
    return e === null ? { r: v3.zero(), v: v3.zero() } : e.stateAt(ut);
  }

  stateRoot(id: string, ut: number): StateVector {
    let s = this.stateRelParent(id, ut);
    let p = this.defs.bodies[id]!.parent;
    while (p !== null && p !== this.rootId) {
      const ps = this.stateRelParent(p, ut);
      s = { r: v3.add(s.r, ps.r), v: v3.add(s.v, ps.v) };
      p = this.defs.bodies[p]!.parent;
    }
    return s;
  }

  stateRelative(id: string, originId: string, ut: number): StateVector {
    if (id === originId) return { r: v3.zero(), v: v3.zero() };
    const a = this.stateRoot(id, ut);
    const b = this.stateRoot(originId, ut);
    return { r: v3.sub(a.r, b.r), v: v3.sub(a.v, b.v) };
  }

  orientation(id: string, ut: number): Quat {
    return orientationAt(this.body(id).rotation, ut);
  }

  spin(id: string): Vec3 {
    return v3.clone(this.body(id).spin);
  }

  orbitConic(id: string, ut: number): ConicElements | null {
    const base = this.baseConic.get(id);
    if (!base) return null;
    const P = base.period!;
    const k = Math.round((ut - base.tPeriapsis) / P);
    return { ...base, P: v3.clone(base.P), Q: v3.clone(base.Q), W: v3.clone(base.W), tPeriapsis: base.tPeriapsis + k * P };
  }

  sunDirection(posRoot: Vec3, ut: number): { dir: Vec3; distance: number } {
    const d = v3.sub(this.stateRoot(this.starId, ut).r, posRoot);
    const distance = v3.len(d);
    return { dir: v3.scale(d, 1 / distance), distance };
  }

  sunVisibility(posRoot: Vec3, ut: number): number {
    const star = this.defs.bodies[this.starId]!;
    const starPos = this.stateRoot(this.starId, ut).r;
    const spheres: OccultingSphere[] = this.occulters.map((id) => ({ centre: this.stateRoot(id, ut).r, radius: this.defs.bodies[id]!.radius }));
    return sunVisibleFraction(posRoot, starPos, star.emission!.radius, spheres);
  }

  buildBodySnapshots(ut: number): BodySnapshot[] {
    const starPos = this.stateRoot(this.starId, ut).r;
    const rootToStar = v3.normalize(starPos);
    return this.ids.map((id) => {
      const info = this.info.get(id)!;
      const s = this.stateRoot(id, ut);
      const isStar = id === this.starId;
      const toSun = v3.sub(starPos, s.r);
      const dist = v3.len(toSun);
      return {
        id,
        rRoot: s.r,
        vRoot: s.v,
        qFixedToRoot: this.orientation(id, ut),
        spinRoot: v3.clone(info.spin),
        sunDir: isStar ? rootToStar : v3.scale(toSun, 1 / dist),
        sunDistance: isStar ? 0 : dist,
        orbit: this.orbitConic(id, ut),
        soiRadius: info.soiRadius,
      };
    });
  }
}

/** Build the body system of a definition library (validates the body definitions it consumes). */
export function createBodySystem(defs: DefLibrary): BodySystem {
  return new BodySystemImpl(defs);
}
