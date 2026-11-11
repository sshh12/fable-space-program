/**
 * Atmosphere lab world helpers: a Sim wrapper that pins the sun direction (scenes must not depend on the
 * FakeSim's date), body-fixed sites, and great-circle placement for the backdrop relief.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodyPose } from '@/core/contracts/render';
import type { BodySnapshot, Sim, SimSnapshot } from '@/core/contracts/sim';
import { dirToLatLon, latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, RAD, v3, type Quat, type Vec3 } from '@/core/math';
import type { ParentPose } from '@/render/core';
import { enuAt } from '@/render/core/lab';

/** A body-fixed site; its frame has +X east, +Y north, +Z up. */
export interface Site {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
  /** Height of the site origin above the reference radius, m. */
  alt: number;
}

export const siteDirFixed = (site: Site): Vec3 => latLonToDir(site.latDeg * DEG, site.lonDeg * DEG);

/** Site position in the body-fixed frame (float64) and the ENU -> body-fixed rotation. */
export function siteFrameFixed(site: Site, defs: DefLibrary): { posFixed: Vec3; qEnuToFixed: Quat } {
  const dir = siteDirFixed(site);
  const { east, north, up } = enuAt(quat.identity(), dir);
  return { posFixed: v3.scale(dir, defs.bodies[site.bodyId]!.radius + site.alt), qEnuToFixed: quat.fromBasis(east, north, up) };
}

/** Camera-relative pose of the site frame (ENU axes) now and one frame ago. */
export function sitePose(site: Site, body: BodyPose, defs: DefLibrary): ParentPose {
  const { posFixed, qEnuToFixed } = siteFrameFixed(site, defs);
  return {
    originRelCam: v3.add(body.centerRelCam, quat.rotate(body.qFixedToRoot, posFixed)),
    q: quat.mul(body.qFixedToRoot, qEnuToFixed),
    prevOriginRelCam: v3.add(body.prevCenterRelCam, quat.rotate(body.prevQFixedToRoot, posFixed)),
    prevQ: quat.mul(body.prevQFixedToRoot, qEnuToFixed),
  };
}

/** The site reached from `site` by travelling `distance` metres along the great circle with initial `headingDeg` (clockwise from north). */
export function siteAlong(site: Site, headingDeg: number, distance: number, defs: DefLibrary, alt = 0): Site {
  const dir = siteDirFixed(site);
  const { east, north } = enuAt(quat.identity(), dir);
  const h = headingDeg * DEG;
  const tangent = v3.add(v3.scale(east, Math.sin(h)), v3.scale(north, Math.cos(h)));
  const a = distance / defs.bodies[site.bodyId]!.radius;
  const ll = dirToLatLon(v3.normalize(v3.add(v3.scale(dir, Math.cos(a)), v3.scale(tangent, Math.sin(a)))));
  return { bodyId: site.bodyId, latDeg: ll.lat * RAD, lonDeg: ll.lon * RAD, alt };
}

export interface SunOverride {
  /** Unit direction from the root body to the star in ROOT axes for this snapshot, or null to keep the sim's. */
  dirRoot(snapshot: SimSnapshot): Vec3 | null;
}

/** Sun direction given as azimuth (deg clockwise from north) / elevation (deg) at a site. */
export function sunAtSite(site: Site, azDeg: number, elDeg: number): SunOverride {
  return {
    dirRoot(snapshot) {
      const b = snapshot.bodies.find((x) => x.id === site.bodyId);
      if (!b) return null;
      const { east, north, up } = enuAt(b.qFixedToRoot, siteDirFixed(site));
      const az = azDeg * DEG;
      const el = elDeg * DEG;
      return v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(up, Math.sin(el))));
    },
  };
}

/** Wrap a Sim so that every snapshot has the star placed along the overridden direction (the bodies' sunDir follow). */
export function withSunOverride(inner: Sim, getOverride: () => SunOverride | null): Sim {
  const fix = (s: SimSnapshot): SimSnapshot => {
    const dir = getOverride()?.dirRoot(s);
    if (!dir) return s;
    const star = s.bodies.find((b) => b.id === s.starId);
    const root = s.bodies.find((b) => b.id === inner.defs.rootBodyId);
    if (!star || !root) return s;
    const starPos = v3.addScaled(root.rRoot, dir, v3.dist(star.rRoot, root.rRoot));
    const bodies: BodySnapshot[] = s.bodies.map((b) => {
      if (b.id === s.starId) return { ...b, rRoot: starPos };
      const to = v3.sub(starPos, b.rRoot);
      return { ...b, sunDir: v3.normalize(to), sunDistance: v3.len(to) };
    });
    return { ...s, bodies };
  };
  return {
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
    snapshot: () => fix(inner.snapshot()),
    peek: () => fix(inner.peek()),
    get cheatCounter() {
      return inner.cheatCounter;
    },
    stateHash: () => inner.stateHash(),
    debug: inner.debug,
  };
}
