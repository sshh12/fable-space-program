import { describe, expect, it } from 'vitest';
import { fsDefSource } from './fsSource';
import type { CapsuleMouldLineDef } from '../contracts/defs';
import { DefError, getSection, listSections, loadDefs, resolveRefs, type DefSource } from './loader';

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
    // The $ref to render/earth.atmosphere.json is resolved (the numbers are the atmosphere package's to tune:
    // only their order of magnitude and "blue scatters more than red" are held here).
    const rayleigh = earth.render.atmosphere!.rayleighScattering;
    expect(rayleigh[2]).toBeGreaterThan(2e-5);
    expect(rayleigh[2]).toBeLessThan(5e-5);
    expect(rayleigh[2]).toBeGreaterThan(rayleigh[1]);
    expect(rayleigh[1]).toBeGreaterThan(rayleigh[0]);
    expect(earth.terrain?.amplification.model).toBe('earth-landcover');
    // The count is the lead's data (ocean-5 / ocean-6: eight); the consumers take 1 to MAX_SWELL = 8 (request lead-1).
    expect(earth.ocean?.swell.length).toBeGreaterThan(0);
    expect(earth.ocean!.swell.length).toBeLessThanOrEqual(8);
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

  it('exposes audio/ and visuals/ files as sections with refs resolved', async () => {
    const root = { id: 'a', parent: null, mu: 1, radius: 1, orbit: null };
    const lib = await loadDefs(
      memorySource({
        'bodies/a.json': root,
        'visuals/plumes.json': { 'plume.x': { color: [1, 2, 3], shared: { $ref: 'shared/common.json' } } },
        'visuals/shared/common.json': { k: 7 },
        'audio/engines.json': { 'engine.x': { gain: 0.5 } },
        'regions/r.json': { ignored: true },
      }),
    );
    expect(Object.keys(lib.sections).sort()).toEqual(['audio/engines', 'visuals/plumes', 'visuals/shared/common']);
    expect(getSection<Record<string, { shared: { k: number } }>>(lib, 'visuals/plumes')['plume.x']!.shared.k).toBe(7);
    expect(Object.keys(listSections(lib, 'visuals/shared/'))).toEqual(['common']);
    expect(() => getSection(lib, 'visuals/nope')).toThrow(DefError);
  });

  it('ships one shared capsule mould line whose numbers are self-consistent', async () => {
    const lib = await loadDefs(fsDefSource());
    const m = getSection<CapsuleMouldLineDef>(lib, 'visuals/shared/kestrel-mouldline');
    expect(m.heatShield.maxDiameter).toBe(4.0);
    // the cone joins the shield shoulder and the apex tunnel at the stated half-angle
    const slope = (m.heatShield.maxDiameter / 2 - m.cone.radiusTop) / (m.cone.yTop - m.cone.yBottom);
    expect((Math.atan(slope) * 180) / Math.PI).toBeCloseTo(m.cone.halfAngleDeg, 1);
    expect(m.apexTunnel.radius).toBe(m.cone.radiusTop);
    expect(m.apexTunnel.yBottom).toBe(m.cone.yTop);
    // the profile is a monotonic climb in y from the shield apex to the top of the tunnel
    for (let i = 1; i < m.profile.length; i++) expect(m.profile[i]![1]).toBeGreaterThanOrEqual(m.profile[i - 1]![1]);
    expect(m.profile[0]).toEqual([0, m.heatShield.apexY]);
    expect(m.profile.at(-1)![1]).toBe(m.apexTunnel.yTop);
    // every seat eye point is inside the pressure wall, with orthonormal look/up directions
    const innerRadius = (y: number): number => m.heatShield.maxDiameter / 2 - slope * (y - m.cone.yBottom) - m.wallThickness / Math.cos((m.cone.halfAngleDeg * Math.PI) / 180);
    for (const s of m.seats) {
      expect(Math.hypot(s.pos[0], s.pos[2])).toBeLessThan(innerRadius(s.pos[1]) - 0.25);
      expect(Math.hypot(...s.lookDir)).toBeCloseTo(1, 2);
      expect(Math.hypot(...s.upDir)).toBeCloseTo(1, 2);
      expect(s.lookDir[0] * s.upDir[0] + s.lookDir[1] * s.upDir[1] + s.lookDir[2] * s.upDir[2]).toBeCloseTo(0, 6);
    }
    // openings lie on the cone and do not overlap in azimuth at their height
    for (const w of [...m.windows, m.hatch]) {
      expect(w.y).toBeGreaterThan(m.cone.yBottom + 0.3);
      expect(w.y).toBeLessThan(m.cone.yTop - 0.3);
    }
    expect(new Set(m.windows.map((w) => w.id)).size).toBe(m.windows.length);
  });

  it('validates scenario milestone rules', async () => {
    const root = { id: 'a', parent: null, mu: 1, radius: 1, orbit: null };
    const base = { id: 's', name: 's', vehicle: 'v', site: 'k', startUt: 0, start: { kind: 'pad' }, stagesAlreadyFired: 0, target: null, suggestedLanding: null };
    const files = (milestones: unknown): Record<string, unknown> => ({
      'bodies/a.json': root,
      'sites/k.json': { id: 'k', bodyId: 'a' },
      'vehicles/v.json': { id: 'v', parts: [] },
      'scenarios/s.json': { ...base, milestones },
    });
    const good = [
      { id: 'UP', trigger: { kind: 'liftoff' } },
      { id: 'ORBIT', trigger: { kind: 'orbit', bodyId: 'a', minPeriapsisAltitude: 1 }, after: ['UP'] },
    ];
    expect((await loadDefs(memorySource(files(good)))).scenarios['s']!.milestones).toHaveLength(2);
    await expect(loadDefs(memorySource(files(undefined)))).rejects.toThrow(/milestones/);
    await expect(loadDefs(memorySource(files([good[0], good[0]])))).rejects.toThrow(/duplicate milestone/);
    await expect(loadDefs(memorySource(files([{ id: 'X', trigger: { kind: 'soiEnter', bodyId: 'zzz' } }])))).rejects.toThrow(/unknown body/);
    await expect(loadDefs(memorySource(files([good[1], good[0]])))).rejects.toThrow(/prerequisite/);
    // A display title is optional (request flight-ui-5); when present it is a non-empty string.
    const titled = (await loadDefs(memorySource(files([{ ...good[0], title: 'Lift-off' }, good[1]])))).scenarios['s']!.milestones;
    expect(titled[0]!.title).toBe('Lift-off');
    expect(titled[1]!.title).toBeUndefined();
    await expect(loadDefs(memorySource(files([{ ...good[0], title: '' }])))).rejects.toThrow(/"title" must be a non-empty string/);
    await expect(loadDefs(memorySource(files([{ ...good[0], title: 7 }])))).rejects.toThrow(/"title" must be a non-empty string/);
  });

  it('the mission scenario names every milestone for the HUD', async () => {
    const lib = await loadDefs(fsDefSource());
    for (const s of Object.values(lib.scenarios)) {
      for (const m of s.milestones) {
        const title = m.title;
        expect(title, `${s.id} ${m.id}`).toBeTruthy();
        // A title is a phrase, not the id title-cased.
        expect(title).not.toMatch(/_/);
      }
    }
    const titles = Object.fromEntries(lib.scenarios['lunar-direct']!.milestones.map((m) => [m.id, m.title]));
    expect(titles['TLI_COMPLETE']).toBe('TLI complete');
    expect(titles['MOON_SOI_ENTER']).toBe("Entered the Moon's sphere of influence");
  });

  it('validates the resource amounts a scenario starts with', async () => {
    const files = (resources: unknown): Record<string, unknown> => ({
      'bodies/a.json': { id: 'a', parent: null, mu: 1, radius: 1, orbit: null },
      'sites/k.json': { id: 'k', bodyId: 'a' },
      'resources.json': [{ id: 'LOX' }, { id: 'CH4' }],
      'parts/tank.json': { id: 'tank', resources: [{ resource: 'LOX', capacity: 1000, tankBottomY: 0, tankHeight: 1 }] },
      'parts/strut.json': { id: 'strut' },
      'vehicles/v.json': { id: 'v', parts: [{ id: 't1', def: 'tank', parent: null }, { id: 's1', def: 'strut', parent: 't1' }] },
      'scenarios/s.json': { id: 's', name: 's', vehicle: 'v', site: 'k', startUt: 0, start: { kind: 'pad' }, stagesAlreadyFired: 0, target: null, suggestedLanding: null, milestones: [], ...(resources === undefined ? {} : { resources }) },
    });
    // Absent: as before. Present and valid: kept as written, the capacity itself and a rounding error above it included.
    expect((await loadDefs(memorySource(files(undefined)))).scenarios['s']!.resources).toBeUndefined();
    expect((await loadDefs(memorySource(files({ t1: { LOX: 250.5 } })))).scenarios['s']!.resources).toEqual({ t1: { LOX: 250.5 } });
    expect((await loadDefs(memorySource(files({ t1: { LOX: 0 } })))).scenarios['s']!.resources!['t1']!['LOX']).toBe(0);
    await expect(loadDefs(memorySource(files({ t1: { LOX: 1000.0005 } })))).resolves.toBeDefined();
    await expect(loadDefs(memorySource(files({})))).resolves.toBeDefined();
    // Everything else names the scenario file.
    await expect(loadDefs(memorySource(files([1])))).rejects.toThrow(/scenarios\/s\.json.*must be an object/);
    await expect(loadDefs(memorySource(files({ nope: { LOX: 1 } })))).rejects.toThrow(/scenarios\/s\.json.*no part "nope"/);
    await expect(loadDefs(memorySource(files({ t1: 5 })))).rejects.toThrow(/scenarios\/s\.json.*resource id -> kg/);
    await expect(loadDefs(memorySource(files({ t1: { CH4: 1 } })))).rejects.toThrow(/scenarios\/s\.json.*holds no "CH4"/);
    await expect(loadDefs(memorySource(files({ s1: { LOX: 1 } })))).rejects.toThrow(/holds no "LOX"/);
    await expect(loadDefs(memorySource(files({ t1: { LOX: -1 } })))).rejects.toThrow(/from 0 to its capacity 1000/);
    await expect(loadDefs(memorySource(files({ t1: { LOX: 1000.01 } })))).rejects.toThrow(/from 0 to its capacity 1000/);
    await expect(loadDefs(memorySource(files({ t1: { LOX: '12' } })))).rejects.toThrow(/from 0 to its capacity/);
    await expect(loadDefs(memorySource(files({ t1: { LOX: null } })))).rejects.toThrow(/from 0 to its capacity/);
  });

  it('ignores dotted section files as definitions', async () => {
    const root = { id: 'a', parent: null, mu: 1, radius: 1, orbit: null };
    const lib = await loadDefs(memorySource({ 'bodies/a.json': root, 'bodies/a.section.json': { anything: true } }));
    expect(Object.keys(lib.bodies)).toEqual(['a']);
  });
});
