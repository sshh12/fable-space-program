/**
 * The body system: every body of a DefLibrary with its ephemeris, rotation, SOI and lighting, as pure
 * functions of `ut`. Built once per library (createBodySystem) and shared by the world, the predictor,
 * the navigation readouts and the tools.
 *
 * Frames: the system ROOT = BCI of the root body (the root sits at the origin). BCI(b) axes are parallel to
 * it, so a body's BCBF -> BCI orientation is also its BCBF -> ROOT orientation. (The RENDER root handed to
 * presentation is chosen by the view, ARCHITECTURE 3; this file's ROOT is the system root.)
 *
 * v2 (ARCHITECTURE 8; MIGRATION_V2 step 4.1c). The root may be the star and an attractor (the Sun-rooted
 * library: Sun, 8 planets, 20 moons, Ceres, Pluto, Charon); every v2 member of the body contract is honoured:
 *  - orbits: 'kepler' with secular rates and the fitted mean motion (SecularKeplerEphemeris), in the plane
 *    frames 'ecliptic', 'parentEquator' and an explicit pole; a frozen ellipse (no rates, no fitted mean
 *    motion) stays the v1 KeplerEphemeris to the bit; 'sunLowPrecision' about the root, `inverted` for a planet
 *    about the star (the Earth: minus the Almanac Sun vector, so the Sun's direction at the Earth reproduces
 *    v1 to the bit);
 *  - `soiRadius: 'auto'` = min(Hill radius a (m / 3M)^(1/3), max(a (m/M)^(2/5), 2.5 R)) (Phobos 16.6 km,
 *    Deimos 15.5 km, Mimas 495 km);
 *  - `shape`, `surface: 'none'` with `atmosphere.floorAltitude`, and the rails warp limits by default from the
 *    radius and the atmosphere top (src/sim/bodies/shape.ts);
 *  - `sunVisibility` looks only at the bodies of the planet system the position is in;
 *  - the rules a universe applies at the edges of the system, as queries (`boundaryOf`): escape beyond the
 *    rules' lost distance from the root, and the star's photosphere.
 * For a library rooted at the Earth (the shipped three bodies: the Sun a light-only child on the Almanac
 * formula) every number is what v1 computed.
 */
import { type BodyDef, type DefLibrary, type KeplerOrbitDef } from '../../core/contracts/defs';
import type { BodySnapshot } from '../../core/contracts/sim';
import type { StateVector } from '../../core/contracts/simInternal';
import { DefError } from '../../core/defs/loader';
import { conicFromState, type ConicElements } from '../../core/math/conic';
import { quat, type Quat } from '../../core/math/quat';
import { v3, type Vec3 } from '../../core/math/vec3';
import { AU, KeplerEphemeris, Q_ECLIPTIC_TO_EQUATORIAL, SecularKeplerEphemeris, SunLowPrecisionEphemeris, type OrbitEphemeris } from './ephemeris';
import { orientationAt, poleQuat, rotationModel, spinVector, type RotationModel } from './rotation';
import { floorAltitude, RAILS_LEVELS, surfaceRadius, warpAltitudeLimitsOf } from './shape';
import { sunVisibleFraction, type OccultingSphere } from './sunVisibility';

/** Number of rails warp levels (entries every attractor's warp limits resolve to). */
export const RAILS_WARP_LEVEL_COUNT = RAILS_LEVELS;

export interface BodyInfo {
  readonly id: string;
  readonly def: BodyDef;
  readonly mu: number;
  readonly radius: number;
  readonly parentId: string | null;
  /** Attractor bodies orbiting this one (their SOIs nest inside this body's), sorted by id. */
  readonly childIds: readonly string[];
  /**
   * Resolved SOI radius ('auto' = min(Hill, max(a (m/M)^0.4, 2.5 R))); null for the root body and light-only
   * bodies (unbounded / none).
   */
  readonly soiRadius: number | null;
  /** Takes part in patched conics. */
  readonly attractor: boolean;
  /** Emits light (has an emission block). */
  readonly star: boolean;
  /** The v1 frozen Kepler ephemeris about the parent (a 'kepler' orbit without rates or fitted mean motion), else null. */
  readonly kepler: KeplerEphemeris | null;
  /** The orbit about the parent, any kind (null for the root). */
  readonly ephemeris: OrbitEphemeris | null;
  readonly rotation: RotationModel;
  /** Fixed spin vector in ROOT axes, rad/s. */
  readonly spin: Vec3;
  /** Rails warp limits, one per rails level (stated, or by default from the radius and atmosphere top). */
  readonly warpAltitudeLimits: readonly number[];
  /** 'none' = a body without a solid surface (a giant). */
  readonly surface: 'solid' | 'none';
  /**
   * The planet system the body belongs to: the highest ancestor that is not the star and whose parent is the
   * star or nothing (a planet for a planet or its moons; the root itself in a library rooted at a planet);
   * null for the star.
   */
  readonly systemId: string | null;
}

/** What happens to a vessel at the edges of the system (ARCHITECTURE 8.3), as `boundaryOf` reports it. */
export type SystemBoundary = 'lost' | 'photosphere' | null;

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
   * Orbit about the parent as a conic in the parent's BCI frame. A frozen ellipse: its fixed conic with
   * tPeriapsis = the periapsis passage nearest `ut`; a precessing orbit or an inverted Almanac orbit: the
   * osculating conic of the state at `ut`. Null for the root and for the v1 star on the Almanac formula.
   */
  orbitConic(id: string, ut: number): ConicElements | null;
  /** Unit normal of the body's orbit plane about its parent at ut (ROOT axes); null for the root. */
  orbitNormal(id: string, ut: number): Vec3 | null;
  /** Unit direction (ROOT axes) and distance from a ROOT position to the star centre. */
  sunDirection(posRoot: Vec3, ut: number): { dir: Vec3; distance: number };
  /**
   * The same for a point given in BCI of `bodyId`, computed in the frame of its planet system (the planet),
   * so a heliocentric root costs no digits: v1's numbers in a library rooted at a planet.
   */
  sunDirectionAt(bodyId: string, rBci: Vec3, ut: number): { dir: Vec3; distance: number };
  /** `sunVisibility` for a point given in BCI of `bodyId`, in the frame of its planet system (see sunDirectionAt). */
  sunVisibilityAt(bodyId: string, rBci: Vec3, ut: number): number;
  /**
   * Visible fraction of the star's disc at a ROOT position (0 umbra .. 1), behind the bodies of the planet
   * system the position is in: that of `bodyId` (the SOI body of the position) when given, else the planet
   * whose sphere of influence holds the position, else (in the star's own sphere) the planets themselves.
   * In a library rooted at a planet every body but the star is one system, so this is v1's number.
   */
  sunVisibility(posRoot: Vec3, ut: number, bodyId?: string): number;
  /** Reference-surface radius of the body under a body-fixed direction (src/sim/bodies/shape.ts). */
  surfaceRadius(id: string, dirFixed: Vec3): number;
  /**
   * The edges of the system for a vessel at `r`, `v` (BCI of `bodyId`): 'lost' when it is in the root's
   * sphere, farther than `lostDistance` (UniverseRules.expiry.lostDistance) from the root and not bound to it;
   * 'photosphere' when it is inside the star's photosphere; else null.
   */
  boundaryOf(bodyId: string, r: Vec3, v: Vec3, lostDistance: number): SystemBoundary;
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

/** True when a 'kepler' orbit states any v2 member (rates or a fitted mean motion): a SecularKeplerEphemeris. */
const isSecular = (o: KeplerOrbitDef): boolean => o.rates !== undefined || o.meanMotionDegPerDay !== undefined;

/** Plane of a 'kepler' orbit in the parent's BCI axes. */
function planeOf(o: KeplerOrbitDef, parent: BodyDef, file: string): Quat {
  const f = o.frame;
  if (f === 'ecliptic') return Q_ECLIPTIC_TO_EQUATORIAL;
  if (f === 'parentEquator') return parent.rotation.mode !== 'none' ? poleQuat(parent.rotation.poleRaDeg, parent.rotation.poleDecDeg) : quat.identity();
  if (f && typeof f === 'object' && f.pole && Number.isFinite(f.pole.raDeg) && Number.isFinite(f.pole.decDeg)) return poleQuat(f.pole.raDeg, f.pole.decDeg);
  throw new DefError(file, `orbit.frame must be 'ecliptic', 'parentEquator' or { pole: { raDeg, decDeg } }, got ${JSON.stringify(f)}`);
}

/** Semi-major axis and eccentricity of an orbit definition (the mean values the SOI rule is computed from). */
function meanAxis(o: NonNullable<BodyDef['orbit']>): { a: number; e: number } {
  if (o.kind === 'kepler') return { a: o.a, e: o.e };
  return { a: 1.00014 * AU, e: 0.01671 };
}

class BodySystemImpl implements BodySystem {
  readonly defs: DefLibrary;
  readonly rootId: string;
  readonly starId: string;
  readonly ids: readonly string[];
  private readonly info = new Map<string, BodyInfo>();
  private readonly eph = new Map<string, OrbitEphemeris | null>();
  private readonly baseConic = new Map<string, ConicElements | null>();
  /** Occulting bodies (never the star) per planet system, in `ids` order. */
  private readonly systemMembers = new Map<string, string[]>();
  /** Planets: the systems the star's own sphere holds (in a library rooted at the star). */
  private readonly planetIds: string[];
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
        const qPlane = planeOf(o, parent, file);
        this.eph.set(id, isSecular(o) ? new SecularKeplerEphemeris(o, parent.mu + b.mu, qPlane) : new KeplerEphemeris(o, parent.mu + b.mu, qPlane));
      } else if (o.kind === 'sunLowPrecision') {
        if (b.parent !== this.rootId) throw new DefError(file, "orbit 'sunLowPrecision' is defined relative to the root body only");
        if (o.inverted === true && b.parent !== this.starId) throw new DefError(file, "orbit 'sunLowPrecision' with inverted: true is a body about the star: its parent must be the star");
        if (o.inverted !== true && id !== this.starId) throw new DefError(file, "orbit 'sunLowPrecision' without inverted is the star about the root: only the star may have it");
        this.eph.set(id, new SunLowPrecisionEphemeris(o.inverted === true));
      } else {
        throw new DefError(file, `unknown orbit kind ${JSON.stringify((o as { kind: unknown }).kind)}`);
      }
    }
    for (const id of this.ids) {
      const b = defs.bodies[id]!;
      const file = `bodies/${id}.json`;
      const e = this.eph.get(id) ?? null;
      const kepler = e instanceof KeplerEphemeris ? e : null;
      const attractor = b.gravityRole === 'attractor';
      let soi: number | null = null;
      if (b.parent !== null && attractor) {
        if (b.soiRadius === null) throw new DefError(file, 'a non-root attractor needs soiRadius (number or "auto")');
        if (b.soiRadius === 'auto') {
          const { a } = meanAxis(b.orbit!);
          const ratio = b.mu / defs.bodies[b.parent]!.mu;
          const hill = a * Math.cbrt(ratio / 3);
          soi = Math.min(hill, Math.max(a * Math.pow(ratio, 0.4), 2.5 * b.radius));
        } else soi = b.soiRadius;
        if (!(soi > b.radius)) throw new DefError(file, 'soiRadius must exceed the radius');
      }
      let warpLimits: readonly number[] = [];
      if (attractor) {
        try {
          warpLimits = warpAltitudeLimitsOf(b);
        } catch (err) {
          throw new DefError(file, (err as Error).message);
        }
      }
      if (b.surface !== undefined && b.surface !== 'solid' && b.surface !== 'none') throw new DefError(file, `surface must be 'solid' or 'none', got ${JSON.stringify(b.surface)}`);
      if (b.surface === 'none') {
        if (b.terrain !== null) throw new DefError(file, "a body with surface 'none' has no terrain section");
        if (floorAltitude(b) === null) throw new DefError(file, "a body with surface 'none' needs atmosphere.floorAltitude (the level below which a vessel is destroyed)");
      }
      if (b.shape !== undefined) {
        const s = b.shape;
        if (!(s.equatorialRadius > 0 && s.polarRadius > 0 && Number.isFinite(s.equatorialRadius) && Number.isFinite(s.polarRadius))) throw new DefError(file, 'shape needs positive equatorialRadius and polarRadius');
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
        ephemeris: e,
        rotation: rot,
        spin: spinVector(rot),
        warpAltitudeLimits: warpLimits,
        surface: b.surface === 'none' ? 'none' : 'solid',
        systemId: this.systemOf(id),
      });
      this.baseConic.set(id, kepler ? this.makeConic(id, kepler.epochUt) : null);
    }
    this.occulters = this.ids.filter((id) => id !== this.starId);
    for (const id of this.occulters) {
      const sys = this.info.get(id)!.systemId!;
      let list = this.systemMembers.get(sys);
      if (!list) this.systemMembers.set(sys, (list = []));
      list.push(id);
    }
    this.planetIds = this.ids.filter((id) => id !== this.starId && defs.bodies[id]!.parent === this.starId);
  }

  /** The planet system of a body (BodyInfo.systemId). */
  private systemOf(id: string): string | null {
    if (id === this.starId) return null;
    let cur = id;
    for (;;) {
      const p = this.defs.bodies[cur]!.parent;
      if (p === null || p === this.starId) return cur;
      cur = p;
    }
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

  /**
   * State of `id` relative to `originId` through their lowest common ancestor, never through the root: a
   * moon relative to its planet is its own ephemeris to the bit, and two bodies of one planet system lose
   * no digits to the system's heliocentric position. (With the root as the common ancestor this is
   * stateRoot(id) - stateRoot(originId), v1's expression.)
   */
  stateRelative(id: string, originId: string, ut: number): StateVector {
    if (id === originId) return { r: v3.zero(), v: v3.zero() };
    const common = this.commonAncestor(id, originId);
    const a = this.stateUpTo(id, common, ut);
    const b = this.stateUpTo(originId, common, ut);
    return { r: v3.sub(a.r, b.r), v: v3.sub(a.v, b.v) };
  }

  /** State of `id` relative to its ancestor `ancestor` (the sum of the parent states on the way up). */
  private stateUpTo(id: string, ancestor: string, ut: number): StateVector {
    if (id === ancestor) return { r: v3.zero(), v: v3.zero() };
    let s = this.stateRelParent(id, ut);
    let p = this.defs.bodies[id]!.parent;
    while (p !== null && p !== ancestor) {
      const ps = this.stateRelParent(p, ut);
      s = { r: v3.add(s.r, ps.r), v: v3.add(s.v, ps.v) };
      p = this.defs.bodies[p]!.parent;
    }
    return s;
  }

  private commonAncestor(a: string, b: string): string {
    const up = new Set<string>();
    for (let x: string | null = a; x !== null; x = this.defs.bodies[x]!.parent) up.add(x);
    for (let y: string | null = b; y !== null; y = this.defs.bodies[y]!.parent) if (up.has(y)) return y;
    return this.rootId;
  }

  orientation(id: string, ut: number): Quat {
    return orientationAt(this.body(id).rotation, ut);
  }

  spin(id: string): Vec3 {
    return v3.clone(this.body(id).spin);
  }

  orbitConic(id: string, ut: number): ConicElements | null {
    const base = this.baseConic.get(id);
    if (base) {
      const P = base.period!;
      const k = Math.round((ut - base.tPeriapsis) / P);
      return { ...base, P: v3.clone(base.P), Q: v3.clone(base.Q), W: v3.clone(base.W), tPeriapsis: base.tPeriapsis + k * P };
    }
    const e = this.eph.get(id);
    if (!e) return null;
    // The v1 star on the Almanac formula has no conic (it is not an orbit a vessel can follow).
    if (e instanceof SunLowPrecisionEphemeris && !e.inverted) return null;
    return this.makeConic(id, ut);
  }

  orbitNormal(id: string, ut: number): Vec3 | null {
    const e = this.eph.get(id);
    if (e === undefined) throw new Error(`BodySystem: unknown body "${id}"`);
    return e === null ? null : e.normalAt(ut);
  }

  sunDirection(posRoot: Vec3, ut: number): { dir: Vec3; distance: number } {
    const d = v3.sub(this.stateRoot(this.starId, ut).r, posRoot);
    const distance = v3.len(d);
    return { dir: v3.scale(d, 1 / distance), distance };
  }

  /** Occulters of the planet system a position is in (see BodySystem.sunVisibility). */
  private occultersAt(posRoot: Vec3, ut: number, bodyId: string | undefined): readonly string[] {
    // A library rooted at a planet (v1): every body but the star is one system.
    if (this.rootId !== this.starId) return this.occulters;
    if (bodyId !== undefined) {
      const sys = this.body(bodyId).systemId;
      if (sys !== null) return this.systemMembers.get(sys) ?? [];
    }
    for (const p of this.planetIds) {
      const soi = this.info.get(p)!.soiRadius;
      if (soi === null) continue;
      const c = this.stateRoot(p, ut).r;
      if (Math.hypot(posRoot.x - c.x, posRoot.y - c.y, posRoot.z - c.z) < soi) return this.systemMembers.get(p) ?? [];
    }
    return this.planetIds;
  }

  sunVisibility(posRoot: Vec3, ut: number, bodyId?: string): number {
    const star = this.defs.bodies[this.starId]!;
    const starPos = this.stateRoot(this.starId, ut).r;
    const spheres: OccultingSphere[] = this.occultersAt(posRoot, ut, bodyId).map((id) => ({ centre: this.stateRoot(id, ut).r, radius: this.defs.bodies[id]!.radius }));
    return sunVisibleFraction(posRoot, starPos, star.emission!.radius, spheres);
  }

  /** The frame the lighting of a point about `bodyId` is computed in: its planet system's body (v1: the root). */
  private lightingFrame(bodyId: string): string {
    return this.body(bodyId).systemId ?? this.rootId;
  }

  sunDirectionAt(bodyId: string, rBci: Vec3, ut: number): { dir: Vec3; distance: number } {
    const f = this.lightingFrame(bodyId);
    const p = v3.add(this.stateRelative(bodyId, f, ut).r, rBci);
    const d = v3.sub(this.stateRelative(this.starId, f, ut).r, p);
    const distance = v3.len(d);
    return { dir: v3.scale(d, 1 / distance), distance };
  }

  sunVisibilityAt(bodyId: string, rBci: Vec3, ut: number): number {
    const f = this.lightingFrame(bodyId);
    const star = this.defs.bodies[this.starId]!;
    const p = v3.add(this.stateRelative(bodyId, f, ut).r, rBci);
    const members = this.rootId !== this.starId ? this.occulters : this.body(bodyId).systemId === null ? this.planetIds : (this.systemMembers.get(f) ?? []);
    const spheres: OccultingSphere[] = members.map((id) => ({ centre: this.stateRelative(id, f, ut).r, radius: this.defs.bodies[id]!.radius }));
    return sunVisibleFraction(p, this.stateRelative(this.starId, f, ut).r, star.emission!.radius, spheres);
  }

  surfaceRadius(id: string, dirFixed: Vec3): number {
    return surfaceRadius(this.body(id).def, dirFixed);
  }

  boundaryOf(bodyId: string, r: Vec3, v: Vec3, lostDistance: number): SystemBoundary {
    const b = this.body(bodyId);
    const rm = v3.len(r);
    if (bodyId === this.starId && b.star) {
      const photosphere = b.def.emission!.radius;
      if (rm < photosphere) return 'photosphere';
    }
    if (bodyId === this.rootId && rm > lostDistance) {
      const energy = v3.dot(v, v) / 2 - b.mu / rm;
      if (energy >= 0) return 'lost';
    }
    return null;
  }

  buildBodySnapshots(ut: number): BodySnapshot[] {
    const starPos = this.stateRoot(this.starId, ut).r;
    const rootToStar = v3.normalize(starPos);
    const rootIsStar = this.rootId === this.starId;
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
        // The star's own snapshot: v1 states the direction from the root to the star (the root is not the star);
        // a star at the root has no direction to itself, and states +Z with distance 0.
        sunDir: isStar ? (rootIsStar ? { x: 0, y: 0, z: 1 } : rootToStar) : v3.scale(toSun, 1 / dist),
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
