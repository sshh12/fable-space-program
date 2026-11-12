// Loads the extracted source tables (tools/bodies/sources/*.json) and the live v1 definitions the staged
// Earth, Moon and Sun keep fields of (data/defs/bodies, data/defs/terrain, read only).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './http.mjs';

export const SOURCES_DIR = join(REPO_ROOT, 'tools/bodies/sources');
export const LIVE_DEFS = join(REPO_ROOT, 'data/defs');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function loadSources() {
  const s = (id) => readJson(join(SOURCES_DIR, `${id}.json`));
  return {
    approxPos: s('jpl-approx-pos'),
    satElem: s('jpl-sat-elem'),
    satPhys: s('jpl-sat-phys'),
    planetPhys: s('jpl-planet-phys'),
    astroPar: s('jpl-astro-par'),
    pck: s('naif-pck00011'),
    sbdb: { 'sbdb-ceres': s('sbdb-ceres'), 'sbdb-pluto': s('sbdb-pluto') },
    objdata: s('horizons-objdata'),
    nssdc: s('nssdc'),
    states: s('horizons-states'),
    atmospheres: s('atmospheres'),
    bakeManifests: s('bake-manifests'),
    colours: s('colours'),
    orbitFits: s('orbit-fits'),
  };
}

/**
 * planet-bake's body configs (tools/bake/planet/bodies/<id>.json) and model parameter files
 * (data/defs/terrain/<model>.amplification.json), read only: the terrain sections take the amplification of
 * the bake (seed, overrides) so the baked and the run-time crater populations are one. All tracked: generation
 * reads no baked data (the manifests' height ranges come through tools/bodies/sources/bake-manifests.json).
 */
export function loadBake() {
  const dir = join(REPO_ROOT, 'tools/bake/planet/bodies');
  const configs = {};
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) configs[f.slice(0, -5)] = readJson(join(dir, f));
  const models = {};
  for (const m of ['rocky-generic', 'icy-generic']) {
    const p = join(LIVE_DEFS, 'terrain', `${m}.amplification.json`);
    if (existsSync(p)) models[m] = readJson(p);
  }
  return { configs, models };
}

/** The live v1 files (raw text and parsed), which the staged Earth, Moon and Sun derive from. */
export function loadLive() {
  const raw = (rel) => readFileSync(join(LIVE_DEFS, rel), 'utf8');
  return {
    earth: { text: raw('bodies/earth.json'), json: JSON.parse(raw('bodies/earth.json')) },
    moon: { text: raw('bodies/moon.json'), json: JSON.parse(raw('bodies/moon.json')) },
    sun: { text: raw('bodies/sun.json'), json: JSON.parse(raw('bodies/sun.json')) },
  };
}

/** The baked manifests (data/tiles/<id>/manifest.json, git-ignored) of the bodies planet-bake bakes, or {} where absent. */
export function loadBakedManifests(ids) {
  const out = {};
  for (const id of ids) {
    const p = join(REPO_ROOT, 'data/tiles', id, 'manifest.json');
    if (existsSync(p)) out[id] = readJson(p);
  }
  return out;
}
