import { describe, expect, it } from 'vitest';
import { fsDefSource } from './fsSource';
import type { CapsuleMouldLineDef } from '../contracts/defs';
import { DEFAULT_PAD_CLASS_LIMITS, DEFAULT_UNIVERSE_RULES, UNIVERSE_RULE_TIMERS } from '../contracts/net';
import { padLimitsOf } from './sites';
import fs from 'node:fs';
import path from 'node:path';
import { DefError, getSection, listSections, loadDefs, overlayDefSource, resolveRefs, TABLE_FILES, type DefSource } from './loader';

/** A site file with one pad, as small as a valid one gets. */
const siteFile = (id: string, bodyId: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  bodyId,
  location: { latDeg: 1, lonDeg: 2, padElevation: 3 },
  pads: [{ id: 'p1', name: 'Pad 1', offsetEnu: [0, 0], azimuthDeg: 90, class: 'light', maxLiftoffMass: 1000, maxDiameter: 2, flatRadius: 10, blendRadius: 20, mountHeight: 1, structures: [] }],
  recoveryZones: [],
  ...more,
});

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
    const site = lib.sites['ka-lae']!;
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

  describe('launch sites and their pads', () => {
    const body = { id: 'a', name: 'A', parent: null, mu: 1, radius: 1, orbit: null };
    const pad = (id: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
      id, name: `Pad ${id}`, offsetEnu: [0, 0], azimuthDeg: 90, class: 'heavy', maxLiftoffMass: 5000, maxDiameter: 4, flatRadius: 100, blendRadius: 250, mountHeight: 6, structures: [{ model: 'm', offsetEnu: [0, 0, 0], headingDeg: 0 }], ...more,
    });
    const load = (site: Record<string, unknown>, more: Record<string, unknown> = {}) => loadDefs(memorySource({ 'bodies/a.json': body, 'sites/k.json': site, ...more }));
    const scenario = (padId?: unknown): Record<string, unknown> => ({
      'vehicles/v.json': { id: 'v', parts: [] },
      'scenarios/s.json': { id: 's', name: 's', vehicle: 'v', site: 'k', startUt: 0, start: { kind: 'pad' }, stagesAlreadyFired: 0, target: null, suggestedLanding: null, milestones: [], ...(padId === undefined ? {} : { pad: padId }) },
    });

    it('the repository site: a pad list, and the deprecated single pad is its first pad', async () => {
      const lib = await loadDefs(fsDefSource());
      for (const site of Object.values(lib.sites)) {
        const pads = site.pads!;
        expect(pads.length, site.id).toBeGreaterThan(0);
        const first = pads[0]!;
        expect(site.padAzimuthDeg).toBe(first.azimuthDeg);
        expect(site.pad.flatRadius).toBe(first.flatRadius);
        expect(site.pad.blendRadius).toBe(first.blendRadius);
        expect(site.pad.clampHeight).toBe(first.mountHeight);
        expect(site.pad.shape).toBe(first.shape);
        expect(site.structures).toBe(first.structures);
        expect(first.structures.length).toBeGreaterThan(0);
        // Every pad has its location; the first pad stands at the reference point.
        expect(Object.keys(site.location.pads!).sort()).toEqual(pads.map((p) => p.id).sort());
        expect(site.location.pads![first.id]).toEqual({ latDeg: site.location.latDeg, lonDeg: site.location.lonDeg, padElevation: site.location.padElevation });
        expect(new Set(pads.map((p) => p.id)).size).toBe(pads.length);
      }
      // Every scenario stands on a pad of its site.
      for (const sc of Object.values(lib.scenarios)) {
        if (sc.pad !== undefined) expect(lib.sites[sc.site]!.pads!.map((p) => p.id), sc.id).toContain(sc.pad);
      }
    });

    it('a file with pads: the single pad is written from the first pad; the other pads need resolved coordinates', async () => {
      const shape = { coreRadius: 10, coreBlend: 5, reliefShare: 0.2, areas: [], edgeNoise: { amplitude: 0.1, wavelength: 10 } };
      const site = {
        id: 'k', name: 'K', bodyId: 'a', recoveryZones: [],
        location: { latDeg: 10, lonDeg: 20, padElevation: 30, pads: { n: { latDeg: 10.1, lonDeg: 20.2, padElevation: 'terrain' } } },
        pads: [pad('m', { azimuthDeg: 72, shape }), pad('n', { class: 'light', flatRadius: 50, blendRadius: 120, mountHeight: 2 })],
      };
      const k = (await load(site)).sites['k']!;
      expect(k.pads!.map((p) => p.id)).toEqual(['m', 'n']);
      expect(k.padAzimuthDeg).toBe(72);
      expect(k.pad).toEqual({ flatRadius: 100, blendRadius: 250, clampHeight: 6, shape });
      expect(k.structures).toBe(k.pads![0]!.structures);
      expect(k.location.pads).toEqual({ m: { latDeg: 10, lonDeg: 20, padElevation: 30 }, n: { latDeg: 10.1, lonDeg: 20.2, padElevation: 'terrain' } });
      // The first pad may be stated in location.pads when it equals the reference point, and only then.
      const same = { ...site, location: { ...site.location, pads: { ...site.location.pads, m: { latDeg: 10, lonDeg: 20, padElevation: 30 } } } };
      expect((await load(same)).sites['k']!.location.pads!['m']).toEqual({ latDeg: 10, lonDeg: 20, padElevation: 30 });
      const moved = { ...site, location: { ...site.location, pads: { ...site.location.pads, m: { latDeg: 10, lonDeg: 20.5, padElevation: 30 } } } };
      await expect(load(moved)).rejects.toThrow(/sites\/k\.json: location\.pads\["m"\] differs from the reference point/);
      const unresolved = { ...site, location: { latDeg: 10, lonDeg: 20, padElevation: 30 } };
      await expect(load(unresolved)).rejects.toThrow(/sites\/k\.json: pad "n" has no resolved coordinates/);
      const stray = { ...site, location: { ...site.location, pads: { ...site.location.pads, zz: { latDeg: 1, lonDeg: 1, padElevation: 1 } } } };
      await expect(load(stray)).rejects.toThrow(/location\.pads names "zz", which is not a pad of the site \(pads: m, n\)/);
    });

    it('a file with the deprecated single pad only gets it as its one pad', async () => {
      const site = { id: 'k', name: 'K', bodyId: 'a', recoveryZones: [], location: { latDeg: 10, lonDeg: 20, padElevation: 'terrain' }, padAzimuthDeg: 45, pad: { flatRadius: 30, blendRadius: 90, clampHeight: 4 }, structures: [] };
      const k = (await load(site)).sites['k']!;
      expect(k.pads).toHaveLength(1);
      expect(k.pads![0]).toMatchObject({ id: 'pad', name: 'K', offsetEnu: [0, 0], azimuthDeg: 45, class: 'heavy', flatRadius: 30, blendRadius: 90, mountHeight: 4, structures: [] });
      // No pad is without a limit: the single pad states none of its own, so it takes what its class takes.
      expect(k.pads![0]!.maxLiftoffMass).toBeUndefined();
      expect(padLimitsOf(k.pads![0]!)).toEqual(DEFAULT_PAD_CLASS_LIMITS.heavy);
      expect(k.location.pads).toEqual({ pad: { latDeg: 10, lonDeg: 20, padElevation: 'terrain' } });
      expect(k.pad.clampHeight).toBe(4);
    });

    it('refuses a site without a pad, two statements of one pad, and a malformed pad, by file and pad', async () => {
      const base = { id: 'k', name: 'K', bodyId: 'a', recoveryZones: [], location: { latDeg: 10, lonDeg: 20, padElevation: 30 } };
      await expect(load(base)).rejects.toThrow(/sites\/k\.json: a site needs "pads"/);
      await expect(load({ ...base, pads: [] })).rejects.toThrow(/"pads" must be a non-empty array/);
      await expect(load({ ...base, pads: [pad('m')], padAzimuthDeg: 90 })).rejects.toThrow(/"padAzimuthDeg" is the deprecated single pad: a site with "pads" states its pads in the list only/);
      await expect(load({ ...base, pads: [pad('m')], structures: [] })).rejects.toThrow(/"structures" is the deprecated single pad/);
      await expect(load({ ...base, location: { latDeg: 10, lonDeg: 20 }, pads: [pad('m')] })).rejects.toThrow(/"location" needs latDeg, lonDeg and padElevation/);
      await expect(load({ ...base, pads: [pad('m'), pad('m')] })).rejects.toThrow(/pad "m" \(pads\[1\]\): duplicate pad id/);
      await expect(load({ ...base, pads: [pad('m', { class: 'huge' })] })).rejects.toThrow(/pad "m" \(pads\[0\]\): "class" must be one of light, medium, heavy/);
      await expect(load({ ...base, pads: [pad('m', { blendRadius: 100 })] })).rejects.toThrow(/needs 0 <= flatRadius < blendRadius/);
      await expect(load({ ...base, pads: [pad('m', { maxLiftoffMass: 0 })] })).rejects.toThrow(/"maxLiftoffMass" must be a positive finite number when present/);
      await expect(load({ ...base, pads: [pad('m', { structures: undefined })] })).rejects.toThrow(/"structures" must be an array/);
      await expect(load({ ...base, pads: [{ name: 'nameless' }] })).rejects.toThrow(/pads\[0\] must be an object with a non-empty string "id"/);
    });

    it('the limits of a pad are those of its class, each replaced by the pad\'s own where it states one', async () => {
      const base = { id: 'k', name: 'K', bodyId: 'a', recoveryZones: [], location: { latDeg: 10, lonDeg: 20, padElevation: 30 } };
      const none = { ...pad('m', { class: 'medium' }) };
      delete none['maxLiftoffMass'];
      delete none['maxDiameter'];
      const k = (await load({ ...base, pads: [none] })).sites['k']!;
      expect(padLimitsOf(k.pads![0]!)).toEqual(DEFAULT_PAD_CLASS_LIMITS.medium);
      const own = (await load({ ...base, pads: [{ ...none, maxDiameter: 5 }] })).sites['k']!;
      expect(padLimitsOf(own.pads![0]!)).toEqual({ maxLiftoffMass: DEFAULT_PAD_CLASS_LIMITS.medium.maxLiftoffMass, maxDiameter: 5 });
      // A rules document that states class limits is where they come from.
      const rules = { ...DEFAULT_UNIVERSE_RULES, pads: { ...DEFAULT_UNIVERSE_RULES.pads, classLimits: { ...DEFAULT_PAD_CLASS_LIMITS, medium: { maxLiftoffMass: 9e5, maxDiameter: 8 } } } };
      expect(padLimitsOf(k.pads![0]!, rules)).toEqual({ maxLiftoffMass: 9e5, maxDiameter: 8 });
      expect(padLimitsOf(own.pads![0]!, rules)).toEqual({ maxLiftoffMass: 9e5, maxDiameter: 5 });
      // The repository's pad: the heavy class's limits, stated on the pad as provisional numbers.
      const lib = await loadDefs(fsDefSource());
      for (const site of Object.values(lib.sites)) for (const p of site.pads!) {
        const limits = padLimitsOf(p, lib.rules!['default']);
        expect(Number.isFinite(limits.maxLiftoffMass) && limits.maxLiftoffMass > 0, p.id).toBe(true);
        expect(Number.isFinite(limits.maxDiameter) && limits.maxDiameter > 0, p.id).toBe(true);
        expect('$comment' in p, 'a note in the file is not part of the pad').toBe(false);
      }
    });

    it('a pad stated twice is one place: its offset from the reference point and its resolved coordinates agree', async () => {
      const earthLike = { id: 'a', name: 'A', parent: null, mu: 1, radius: 6_000_000, orbit: null };
      const site = (offsetEnu: [number, number]) => ({
        id: 'k', name: 'K', bodyId: 'a', recoveryZones: [],
        location: { latDeg: 10, lonDeg: 20, padElevation: 30, pads: { n: { latDeg: 10.1, lonDeg: 20.05, padElevation: 31 } } },
        pads: [pad('m'), pad('n', { offsetEnu })],
      });
      const onEarth = (s: unknown) => loadDefs(memorySource({ 'bodies/a.json': earthLike, 'sites/k.json': s }));
      // 0.1 degrees north and 0.05 degrees east of the reference point on a 6,000 km sphere.
      const north = 0.1 * (Math.PI / 180) * 6_000_000;
      const east = 0.05 * (Math.PI / 180) * Math.cos(10 * (Math.PI / 180)) * 6_000_000;
      expect((await onEarth(site([Math.round(east / 10) * 10, Math.round(north / 10) * 10]))).sites['k']!.pads).toHaveLength(2);
      await expect(onEarth(site([0, 0]))).rejects.toThrow(/pad "n": offsetEnu .0, 0. and its resolved coordinates .* are 11[0-9]+.[0-9] m apart .allowed 2[0-9].[0-9] m.: one place is stated twice and the two disagree/);
      await expect(onEarth(site([east + 60, north]))).rejects.toThrow(/are 60\.0 m apart/);
      // The first pad is the reference point: its offset is zero.
      const first = site([east, north]);
      first.pads[0] = pad('m', { offsetEnu: [100, 0] });
      await expect(onEarth(first)).rejects.toThrow(/pad "m": offsetEnu \[100, 0\]/);
    });

    it('an id that composes runtime ids is refused where the vehicle is read', async () => {
      const files = (vehicle: unknown, name = 'v') => ({ 'bodies/a.json': body, 'parts/p.json': { id: 'p' }, [`vehicles/${name}.json`]: vehicle });
      expect((await loadDefs(memorySource(files({ id: 'v', parts: [{ id: 'core-1', def: 'p', parent: null }] })))).vehicles['v']!.parts).toHaveLength(1);
      await expect(loadDefs(memorySource(files({ id: 'v', parts: [{ id: 'core/1', def: 'p', parent: null }] })))).rejects.toThrow(/vehicles\/v\.json: part instance id "core\/1" contains '\/'/);
      await expect(loadDefs(memorySource(files({ id: 'v', parts: [{ id: 'core~1', def: 'p', parent: null }] })))).rejects.toThrow(/contains '~'/);
      await expect(loadDefs(memorySource(files({ id: 'v', parts: [{ id: 'core.1', def: 'p', parent: null }] })))).rejects.toThrow(/contains '\.'/);
      await expect(loadDefs(memorySource(files({ id: 'v~2', parts: [{ id: 'core', def: 'p', parent: null }] }, 'v~2')))).rejects.toThrow(/the vehicle id contains '~'/);
    });

    it('a scenario names a pad of its site, or none (the first pad)', async () => {
      const site = { id: 'k', name: 'K', bodyId: 'a', recoveryZones: [], location: { latDeg: 10, lonDeg: 20, padElevation: 30, pads: { n: { latDeg: 10.1, lonDeg: 20.2, padElevation: 31 } } }, pads: [pad('m'), pad('n')] };
      expect((await load(site, scenario())).scenarios['s']!.pad).toBeUndefined();
      expect((await load(site, scenario('n'))).scenarios['s']!.pad).toBe('n');
      await expect(load(site, scenario('x'))).rejects.toThrow(/scenarios\/s\.json: unknown pad "x" of site "k" \(pads: m, n\)/);
      await expect(load(site, scenario(2))).rejects.toThrow(/unknown pad 2 of site "k"/);
    });
  });

  describe('rules documents', () => {
    const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));
    const body = { id: 'a', name: 'A', parent: null, mu: 1, radius: 1, orbit: null };
    const load = (rules: unknown, name = 'default') => loadDefs(memorySource({ 'bodies/a.json': body, [`rules/${name}.json`]: rules }));

    it('a rules file is stored as overrides of the default: the library holds the complete document', async () => {
      // Its id and version alone: the default document.
      expect((await load({ id: 'default', version: 1 })).rules!['default']).toEqual(plain(DEFAULT_UNIVERSE_RULES));
      expect((await loadDefs(memorySource({ 'bodies/a.json': body }))).rules).toEqual({});
      // A number, a field of a nested object, a list, a policy, a nullable number: each replaces the default's
      // value at its place and nothing else; a note for the reader of the file is not part of the document.
      const stated = {
        $comment: 'a soak',
        id: 'soak',
        version: 3,
        expiry: { debrisRetention: 5 },
        pads: { keepOutRadius: { heavy: 700 } },
        time: { targetApproachSteps: [{ timeBefore: 5, maxRate: 1 }] },
        docking: { defaultLendPolicy: { helm: ['a'] } },
        planning: { weakClientCpuScore: 12 },
      };
      const doc = (await load(stated, 'soak')).rules!['soak']!;
      expect('$comment' in doc).toBe(false);
      expect([doc.id, doc.version]).toEqual(['soak', 3]);
      expect(doc.expiry).toEqual({ ...DEFAULT_UNIVERSE_RULES.expiry, debrisRetention: 5 });
      expect(doc.pads.keepOutRadius).toEqual({ ...DEFAULT_UNIVERSE_RULES.pads.keepOutRadius, heavy: 700 });
      expect(doc.time).toEqual({ ...DEFAULT_UNIVERSE_RULES.time, targetApproachSteps: [{ timeBefore: 5, maxRate: 1 }] });
      expect(doc.docking.defaultLendPolicy).toEqual({ ...DEFAULT_UNIVERSE_RULES.docking.defaultLendPolicy, helm: ['a'] });
      expect(doc.planning.weakClientCpuScore).toBe(12);
      for (const group of ['claim', 'disconnect', 'contact', 'terrain', 'limits'] as const) expect(doc[group]).toEqual(DEFAULT_UNIVERSE_RULES[group]);
      // The default document itself is not touched by a file that was laid over a copy of it.
      expect(DEFAULT_UNIVERSE_RULES.expiry.debrisRetention).toBe(2 * 3600);
      // The class limits of pads are a field the default does not state yet: a file may state them, whole.
      const limits = { light: { maxLiftoffMass: 5e4, maxDiameter: 2 }, medium: { maxLiftoffMass: 5e5, maxDiameter: 6 }, heavy: { maxLiftoffMass: 4e6, maxDiameter: 12 } };
      expect((await load({ id: 'default', version: 1, pads: { classLimits: limits } })).rules!['default']!.pads.classLimits).toEqual(limits);
    });

    it('the three files of the repository: production, staging with lifetimes of minutes, local where nothing expires', async () => {
      const lib = await loadDefs(fsDefSource());
      expect(Object.keys(lib.rules!).sort()).toEqual(['default', 'local', 'staging']);
      expect(lib.rules!['default']).toEqual(plain(DEFAULT_UNIVERSE_RULES));
      const wall = Object.keys(UNIVERSE_RULE_TIMERS).filter((p) => UNIVERSE_RULE_TIMERS[p] === 'wall');
      expect(wall.length).toBe(11);
      const differing = (id: string): string[] => {
        const doc = plain(lib.rules![id]) as Record<string, Record<string, unknown>>;
        const standard = plain(DEFAULT_UNIVERSE_RULES) as Record<string, Record<string, unknown>>;
        const out: string[] = [];
        for (const group of Object.keys(standard)) {
          if (typeof standard[group] !== 'object' || standard[group] === null) continue;
          for (const field of Object.keys(standard[group]!)) if (JSON.stringify(doc[group]![field]) !== JSON.stringify(standard[group]![field])) out.push(`${group}.${field}`);
        }
        return out.sort();
      };
      // Staging differs from production in the timers on the wall clock, all of them, and in nothing else.
      expect(differing('staging')).toEqual([...wall].sort());
      const e = lib.rules!['staging']!.expiry;
      expect(e).toMatchObject({ craftRetention: 840, unownedAssemblyRetention: 120, unownedCraftRetention: 120, debrisRetention: 5, wreckRetention: 5, arcRetention: 60, accountRetention: 5400, pressureFloorSingleSession: 60, pressureFloor: 180, outageExtensionThreshold: 2.5 });
      expect(e.sweepInterval).toBeCloseTo(60 / 1440, 12);
      // Every lifetime is at least two sweeps, and the thresholds that a 60 s floor made one number are apart.
      for (const p of wall) if (p !== 'expiry.sweepInterval') expect((e as unknown as Record<string, number>)[p.split('.')[1]!], p).toBeGreaterThanOrEqual(2 * e.sweepInterval);
      expect(new Set([e.outageExtensionThreshold, e.debrisRetention, e.arcRetention, e.unownedCraftRetention, e.pressureFloor, e.craftRetention, e.accountRetention]).size).toBe(7);
      // Local: the time and physics rules of production; every retention on the wall clock never runs out.
      const local = lib.rules!['local']!;
      const retentions = wall.filter((p) => /Retention$|^expiry\.pressureFloor/.test(p));
      expect(retentions).toHaveLength(9);
      expect(differing('local')).toEqual([...retentions].sort());
      for (const p of retentions) expect((local.expiry as unknown as Record<string, number>)[p.split('.')[1]!], p).toBe(Number.MAX_SAFE_INTEGER);
      for (const group of ['time', 'claim', 'disconnect', 'contact', 'docking', 'terrain', 'pads', 'limits', 'planning'] as const) expect(local[group]).toEqual(lib.rules!['default']![group]);
    });

    it('a file states only fields of the rules, with values of their kind, under its own name', async () => {
      await expect(load({ id: 'default', version: 1, pads: { launchFee: 3 } })).rejects.toThrow(/rules\/default\.json: "pads\.launchFee" is not a field of UniverseRules/);
      await expect(load({ id: 'default', version: 1, expiri: {} })).rejects.toThrow(/"expiri" is not a field of UniverseRules/);
      await expect(load({ id: 'default', version: 1, pads: { keepOutRadius: { medium: '450' } } })).rejects.toThrow(/"pads\.keepOutRadius\.medium" must be a finite number, got "450"/);
      await expect(load({ id: 'default', version: 1, expiry: 7 })).rejects.toThrow(/"expiry" must be an object/);
      await expect(load({ id: 'default', version: 1, time: { targetApproachSteps: 3 } })).rejects.toThrow(/"time\.targetApproachSteps" must be an array/);
      await expect(load({ id: 'default', version: 1, docking: { defaultLendPolicy: { lendEngines: 1 } } })).rejects.toThrow(/"docking\.defaultLendPolicy\.lendEngines" must be true or false/);
      await expect(load({ id: 'default', version: 0 })).rejects.toThrow(/"version" must be an integer from 1/);
      await expect(load({ id: 'default' })).rejects.toThrow(/"version" must be an integer from 1/);
      await expect(load({ id: 'default', version: 1 }, 'other')).rejects.toThrow(/rules\/other\.json: id "default" must equal the file name "other"/);
      await expect(load({ id: 'default', version: 1, pads: { classLimits: { light: { maxLiftoffMass: 1, maxDiameter: 1 }, heavy: { maxLiftoffMass: 3, maxDiameter: 3 } } } })).rejects.toThrow(/"pads\.classLimits\.medium" is missing/);
      await expect(load({ id: 'default', version: 1, pads: { classLimits: { light: { maxLiftoffMass: 1, maxDiameter: 1 }, medium: { maxLiftoffMass: 0, maxDiameter: 2 }, heavy: { maxLiftoffMass: 3, maxDiameter: 3 } } } })).rejects.toThrow(/"pads\.classLimits\.medium\.maxLiftoffMass" must be a positive finite number/);
    });
  });

  describe('a second root laid over the first', () => {
    const root = { id: 'a', name: 'A', parent: null, mu: 1, radius: 1, orbit: null, extra: { $ref: '../render/a.surface.json' } };
    const base = {
      'bodies/a.json': root,
      'bodies/b.json': { id: 'b', name: 'B of the base', parent: 'a', mu: 1, radius: 1, orbit: { kind: 'x' } },
      'render/a.surface.json': { from: 'base' },
      'sites/s.json': siteFile('s', 'a', { from: 'base' }),
      'visuals/v.json': { from: 'base' },
    };
    const staged = {
      // Replaces b, adds c; c refers to a file of its own root and to a file of the base.
      'bodies/b.json': { id: 'b', name: 'B staged', parent: 'a', mu: 2, radius: 2, orbit: { kind: 'x' } },
      'bodies/c.json': { id: 'c', name: 'C', parent: 'b', mu: 1, radius: 1, orbit: { kind: 'x' }, terrain: { $ref: '../terrain/c.terrain.json' }, look: { $ref: '../render/a.surface.json' } },
      'terrain/c.terrain.json': { from: 'staged' },
      // Not laid over: a site and a section of the second root are not definitions of the library.
      'sites/s.json': siteFile('s', 'a', { from: 'staged' }),
      'sites/t.json': siteFile('t', 'a', { from: 'staged' }),
      'visuals/v.json': { from: 'staged' },
      'visuals/w.json': { from: 'staged' },
    };

    it('its bodies replace or add; its other files are $ref targets only; nothing else of it is listed', async () => {
      const source = overlayDefSource(memorySource(base), memorySource(staged));
      expect(await source.list()).toEqual(['bodies/a.json', 'bodies/b.json', 'bodies/c.json', 'render/a.surface.json', 'sites/s.json', 'visuals/v.json']);
      const lib = await loadDefs(source);
      expect(Object.keys(lib.bodies).sort()).toEqual(['a', 'b', 'c']);
      expect(lib.bodies['b']!.name).toBe('B staged');
      expect(lib.bodies['b']!.mu).toBe(2);
      expect(lib.bodies['a']).toMatchObject({ extra: { from: 'base' } });
      expect(lib.bodies['c']).toMatchObject({ terrain: { from: 'staged' }, look: { from: 'base' } });
      // The base's site and section are the base's; the second root's are not in the library.
      expect(Object.keys(lib.sites)).toEqual(['s']);
      expect(lib.sites['s']).toMatchObject({ from: 'base' });
      expect(lib.sections).toEqual({ 'visuals/v': { from: 'base' } });
      // The base alone is unchanged by having been laid under.
      expect((await loadDefs(memorySource(base))).bodies['b']!.name).toBe('B of the base');
    });

    it('the directories to lay over are an argument; a $ref still cannot leave the roots', async () => {
      const lib = await loadDefs(overlayDefSource(memorySource(base), memorySource(staged), ['bodies', 'sites']));
      expect(Object.keys(lib.sites).sort()).toEqual(['s', 't']);
      expect(lib.sites['s']).toMatchObject({ from: 'staged' });
      const escaping = { ...staged, 'bodies/c.json': { ...staged['bodies/c.json'], terrain: { $ref: '../../terrain/c.terrain.json' } } };
      await expect(loadDefs(overlayDefSource(memorySource(base), memorySource(escaping)))).rejects.toThrow(/escapes the defs root/);
      const dangling = { ...staged, 'bodies/c.json': { ...staged['bodies/c.json'], terrain: { $ref: '../terrain/nowhere.json' } } };
      await expect(loadDefs(overlayDefSource(memorySource(base), memorySource(dangling)))).rejects.toThrow(/bodies\/c\.json: \$ref target "terrain\/nowhere\.json" not found/);
    });

    it('a declared table beside the bodies is not a body, in either root; an undeclared one fails by name', async () => {
      expect(TABLE_FILES).toContain('bodies/radii.json');
      const table = { description: 'radii', bodies: [{ id: 'a', meanRadius: 1 }] };
      const lib = await loadDefs(overlayDefSource(memorySource(base), memorySource({ ...staged, 'bodies/radii.json': table })));
      expect(Object.keys(lib.bodies).sort()).toEqual(['a', 'b', 'c']);
      expect(Object.keys((await loadDefs(memorySource({ ...base, 'bodies/radii.json': table }))).bodies).sort()).toEqual(['a', 'b']);
      // The rule is the declaration, not the content: the same table under another name is taken for a definition.
      await expect(loadDefs(overlayDefSource(memorySource(base), memorySource({ ...staged, 'bodies/masses.json': table })))).rejects.toThrow(/bodies\/masses\.json: definition must be an object with a string "id"/);
      // A table is a table whatever it holds: a file at a declared path is never read as a body.
      const lib2 = await loadDefs(memorySource({ ...base, 'bodies/radii.json': { id: 'radii', parent: null, mu: 1, radius: 1, orbit: null } }));
      expect(lib2.bodies['radii']).toBeUndefined();
    });

    it('the staged body library of this repository loads over data/defs', async () => {
      const stagedRoot = path.resolve(process.cwd(), 'data/staged');
      const stagedBodies = path.join(stagedRoot, 'bodies');
      if (!fs.existsSync(stagedBodies)) {
        console.log('[overlay] data/staged/bodies is not in this tree: the staged library is not loaded');
        return;
      }
      const lib = await loadDefs(overlayDefSource(fsDefSource(), fsDefSource(stagedRoot)));
      const expected = fs
        .readdirSync(stagedBodies)
        .filter((f) => f.endsWith('.json') && f.slice(0, -5).indexOf('.') === -1 && !TABLE_FILES.includes(`bodies/${f}`))
        .map((f) => f.slice(0, -5));
      const base = await loadDefs(fsDefSource());
      expect(Object.keys(lib.bodies).sort()).toEqual([...new Set([...expected, ...Object.keys(base.bodies)])].sort());
      expect(lib.bodies[lib.rootBodyId]!.parent).toBeNull();
      // Everything but the bodies is the first root's.
      expect(Object.keys(lib.sites)).toEqual(Object.keys(base.sites));
      expect(Object.keys(lib.vehicles)).toEqual(Object.keys(base.vehicles));
      expect(Object.keys(lib.sections)).toEqual(Object.keys(base.sections));
    });
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
      'sites/k.json': siteFile('k', 'a'),
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
      'sites/k.json': siteFile('k', 'a'),
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
