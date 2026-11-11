/**
 * Ocean lab world: wraps the FakeSim so a lab can pin the sun and the moon at an azimuth / elevation seen
 * from a site, and float a capsule-sized vessel on the physics swell (situation 'splashed', waterSubmersion,
 * 'splash' events on demand) - the snapshot fields the ocean's vessel interaction reads.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodySnapshot, Sim, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { oceanSwellHeight } from '@/core/geo/oceanSwell';
import { DEG, quat, v3, type Quat, type Vec3 } from '@/core/math';
import { enuAt } from '@/render/core/lab';

export interface LabSite {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
}

export interface FloatingVessel {
  /** ENU offset of the vessel from the site, m. */
  east: number;
  north: number;
  /** Depth of the VES origin (base of the hull) below the water surface, m. */
  draft: number;
  boundingRadius: number;
  submersion: number;
}

export const siteDir = (s: LabSite): Vec3 => latLonToDir(s.latDeg * DEG, s.lonDeg * DEG);

/** Body-fixed unit direction of a point `east` / `north` metres from the site (on the sphere of radius R). */
export function offsetDir(s: LabSite, east: number, north: number, radius: number): Vec3 {
  const { east: e, north: n, up } = enuAt(quat.identity(), siteDir(s));
  return v3.normalize(v3.add(up, v3.add(v3.scale(e, east / radius), v3.scale(n, north / radius))));
}

/** Water height above the reference radius, as the physics evaluates it. */
export function waterHeight(defs: DefLibrary, bodyId: string, dirFixed: Vec3, ut: number): number {
  const b = defs.bodies[bodyId]!;
  const o = b.ocean!;
  return o.seaLevel + oceanSwellHeight(o.swell, b.mu / (b.radius * b.radius), b.radius + o.seaLevel, dirFixed, ut);
}

function dirAtSite(body: BodySnapshot, site: LabSite, azDeg: number, elDeg: number): Vec3 {
  const { east, north, up } = enuAt(body.qFixedToRoot, siteDir(site));
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  return v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(up, Math.sin(el))));
}

export class OceanLabWorld {
  sun: [number, number] | null = null;
  moon: [number, number] | null = null;
  floating: FloatingVessel | null = null;
  private pending: SimEvent[] = [];
  readonly sim: Sim;

  constructor(
    private readonly inner: Sim,
    readonly defs: DefLibrary,
    public site: LabSite,
  ) {
    const fix = (s: SimSnapshot, drain: boolean): SimSnapshot => this.apply(s, drain);
    this.sim = {
      defs: inner.defs,
      scenario: inner.scenario,
      ready: inner.ready,
      terrainPending: () => inner.terrainPending(),
      advance: (dt, cb) => inner.advance(dt, cb),
      step: () => inner.step(),
      advanceRails: (t) => inner.advanceRails(t),
      get needsIntegration() {
        return inner.needsIntegration;
      },
      get nextEventUt() {
        return inner.nextEventUt;
      },
      setControls: (c) => inner.setControls(c),
      commands: inner.commands,
      snapshot: () => fix(inner.snapshot(), true),
      peek: () => fix(inner.peek(), false),
      get cheatCounter() {
        return inner.cheatCounter;
      },
      stateHash: () => inner.stateHash(),
      debug: inner.debug,
    };
  }

  /** Queue a 'splash' event of the floating vessel for the next snapshot. */
  splash(speed: number): void {
    this.pending.push({ type: 'splash', ut: 0, vesselId: '', speed } as SimEvent);
  }

  private apply(s: SimSnapshot, drain: boolean): SimSnapshot {
    const root = this.defs.rootBodyId;
    const rootBody = s.bodies.find((b) => b.id === root)!;
    const siteBody = s.bodies.find((b) => b.id === this.site.bodyId)!;
    let bodies = s.bodies;
    const star = s.bodies.find((b) => b.id === s.starId)!;
    let starPos = star.rRoot;
    if (this.sun) starPos = v3.addScaled(rootBody.rRoot, dirAtSite(siteBody, this.site, this.sun[0], this.sun[1]), v3.dist(star.rRoot, rootBody.rRoot));
    const moonId = Object.values(this.defs.bodies).find((b) => b.parent === root && b.gravityRole === 'attractor')?.id;
    bodies = bodies.map((b) => {
      let rRoot = b.rRoot;
      if (b.id === s.starId) rRoot = starPos;
      if (this.moon && b.id === moonId) rRoot = v3.addScaled(rootBody.rRoot, dirAtSite(siteBody, this.site, this.moon[0], this.moon[1]), v3.dist(b.rRoot, rootBody.rRoot));
      const to = v3.sub(starPos, rRoot);
      return b.id === s.starId ? { ...b, rRoot } : { ...b, rRoot, sunDir: v3.normalize(to), sunDistance: v3.len(to) };
    });
    let vessels = s.vessels;
    let events = s.events;
    if (this.floating) {
      const f = this.floating;
      const body = bodies.find((b) => b.id === this.site.bodyId)!;
      const def = this.defs.bodies[this.site.bodyId]!;
      const dir = offsetDir(this.site, f.east, f.north, def.radius);
      const h = waterHeight(this.defs, this.site.bodyId, dir, s.ut);
      // Tilt with the swell surface (central differences, 1 m).
      const { east, north } = enuAt(quat.identity(), dir);
      const hAt = (de: number, dn: number): number => waterHeight(this.defs, this.site.bodyId, v3.normalize(v3.add(dir, v3.add(v3.scale(east, de / def.radius), v3.scale(north, dn / def.radius)))), s.ut);
      const gx = (hAt(1, 0) - hAt(-1, 0)) / 2;
      const gy = (hAt(0, 1) - hAt(0, -1)) / 2;
      const nFixed = v3.normalize(v3.sub(dir, v3.add(v3.scale(east, gx), v3.scale(north, gy))));
      const posFixed = v3.scale(dir, def.radius + h - f.draft);
      const qUp: Quat = quat.fromTo({ x: 0, y: 1, z: 0 }, nFixed);
      const r = quat.rotate(body.qFixedToRoot, posFixed);
      const spin = body.spinRoot;
      const v = v3.cross(spin, r);
      const active = s.vessels.find((x) => x.id === s.activeVesselId)!;
      const vessel: VesselSnapshot = {
        ...active,
        bodyId: this.site.bodyId,
        situation: 'splashed',
        r,
        v,
        rRoot: v3.add(body.rRoot, r),
        vRoot: v3.add(body.vRoot, v),
        q: quat.mul(body.qFixedToRoot, qUp),
        w: v3.zero(),
        boundingRadius: f.boundingRadius,
        contact: { anyContact: true, maxForce: 0, waterSubmersion: f.submersion },
      };
      vessels = s.vessels.map((x) => (x.id === active.id ? vessel : x));
      if (drain && this.pending.length) {
        events = [...events, ...this.pending.map((e) => ({ ...e, ut: s.ut, vesselId: vessel.id }))];
        this.pending = [];
      }
    }
    return { ...s, bodies, vessels, events };
  }
}
