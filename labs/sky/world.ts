/**
 * Sky lab world helpers: a Sim wrapper that pins the star along a chosen direction and/or moves the active
 * vessel to another altitude above its body (so the probe can be measured at any altitude and in any
 * lighting without depending on the FakeSim's date), over ground at a chosen elevation (the read-outs' radar
 * altitude follows, as the real sim reports it).
 */
import type { BodySnapshot, Sim, SimSnapshot } from '@/core/contracts/sim';
import { v3, type Vec3 } from '@/core/math';

export interface WorldOverrides {
  /** Unit direction (ROOT) from the root body to the star for a snapshot, or null to keep the sim's. */
  sunDir: ((s: SimSnapshot) => Vec3 | null) | null;
  /** Altitude (m) of the active vessel above its body's reference radius, or null to keep the sim's. */
  vesselAltitude: number | null;
  /**
   * Elevation (m) of the ground under the active vessel relative to the reference radius (with vesselAltitude):
   * readouts.altitudeRadar = max(0, vesselAltitude - groundAltitude). 0 = ground on the datum.
   */
  groundAltitude: number;
}

export function withOverrides(inner: Sim, o: WorldOverrides): Sim {
  const fix = (s: SimSnapshot): SimSnapshot => {
    let out = s;
    if (o.vesselAltitude !== null) {
      const h = o.vesselAltitude;
      const vessels = out.vessels.map((v) => {
        if (v.id !== out.activeVesselId) return v;
        const body = out.bodies.find((b) => b.id === v.bodyId)!;
        const radius = inner.defs.bodies[v.bodyId]!.radius;
        const up = v3.normalize(v3.sub(v.rRoot, body.rRoot));
        const r = v3.scale(up, radius + h);
        return { ...v, r, rRoot: v3.add(body.rRoot, r) };
      });
      out = { ...out, vessels, readouts: { ...out.readouts, altitudeAsl: h, altitudeRadar: Math.max(0, h - o.groundAltitude) } };
    }
    const dir = o.sunDir?.(out);
    if (dir) {
      const star = out.bodies.find((b) => b.id === out.starId);
      const root = out.bodies.find((b) => b.id === inner.defs.rootBodyId);
      if (star && root) {
        const starPos = v3.addScaled(root.rRoot, dir, v3.dist(star.rRoot, root.rRoot));
        const bodies: BodySnapshot[] = out.bodies.map((b) => {
          if (b.id === out.starId) return { ...b, rRoot: starPos };
          const to = v3.sub(starPos, b.rRoot);
          return { ...b, sunDir: v3.normalize(to), sunDistance: v3.len(to) };
        });
        out = { ...out, bodies };
      }
    }
    return out;
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'snapshot') return () => fix(target.snapshot());
      if (prop === 'peek') return () => fix(target.peek());
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
