import { describe, expect, it } from 'vitest';
import { fsDefSource } from './fsSource';
import { DefError, loadDefs, resolveRefs, type DefSource } from './loader';

function memorySource(files: Record<string, unknown>): DefSource {
  return {
    list: async () => Object.keys(files).sort(),
    read: async (p) => (p in files ? structuredClone(files[p]) : undefined),
  };
}

describe('definition loader', () => {
  it('loads the repository definitions and resolves every $ref', async () => {
    const lib = await loadDefs(fsDefSource());
    expect(lib.rootBodyId).toBe('earth');
    expect(Object.keys(lib.bodies).sort()).toEqual(['earth', 'moon', 'sun']);
    const earth = lib.bodies['earth']!;
    expect(earth.render.atmosphere?.rayleighScattering[2]).toBeCloseTo(33.1e-6, 12);
    expect(earth.terrain?.amplification.model).toBe('earth-landcover');
    expect(earth.ocean?.swell.length).toBe(4);
    for (const c of earth.ocean!.swell) expect(Math.hypot(...c.dir)).toBeCloseTo(1, 9);
    expect(earth.warpAltitudeLimits.length).toBe(7);
    expect(lib.bodies['moon']!.parent).toBe('earth');
    expect(lib.bodies['moon']!.render.surface?.brdf).toBe('hapke');
    expect(lib.bodies['sun']!.emission?.illuminance).toBe(128000);
    const site = lib.sites['ka-lae-lc1']!;
    expect(site.location.latDeg).toBeGreaterThan(18);
    expect(site.location.latDeg).toBeLessThan(20.9);
    expect(site.structures.length).toBeGreaterThan(0);
  });

  it('resolves nested and optional refs relative to the referencing file', async () => {
    const src = memorySource({
      'a/x.json': { v: { $ref: '../b/y.part.json' }, w: { $ref: 'missing.json', optional: true } },
      'b/y.part.json': { inner: { $ref: 'z.part.json' } },
      'b/z.part.json': [1, 2, 3],
    });
    expect(await resolveRefs(await src.read('a/x.json'), 'a/x.json', src)).toEqual({ v: { inner: [1, 2, 3] }, w: null });
  });

  it('reports missing refs, id mismatches and broken cross references with the file name', async () => {
    await expect(resolveRefs({ $ref: 'nope.json' }, 'bodies/a.json', memorySource({}))).rejects.toThrow(DefError);
    await expect(resolveRefs({ $ref: '../../etc.json' }, 'bodies/a.json', memorySource({}))).rejects.toThrow(/escapes/);
    const body = { id: 'wrong', parent: null, mu: 1, radius: 1 };
    await expect(loadDefs(memorySource({ 'bodies/a.json': body }))).rejects.toThrow(/must equal the file name/);
    const root = { id: 'a', parent: null, mu: 1, radius: 1, orbit: null };
    const child = { id: 'b', parent: 'zzz', mu: 1, radius: 1, orbit: { kind: 'sunLowPrecision' } };
    await expect(loadDefs(memorySource({ 'bodies/a.json': root, 'bodies/b.json': child }))).rejects.toThrow(/unknown parent/);
  });

  it('ignores dotted section files as definitions', async () => {
    const root = { id: 'a', parent: null, mu: 1, radius: 1, orbit: null };
    const lib = await loadDefs(memorySource({ 'bodies/a.json': root, 'bodies/a.section.json': { anything: true } }));
    expect(Object.keys(lib.bodies)).toEqual(['a']);
  });
});
