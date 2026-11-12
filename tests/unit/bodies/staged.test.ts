/**
 * The staged body library (data/staged, written by tools/bodies/generate.mjs): one file per body of the brief's
 * list, each equal to its typed fixture entry (which the compiler checks against the v2 BodyDef), terrain
 * sections and $refs that stay inside their root, the radii table, Earth and the Moon as the design pins them,
 * and the generator's output equal to what is on disk.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BodyDef } from '../../../src/core/contracts/defs';
import { loadDefs, resolveRefs, type DefSource } from '../../../src/core/defs/loader';
import { generateFiles } from '../../../tools/bodies/generate.mjs';
import { STAGED_BODY_FILES, STAGED_RADII, STAGED_TERRAIN_FILES } from './stagedBodies.generated';

const ROOT = join(__dirname, '../../..');
const STAGED = join(ROOT, 'data/staged');
const DEFS = join(ROOT, 'data/defs');

/** The brief's list, by name (the test iterates it; it never counts). */
const BRIEF_LIST = [
  'Sun',
  'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune',
  'Moon',
  'Phobos', 'Deimos',
  'Io', 'Europa', 'Ganymede', 'Callisto',
  'Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Iapetus',
  'Miranda', 'Ariel', 'Umbriel', 'Titania', 'Oberon',
  'Triton',
  'Ceres',
  'Pluto', 'Charon',
];
const idOf = (name: string): string => name.toLowerCase();

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

/** The overlay the loader will use (sim-core-v2): a staged file replaces or adds to data/defs. */
const overlay: DefSource = {
  list: () => Promise.resolve([]),
  read: (path) => {
    for (const root of [STAGED, DEFS]) {
      const p = join(root, path);
      if (existsSync(p)) return Promise.resolve(readJson(p));
    }
    return Promise.resolve(undefined);
  },
};

function refsOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) refsOf(x, out);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['$ref'] === 'string') out.push(o['$ref']);
    else for (const x of Object.values(o)) refsOf(x, out);
  }
  return out;
}

/**
 * planet-bake's baked tile sets are git-ignored (absent on CI): the generator reads their height ranges through
 * the tracked snapshot tools/bodies/sources/bake-manifests.json. Where the tiles ARE present, the snapshot must
 * equal them (otherwise run node tools/bodies/fetch-sources.mjs and regenerate). Skipped, explicitly, without them.
 */
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tools/bodies/sources/bake-manifests.json'), 'utf8')) as {
  bodies: Record<string, { radius: number; elevation: { min: number; max: number }; residentHeightLevel: number; contentHash: string }>;
};
const HAS_BAKED_TILES = Object.keys(SNAPSHOT.bodies).every((id) => existsSync(join(ROOT, 'data/tiles', id, 'manifest.json')));

describe.skipIf(!HAS_BAKED_TILES)('the manifest snapshot equals the baked tile sets (needs data/tiles)', () => {
  it.each(Object.keys(SNAPSHOT.bodies))('%s', (id) => {
    const m = readJson(join(ROOT, 'data/tiles', id, 'manifest.json')) as { radius: number; residentHeightLevel: number; contentHash: string; layers: { height: { elevation: { min: number; max: number } } } };
    const s = SNAPSHOT.bodies[id]!;
    // + 0: a manifest may hold -0, which JSON writes back as 0
    expect({ radius: m.radius, elevation: { min: m.layers.height.elevation.min + 0, max: m.layers.height.elevation.max + 0 }, residentHeightLevel: m.residentHeightLevel, contentHash: m.contentHash }).toEqual(s);
  });
});

describe('staged body library', () => {
  it.each(BRIEF_LIST)('%s: staged file exists and equals its typed fixture entry', (name) => {
    const id = idOf(name);
    const file = join(STAGED, 'bodies', `${id}.json`);
    expect(existsSync(file), file).toBe(true);
    const json = readJson(file) as { id: string; name: string };
    expect(json.id).toBe(id);
    expect(json.name).toBe(name);
    expect(json).toEqual(STAGED_BODY_FILES[id as keyof typeof STAGED_BODY_FILES]);
  });

  it('the fixture holds exactly the bodies of the list', () => {
    expect(Object.keys(STAGED_BODY_FILES).sort()).toEqual(BRIEF_LIST.map(idOf).sort());
  });

  it.each(BRIEF_LIST)('%s: every $ref resolves inside its root (staged first, then data/defs) to a BodyDef', async (name) => {
    const id = idOf(name);
    const rel = `bodies/${id}.json`;
    const raw = readJson(join(STAGED, rel));
    for (const ref of refsOf(raw)) expect(ref.startsWith('../') && !ref.startsWith('../../'), ref).toBe(true);
    const def = (await resolveRefs(raw, rel, overlay)) as BodyDef;
    expect(refsOf(def)).toEqual([]);
    if (def.terrain) {
      expect(typeof def.terrain.tileset).toBe('string');
      expect(typeof def.terrain.amplification.model).toBe('string');
    }
    expect(def.render.geometricAlbedo).toBeGreaterThanOrEqual(0);
  });

  it('every new solid body references its own staged terrain section; Earth and the Moon their existing sections', () => {
    for (const name of BRIEF_LIST) {
      const id = idOf(name);
      const raw = readJson(join(STAGED, 'bodies', `${id}.json`)) as { terrain: unknown };
      const refs = refsOf(raw);
      if (id === 'earth' || id === 'moon') {
        expect(refs.length).toBeGreaterThan(0);
        for (const r of refs) expect(existsSync(join(DEFS, 'bodies', r)), r).toBe(true);
        for (const r of refs) expect(existsSync(join(STAGED, 'bodies', r)), r).toBe(false);
        continue;
      }
      const section = STAGED_TERRAIN_FILES[id as keyof typeof STAGED_TERRAIN_FILES];
      if (section) {
        expect(raw.terrain).toEqual({ $ref: `../terrain/${id}.terrain.json` });
        expect(readJson(join(STAGED, 'terrain', `${id}.terrain.json`))).toEqual(section);
        expect(section.tileset).toBe(id);
        expect(['rocky-generic', 'icy-generic']).toContain(section.amplification.model);
      } else expect(raw.terrain).toBeNull();
    }
  });

  it('radii.json lists every body with its mean radius equal to the definition', () => {
    const table = readJson(join(STAGED, 'bodies', 'radii.json')) as { bodies: typeof STAGED_RADII };
    expect(table.bodies).toEqual(STAGED_RADII);
    for (const name of BRIEF_LIST) {
      const id = idOf(name);
      const row = table.bodies.find((r) => r.id === id);
      expect(row, id).toBeDefined();
      const def = readJson(join(STAGED, 'bodies', `${id}.json`)) as { radius: number; shape?: { equatorialRadius: number; polarRadius: number } };
      expect(row!.meanRadius).toBe(def.radius);
      if (def.shape) {
        expect(def.shape.equatorialRadius).toBe(row!.equatorialRadius);
        expect(def.shape.polarRadius).toBe(row!.polarRadius);
      }
    }
  });

  it("the Moon's staged file is byte-identical to today's (its orbit block included)", () => {
    const live = readFileSync(join(DEFS, 'bodies/moon.json'), 'utf8');
    const staged = readFileSync(join(STAGED, 'bodies/moon.json'), 'utf8');
    expect(staged).toBe(live);
    const block = (t: string): string => /"orbit": \{[^}]*\}/.exec(t)![0];
    expect(block(staged)).toBe(block(live));
  });

  it("Earth's staged file is today's with the v2 orbit about the Sun", () => {
    const live = readJson(join(DEFS, 'bodies/earth.json')) as Record<string, unknown>;
    const staged = readJson(join(STAGED, 'bodies/earth.json')) as Record<string, unknown>;
    expect(staged['orbit']).toEqual({ kind: 'sunLowPrecision', inverted: true });
    expect(staged['parent']).toBe('sun');
    expect(typeof staged['soiRadius']).toBe('number');
    const strip = (o: Record<string, unknown>): Record<string, unknown> => {
      const { parent: _p, orbit: _o, soiRadius: _s, ...rest } = o;
      return rest;
    };
    expect(strip(staged)).toEqual(strip(live));
  });

  it('the Sun is the only root, an attractor with emission', () => {
    const roots = BRIEF_LIST.map(idOf).filter((id) => (readJson(join(STAGED, 'bodies', `${id}.json`)) as { parent: unknown }).parent === null);
    expect(roots).toEqual(['sun']);
    const sun = STAGED_BODY_FILES.sun;
    expect(sun.gravityRole).toBe('attractor');
    expect(sun.emission).not.toBeNull();
  });

  it('the whole library loads through the loader with data/staged laid over data/defs (radii.json excepted: request bodies-ephemeris-1)', async () => {
    const list = (root: string, dir = ''): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(root, `${dir}${e.name}/`) : e.name.endsWith('.json') ? [`${dir}${e.name}`] : []));
    const staged = list(STAGED).filter((p) => p.startsWith('bodies/') || p.startsWith('terrain/')).filter((p) => p !== 'bodies/radii.json');
    // The staged bodies replace the three live ones; everything else (sites, scenarios, sections) is data/defs.
    const files = [...new Set([...list(DEFS).filter((p) => !p.startsWith('bodies/')), ...staged])];
    const lib = await loadDefs({ list: () => Promise.resolve(files), read: overlay.read });
    expect(Object.keys(lib.bodies).sort()).toEqual(BRIEF_LIST.map(idOf).sort());
    expect(lib.rootBodyId).toBe('sun');
    expect(lib.bodies['mars']!.terrain!.tileset).toBe('mars');
  });

  it('every body has a tolerance row; a widened row gives its reason; every fit residual is inside its row', () => {
    interface Row { id: string; class: string; angleDeg?: number; radial?: number; reason?: string }
    const tol = readJson(join(ROOT, 'tools/bodies/tolerances.json')) as { classes: Record<string, { angleDeg: number; radial: number }>; bodies: Row[] };
    const fits = readJson(join(ROOT, 'tools/bodies/sources/orbit-fits.json')) as { bodies: Record<string, { residual: { maxAngleDeg: number; maxRadial: number }; def: unknown }> };
    for (const name of BRIEF_LIST.slice(1)) {
      const id = idOf(name);
      const row = tol.bodies.find((r) => r.id === id);
      expect(row, id).toBeDefined();
      if (row!.class === 'pinned') {
        expect(['earth', 'moon']).toContain(id);
        continue;
      }
      const cls = tol.classes[row!.class]!;
      const bound = { angleDeg: row!.angleDeg ?? cls.angleDeg, radial: row!.radial ?? cls.radial };
      if (bound.angleDeg > cls.angleDeg || bound.radial > cls.radial) expect((row!.reason ?? '').length, id).toBeGreaterThan(40);
      const f = fits.bodies[id]!;
      expect(f.residual.maxAngleDeg, id).toBeLessThanOrEqual(bound.angleDeg);
      expect(f.residual.maxRadial, id).toBeLessThanOrEqual(bound.radial);
      expect((readJson(join(STAGED, 'bodies', `${id}.json`)) as { orbit: unknown }).orbit, id).toEqual(f.def);
    }
  });

  it('the generator reproduces every staged file byte for byte (generate --check)', () => {
    const files = generateFiles();
    for (const [rel, content] of files) expect(readFileSync(join(ROOT, rel), 'utf8'), rel).toBe(content);
  });
});
