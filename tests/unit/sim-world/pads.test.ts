/**
 * A scenario stands on a pad of its site (MIGRATION_V2 step 3.6; ARCHITECTURE 9.3): `ScenarioDef.pad`
 * names it, absent = the site's first pad, which stands at the site's reference point. The pad gives the
 * place, the heading, the mount height and the surface target.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, LaunchSiteDef, PadDef, ScenarioDef } from '@/core/contracts/defs';
import { padLocationOf, padOf, padsOf, padTitle, SINGLE_PAD_ID } from '@/core/defs/sites';
import { quat } from '@/core/math/quat';
import { DEG, RAD } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { active, flatTerrain, loadLibrary, makeSim } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

/** The repository's site with a second pad 0.03 degrees north-east of the first, on another heading and a lower mount. */
function twoPads(lib: DefLibrary): { lib: DefLibrary; site: LaunchSiteDef; second: PadDef } {
  const sc = lib.scenarios['lunar-direct']!;
  const base = lib.sites[sc.site]!;
  const first = padsOf(base)[0]!;
  const second: PadDef = { ...first, id: 'second', name: 'Second Pad', offsetEnu: [3000, 3300], azimuthDeg: 30, mountHeight: 7, flatRadius: 200, blendRadius: 500 };
  delete (second as { shape?: unknown }).shape;
  const site: LaunchSiteDef = {
    ...base,
    pads: [first, second],
    location: { ...base.location, pads: { ...base.location.pads, second: { latDeg: base.location.latDeg + 0.03, lonDeg: base.location.lonDeg + 0.03, padElevation: 55 } } },
  };
  return { lib: { ...lib, sites: { ...lib.sites, [site.id]: site } }, site, second };
}

const onPad = (lib: DefLibrary, padId?: string): ScenarioDef => {
  const sc = { ...lib.scenarios['lunar-direct']!, id: `t-pad-${padId ?? 'default'}`, milestones: [] };
  if (padId !== undefined) sc.pad = padId;
  else delete sc.pad;
  return sc;
};

/** Latitude and longitude (deg) and radius (m) of a vessel from its body-fixed direction. */
function placeOf(s: { r: { x: number; y: number; z: number } }, qFixedToInertial: { x: number; y: number; z: number; w: number }): { latDeg: number; lonDeg: number; radius: number } {
  const d = quat.rotateInv(qFixedToInertial, s.r);
  const radius = v3.len(d);
  return { latDeg: Math.asin(d.z / radius) * RAD, lonDeg: Math.atan2(d.y, d.x) * RAD, radius };
}

describe('the pad of a scenario', () => {
  it('without a pad the vessel stands on the first pad, at the reference point of the site', async () => {
    const terrain = flatTerrain(defs, { earth: 0 });
    const named = await makeSim(defs, onPad(defs, padsOf(defs.sites[defs.scenarios['lunar-direct']!.site]!)[0]!.id), terrain);
    const unnamed = await makeSim(defs, onPad(defs), terrain);
    // The same state, bit for bit: naming the first pad changes nothing.
    expect(unnamed.stateHash()).toBe(named.stateHash());
    const s = unnamed.snapshot();
    const site = defs.sites[s.surfaceTargets.find((t) => t.kind === 'site')!.id.slice('site:'.length)]!;
    const earth = s.bodies.find((b) => b.id === 'earth')!;
    const at = placeOf(active(s), earth.qFixedToRoot);
    expect(at.latDeg).toBeCloseTo(site.location.latDeg, 9);
    expect(at.lonDeg).toBeCloseTo(site.location.lonDeg, 9);
  });

  it('a named pad gives the place, the elevation, the heading and the mount height', async () => {
    const { lib, site, second } = twoPads(defs);
    const terrain = flatTerrain(lib, { earth: 0 });
    const a = await makeSim(lib, onPad(lib), terrain);
    const b = await makeSim(lib, onPad(lib, 'second'), terrain);
    const sa = a.snapshot();
    const sb = b.snapshot();
    const earthA = sa.bodies.find((x) => x.id === 'earth')!;
    const earthB = sb.bodies.find((x) => x.id === 'earth')!;
    const pa = placeOf(active(sa), earthA.qFixedToRoot);
    const pb = placeOf(active(sb), earthB.qFixedToRoot);
    const where = padLocationOf(site, 'second');
    expect(pb.latDeg).toBeCloseTo(where.latDeg, 9);
    expect(pb.lonDeg).toBeCloseTo(where.lonDeg, 9);
    expect(pa.latDeg).toBeCloseTo(site.location.latDeg, 9);
    // The vessel's origin is its base offset above pad elevation + mount height: the two pads differ by
    // their elevations and mounts, and by nothing else.
    const first = padOf(site);
    const expected = (where.padElevation as number) + second.mountHeight - ((site.location.padElevation as number) + first.mountHeight);
    expect(pb.radius - pa.radius).toBeCloseTo(expected, 6);
    // Heading: the ventral side (-Z) faces the pad's azimuth; the nose is up on both pads.
    const heading = (s: typeof sa, earth: typeof earthA): number => {
      const v = active(s);
      const up = v3.normalize(v.r);
      const pole = quat.rotate(earth.qFixedToRoot, { x: 0, y: 0, z: 1 });
      const east = v3.normalize(v3.cross(pole, up));
      const north = v3.cross(up, east);
      const ventral = quat.rotate(v.q, { x: 0, y: 0, z: -1 });
      expect(v3.dot(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), up)).toBeCloseTo(1, 12);
      return Math.atan2(v3.dot(ventral, east), v3.dot(ventral, north)) * RAD;
    };
    expect(heading(sa, earthA)).toBeCloseTo(first.azimuthDeg, 9);
    expect(heading(sb, earthB)).toBeCloseTo(second.azimuthDeg, 9);
    // The launch site as a surface target is the pad the scenario stands on.
    const target = sb.surfaceTargets.find((t) => t.kind === 'site')!;
    expect(target).toMatchObject({ id: `site:${site.id}`, name: `${site.name}, Second Pad`, bodyId: 'earth', radius: 200 });
    expect(target.latitude).toBeCloseTo(where.latDeg * DEG, 12);
    expect(target.longitude).toBeCloseTo(where.lonDeg * DEG, 12);
    expect(sa.surfaceTargets.find((t) => t.kind === 'site')!.name).toBe(`${site.name}, ${first.name}`);
    // It holds on the pad: clamped, at rest on the mount.
    for (let i = 0; i < 240; i++) b.step();
    const later = b.snapshot();
    expect(active(later).situation).toBe('prelaunch');
    const still = placeOf(active(later), later.bodies.find((x) => x.id === 'earth')!.qFixedToRoot);
    expect(Math.abs(still.radius - pb.radius)).toBeLessThan(1e-3);
    expect(later.cheatCounter).toBe(0);
  });

  it('the terrain is asked for the ground about the named pad', async () => {
    const { lib, second } = twoPads(defs);
    const asked: { slot: string; radius: number }[] = [];
    const terrain = flatTerrain(lib, { earth: 0 });
    const ensure = terrain.ensureLoaded;
    terrain.ensureLoaded = (bodyId, dir, radius, slot) => {
      asked.push({ slot: slot ?? 'default', radius });
      return ensure(bodyId, dir, radius, slot);
    };
    await makeSim(lib, onPad(lib, 'second'), terrain);
    const pad = asked.find((x) => x.slot === 'pad')!;
    expect(pad.radius).toBe(second.blendRadius + 600);
  });

  it('a pad the site does not have is refused by name, with the pads it has', async () => {
    const { lib, site } = twoPads(defs);
    const terrain = flatTerrain(lib, { earth: 0 });
    await expect(makeSim(lib, onPad(lib, 'nowhere'), terrain)).rejects.toThrow(`sites/${site.id}.json: no pad "nowhere" (pads: ${padsOf(site).map((p) => p.id).join(', ')})`);
  });
});

describe('site helpers', () => {
  it('a site built in memory with the single pad only has that pad as its one pad', () => {
    const base = defs.sites[defs.scenarios['lunar-direct']!.site]!;
    const v1: LaunchSiteDef = { id: 'old', name: 'Old Site', bodyId: base.bodyId, location: { latDeg: 1, lonDeg: 2, padElevation: 'terrain' }, padAzimuthDeg: 75, pad: { flatRadius: 10, blendRadius: 30, clampHeight: 5 }, structures: [], recoveryZones: [] };
    const pads = padsOf(v1);
    expect(pads).toHaveLength(1);
    expect(padsOf(v1)).toBe(pads);
    expect(pads[0]).toMatchObject({ id: SINGLE_PAD_ID, azimuthDeg: 75, flatRadius: 10, blendRadius: 30, mountHeight: 5, class: 'heavy' });
    expect(padOf(v1)).toBe(pads[0]);
    expect(padLocationOf(v1)).toEqual({ latDeg: 1, lonDeg: 2, padElevation: 'terrain' });
    expect(padTitle(v1)).toBe('Old Site');
    expect(() => padOf(v1, 'lc-9')).toThrow('sites/old.json: no pad "lc-9" (pads: pad)');
  });
});
