/**
 * Render-core lab world helpers: a Sim wrapper that lets a lab pin the sun direction (so scenes do not
 * depend on the FakeSim's date), and placement of the test stand in a body-fixed frame.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodyPose, FrameContext } from '@/core/contracts/render';
import type { BodySnapshot, Sim, SimSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, hash4, hashToUnit, quat, v3, type Quat, type Vec3 } from '@/core/math';
import type { ParentPose } from '@/render/core';
import { enuAt } from '@/render/core/lab';

/** A body-fixed site: the stand's frame has +X east, +Y north, +Z up. */
export interface Site {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
  /** Height of the site origin above the reference radius, m. */
  alt: number;
}

export function siteDirFixed(site: Site): Vec3 {
  return latLonToDir(site.latDeg * DEG, site.lonDeg * DEG);
}

/** Site position in the body-fixed frame (float64) and the ENU -> body-fixed rotation. */
export function siteFrameFixed(site: Site, defs: DefLibrary): { posFixed: Vec3; qEnuToFixed: Quat } {
  const dir = siteDirFixed(site);
  const { east, north, up } = enuAt(quat.identity(), dir);
  return { posFixed: v3.scale(dir, defs.bodies[site.bodyId]!.radius + site.alt), qEnuToFixed: quat.fromBasis(east, north, up) };
}

/** Camera-relative pose of the site frame (ENU axes) now and one frame ago: the parent of every stand instance. */
export function sitePose(site: Site, body: BodyPose, defs: DefLibrary): ParentPose {
  const { posFixed, qEnuToFixed } = siteFrameFixed(site, defs);
  return {
    originRelCam: v3.add(body.centerRelCam, quat.rotate(body.qFixedToRoot, posFixed)),
    q: quat.mul(body.qFixedToRoot, qEnuToFixed),
    prevOriginRelCam: v3.add(body.prevCenterRelCam, quat.rotate(body.prevQFixedToRoot, posFixed)),
    prevQ: quat.mul(body.prevQFixedToRoot, qEnuToFixed),
  };
}

export const sitePoseOf = (site: Site, frame: FrameContext, defs: DefLibrary): ParentPose => sitePose(site, frame.bodyPose(site.bodyId), defs);

export interface SunOverride {
  /** Returns the unit direction from the root body to the star in ROOT axes for this snapshot, or null to keep the sim's. */
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

/** Wrap a Sim so that every snapshot has the star placed along the overridden direction (bodies' sunDir follow). */
export function withSunOverride(inner: Sim, getOverride: () => SunOverride | null): Sim {
  const fix = (s: SimSnapshot): SimSnapshot => {
    const o = getOverride();
    const dir = o?.dirRoot(s);
    if (!dir) return s;
    const star = s.bodies.find((b) => b.id === s.starId);
    const root = s.bodies.find((b) => b.id === inner.defs.rootBodyId);
    if (!star || !root) return s;
    const dist = v3.dist(star.rRoot, root.rRoot);
    const starPos = v3.addScaled(root.rRoot, dir, dist);
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

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number): number => hashToUnit(hash4(ix + a, iy + b, iz + c, seed));
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return lerp(lerp(lerp(h(0, 0, 0), h(1, 0, 0), ux), lerp(h(0, 1, 0), h(1, 1, 0), ux), uy), lerp(lerp(h(0, 0, 1), h(1, 0, 1), ux), lerp(h(0, 1, 1), h(1, 1, 1), ux), uy), uz);
}

const srgb8 = (linear: number): number => Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055));

/**
 * A synthetic equirectangular albedo map for the LabPlanet (the real `albedoLowRes` maps appear once the
 * bakes have run): continents and oceans for a body with water, mottled grey regolith otherwise.
 */
export function proceduralPlanetMap(seed: number, ocean: boolean, width = 512, height = 256): { width: number; height: number; data: Uint8Array<ArrayBuffer> } {
  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = (0.5 - (j + 0.5) / height) * Math.PI;
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      const x = Math.cos(lat) * Math.cos(lon);
      const y = Math.cos(lat) * Math.sin(lon);
      const z = Math.sin(lat);
      let n = 0;
      let a = 0.5;
      let f = 1.6;
      for (let o = 0; o < 5; o++) {
        n += a * valueNoise3(x * f + 11, y * f + 7, z * f + 3, seed + o);
        a *= 0.5;
        f *= 2.1;
      }
      let rgb: [number, number, number];
      if (ocean) {
        if (n < 0.5) {
          // Open ocean, lighter on the shelves next to land.
          const shelf = Math.max(0, (n - 0.44) / 0.06);
          rgb = [0.012 + 0.03 * shelf, 0.035 + 0.1 * shelf, 0.09 + 0.12 * shelf];
        } else {
          const t = Math.min(1, (n - 0.5) / 0.2);
          rgb = [0.16 + 0.22 * t, 0.2 + 0.1 * t, 0.08 + 0.1 * t];
        }
      } else {
        const g = 0.07 + 0.16 * n;
        rgb = [g * 1.03, g, g * 0.95];
      }
      const o4 = (j * width + i) * 4;
      data[o4] = srgb8(rgb[0]);
      data[o4 + 1] = srgb8(rgb[1]);
      data[o4 + 2] = srgb8(rgb[2]);
      data[o4 + 3] = 255;
    }
  }
  return { width, height, data };
}
