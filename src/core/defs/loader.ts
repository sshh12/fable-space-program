/**
 * Loads data/defs/** into a DefLibrary. Platform-neutral: the caller supplies a DefSource (fetch-based in
 * the browser, fs-based in Node; see fetchSource.ts / fsSource.ts).
 *
 * Layout (paths relative to data/defs):
 *   bodies/*.json  sites/*.json  parts/*.json  vehicles/*.json  scenarios/*.json   one definition per file
 *   rules/*.json                                                                    one UniverseRules document per file
 *   resources.json                                                                  array of ResourceDef
 *   audio/**.json  visuals/**.json                                                  sections (DefLibrary.sections)
 * Only files whose name has no extra dot segment are definitions ("earth.json" yes, "earth.atmosphere.json"
 * and "ka-lae-lc1.location.json" no): dotted files are sections pulled in through { "$ref": ... }.
 * A data table that lives beside the definitions of a directory is declared in TABLE_FILES
 * ("bodies/radii.json") and is never read as a definition; any other file of a definition directory that is
 * not a definition is an error that names the file.
 * A second root can be laid over the first (overlayDefSource): its bodies replace or add to the first's,
 * and its other files are "$ref" targets, so a staged library loads without a "$ref" leaving a defs root.
 * Every JSON file under the section directories is additionally exposed, with its $refs resolved, in
 * DefLibrary.sections under its path without the extension ("visuals/plumes", "audio/engines", ...).
 * `regions/` (bake manifests) is not loaded: only the Python bake tools read it.
 *
 * Sites (MIGRATION_V2 step 3.6): a site file states its pads in `pads`; the loader fills the deprecated
 * single pad (`pad`, `padAzimuthDeg`, `structures`) from the first pad, and `location.pads` with the
 * first pad at the reference point, so a loaded site always has both forms (normaliseSite below).
 */
import type {
  BodyDef,
  DefLibrary,
  LaunchSiteDef,
  PadDef,
  PartDef,
  ResourceDef,
  ScenarioDef,
  VehicleDef,
} from '../contracts/defs';
import { DEFAULT_UNIVERSE_RULES, type PadClass, type UniverseRules } from '../contracts/net';
import { padsOf, singlePadOf } from './sites';

export interface DefSource {
  /** All JSON file paths under the defs root, relative, forward slashes (e.g. "bodies/earth.json"). */
  list(): Promise<string[]>;
  /** Parsed JSON content, or undefined when the file does not exist. */
  read(path: string): Promise<unknown | undefined>;
}

export class DefError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'DefError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function joinPath(baseFile: string, rel: string): string {
  const parts = baseFile.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) throw new DefError(baseFile, `$ref "${rel}" escapes the defs root`);
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Recursively replace { $ref, optional? } objects by the referenced file content. */
export async function resolveRefs(value: unknown, file: string, source: DefSource, depth = 0): Promise<unknown> {
  if (depth > 16) throw new DefError(file, '$ref nesting too deep (cycle?)');
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveRefs(v, file, source, depth)));
  }
  if (!isObject(value)) return value;
  if (typeof value['$ref'] === 'string') {
    const target = joinPath(file, value['$ref']);
    const loaded = await source.read(target);
    if (loaded === undefined) {
      if (value['optional'] === true) return null;
      throw new DefError(file, `$ref target "${target}" not found`);
    }
    return resolveRefs(loaded, target, source, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = await resolveRefs(v, file, source, depth);
  return out;
}

/**
 * Data tables beside the definitions of a directory, by path under a defs root (request bodies-ephemeris-1).
 * A table is not a definition: the loader never reads it, in the first root or in an overlay. The list is
 * the declaration: a table that is not listed here is taken for a definition and fails loudly.
 *   bodies/radii.json   mean, equatorial and polar radius of every body (the bodies generator's cross-check)
 */
export const TABLE_FILES: readonly string[] = ['bodies/radii.json'];

/** Directories of a second root that overlayDefSource lays over the first by default. */
export const OVERLAY_DIRS: readonly string[] = ['bodies'];

/**
 * A defs root with a second root laid over it (MIGRATION_V2 step 3.6; the staged bodies of data/staged over
 * data/defs until the activation step moves them).
 *
 * - Under the directories `dirs` (default: `bodies`) the overlay REPLACES OR ADDS: its files are listed
 *   with the base's, and a path that both roots have is read from the overlay.
 * - Every other file of the overlay is a "$ref" target only: it is not listed (so it is never a definition
 *   or a section), and it is read when the base has no file at that path. A staged body can therefore refer
 *   to "../terrain/<id>.terrain.json" of its own root and to "../render/<id>.surface.json" of the base alike,
 *   and no "$ref" leaves a defs root.
 * - TABLE_FILES are tables in either root.
 */
export function overlayDefSource(base: DefSource, overlay: DefSource, dirs: readonly string[] = OVERLAY_DIRS): DefSource {
  const laidOver = (path: string): boolean => dirs.some((d) => path.startsWith(`${d}/`));
  let listing: Promise<string[]> | null = null;
  return {
    list() {
      listing ??= Promise.all([base.list(), overlay.list()]).then(([b, o]) => [...new Set([...b, ...o.filter(laidOver)])].sort());
      return listing;
    },
    async read(path) {
      const [first, second] = laidOver(path) ? [overlay, base] : [base, overlay];
      const found = await first.read(path);
      return found !== undefined ? found : second.read(path);
    },
  };
}

const isDefinitionFile = (path: string, dir: string): boolean => {
  if (!path.startsWith(`${dir}/`) || TABLE_FILES.includes(path)) return false;
  const name = path.slice(dir.length + 1);
  return !name.includes('/') && name.endsWith('.json') && name.slice(0, -5).indexOf('.') === -1;
};

async function loadDir<T extends { id: string }>(source: DefSource, files: string[], dir: string): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const file of files.filter((f) => isDefinitionFile(f, dir)).sort()) {
    const raw = await source.read(file);
    const def = (await resolveRefs(raw, file, source)) as T;
    if (!isObject(def) || typeof def.id !== 'string') throw new DefError(file, 'definition must be an object with a string "id"');
    const expected = file.slice(dir.length + 1, -5);
    if (def.id !== expected) throw new DefError(file, `id "${def.id}" must equal the file name "${expected}"`);
    if (out[def.id]) throw new DefError(file, `duplicate id "${def.id}"`);
    out[def.id] = def;
  }
  return out;
}

const PAD_CLASSES: readonly PadClass[] = ['light', 'medium', 'heavy'];
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPlace = (v: unknown): v is { latDeg: number; lonDeg: number; padElevation: number | 'terrain' } =>
  isObject(v) && isFiniteNumber(v['latDeg']) && isFiniteNumber(v['lonDeg']) && (isFiniteNumber(v['padElevation']) || v['padElevation'] === 'terrain');

function checkPad(pad: unknown, index: number, file: string, seen: Set<string>): void {
  const at = `pads[${index}]`;
  if (!isObject(pad) || typeof pad['id'] !== 'string' || pad['id'] === '') throw new DefError(file, `${at} must be an object with a non-empty string "id"`);
  const id = pad['id'];
  const bad = (what: string): never => {
    throw new DefError(file, `pad "${id}" (${at}): ${what}`);
  };
  if (seen.has(id)) bad('duplicate pad id');
  seen.add(id);
  if (typeof pad['name'] !== 'string' || pad['name'].trim() === '') bad('"name" must be a non-empty string');
  const offset = pad['offsetEnu'];
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(isFiniteNumber)) bad('"offsetEnu" must be [east, north] in metres');
  if (!isFiniteNumber(pad['azimuthDeg'])) bad('"azimuthDeg" must be a number of degrees');
  if (!PAD_CLASSES.includes(pad['class'] as PadClass)) bad(`"class" must be one of ${PAD_CLASSES.join(', ')}`);
  for (const k of ['maxLiftoffMass', 'maxDiameter']) {
    if (!(isFiniteNumber(pad[k]) && pad[k] > 0)) bad(`"${k}" must be a positive number`);
  }
  const flat = pad['flatRadius'];
  const blend = pad['blendRadius'];
  if (!(isFiniteNumber(flat) && isFiniteNumber(blend) && flat >= 0 && blend > flat)) bad('needs 0 <= flatRadius < blendRadius');
  if (!(isFiniteNumber(pad['mountHeight']) && pad['mountHeight'] >= 0)) bad('"mountHeight" must be a number of metres from 0');
  if (pad['keepOutRadius'] !== undefined && !(isFiniteNumber(pad['keepOutRadius']) && pad['keepOutRadius'] > 0)) bad('"keepOutRadius" must be a positive number when present');
  if (!Array.isArray(pad['structures'])) bad('"structures" must be an array (it may be empty)');
}

/**
 * A site as the library holds it (MIGRATION_V2 step 3.6): its pad list and the deprecated single pad filled
 * from each other, and a location for every pad.
 *
 * - A file with `pads` states its pads THERE ONLY. `pad`, `padAzimuthDeg` and `structures` are then
 *   written from the first pad (the deprecated single pad IS `pads[0]`), so code that still reads them
 *   sees the first pad; a file that states them as well is refused, because two statements of one pad can
 *   disagree.
 * - A file with the deprecated single pad and no list gets that pad as its one pad (`singlePadOf`).
 * - `location.pads` holds every pad afterwards: the first pad at the reference point (an entry for it in
 *   the file must equal the reference point), every other pad at the resolved coordinates the file states
 *   (the site-resolve bake tool writes them; an elevation cannot be derived from an offset).
 */
export function normaliseSite(site: LaunchSiteDef, file: string): void {
  const raw = site as unknown as Record<string, unknown>;
  if (!isPlace(raw['location'])) throw new DefError(file, '"location" needs latDeg, lonDeg and padElevation (metres, or "terrain")');
  if (raw['pads'] !== undefined) {
    const list = raw['pads'];
    if (!Array.isArray(list) || list.length === 0) throw new DefError(file, '"pads" must be a non-empty array');
    for (const k of ['pad', 'padAzimuthDeg', 'structures']) {
      if (raw[k] !== undefined) throw new DefError(file, `"${k}" is the deprecated single pad: a site with "pads" states its pads in the list only`);
    }
    const seen = new Set<string>();
    list.forEach((p, i) => checkPad(p, i, file, seen));
    const first = (list as PadDef[])[0]!;
    site.padAzimuthDeg = first.azimuthDeg;
    site.pad = { flatRadius: first.flatRadius, blendRadius: first.blendRadius, clampHeight: first.mountHeight, ...(first.shape ? { shape: first.shape } : {}) };
    site.structures = first.structures;
  } else {
    const single = raw['pad'];
    if (!isObject(single) || !isFiniteNumber(single['flatRadius']) || !isFiniteNumber(single['blendRadius']) || !isFiniteNumber(single['clampHeight']) || !isFiniteNumber(raw['padAzimuthDeg']) || !Array.isArray(raw['structures'])) {
      throw new DefError(file, 'a site needs "pads" (or the deprecated single pad: "pad" with flatRadius, blendRadius and clampHeight, "padAzimuthDeg" and "structures")');
    }
    site.pads = [singlePadOf(site)];
  }
  const pads = padsOf(site);
  const stated = (raw['location'] as Record<string, unknown>)['pads'];
  if (stated !== undefined && !isObject(stated)) throw new DefError(file, '"location.pads" must be an object: pad id -> latDeg, lonDeg, padElevation');
  const resolved = (site.location.pads ??= {});
  for (const id of Object.keys(resolved)) {
    if (!pads.some((p) => p.id === id)) throw new DefError(file, `location.pads names "${id}", which is not a pad of the site (pads: ${pads.map((p) => p.id).join(', ')})`);
    if (!isPlace(resolved[id])) throw new DefError(file, `location.pads["${id}"] needs latDeg, lonDeg and padElevation (metres, or "terrain")`);
  }
  const reference = { latDeg: site.location.latDeg, lonDeg: site.location.lonDeg, padElevation: site.location.padElevation };
  const firstId = pads[0]!.id;
  const firstAt = resolved[firstId];
  if (firstAt === undefined) resolved[firstId] = reference;
  else if (firstAt.latDeg !== reference.latDeg || firstAt.lonDeg !== reference.lonDeg || firstAt.padElevation !== reference.padElevation) {
    throw new DefError(file, `location.pads["${firstId}"] differs from the reference point: the reference point of a site is the location of its first pad`);
  }
  for (const p of pads.slice(1)) {
    if (resolved[p.id] === undefined) throw new DefError(file, `pad "${p.id}" has no resolved coordinates (location.pads["${p.id}"]: latDeg, lonDeg, padElevation, written by the site-resolve bake tool)`);
  }
}

/**
 * A rules document has exactly the fields of the contract's default document (so a file written before the
 * contract gained a field fails by the field's name instead of yielding `undefined` somewhere in a
 * countdown), a finite number wherever the default has a number, and a version from 1.
 */
export function validateRules(doc: UniverseRules, file: string): void {
  const walk = (value: unknown, model: unknown, at: string): void => {
    if (Array.isArray(model)) {
      if (!Array.isArray(value)) throw new DefError(file, `"${at}" must be an array`);
    } else if (isObject(model)) {
      if (!isObject(value)) throw new DefError(file, `"${at}" must be an object`);
      const path = (k: string): string => (at === '' ? k : `${at}.${k}`);
      for (const k of Object.keys(model)) {
        if (!(k in value)) throw new DefError(file, `"${path(k)}" is missing (every field of UniverseRules is stated in a rules document)`);
        walk(value[k], model[k], path(k));
      }
      for (const k of Object.keys(value)) {
        if (!(k in model)) throw new DefError(file, `"${path(k)}" is not a field of UniverseRules`);
      }
    } else if (typeof model === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new DefError(file, `"${at}" must be a finite number, got ${JSON.stringify(value)}`);
    } else if (typeof model === 'boolean') {
      if (typeof value !== 'boolean') throw new DefError(file, `"${at}" must be true or false, got ${JSON.stringify(value)}`);
    }
  };
  walk(doc, DEFAULT_UNIVERSE_RULES, '');
  if (!Number.isInteger(doc.version) || doc.version < 1) throw new DefError(file, `"version" must be an integer from 1, got ${String(doc.version)}`);
}

/** Structural cross-reference checks shared by every consumer. Deeper physical validation lives with each owner. */
export function validateLibrary(lib: DefLibrary): void {
  const bodyIds = Object.keys(lib.bodies);
  const roots = bodyIds.filter((id) => lib.bodies[id]!.parent === null);
  if (roots.length !== 1) throw new DefError('bodies', `expected exactly one root body, found ${roots.length}`);
  for (const b of Object.values(lib.bodies)) {
    if (b.parent !== null && !lib.bodies[b.parent]) throw new DefError(`bodies/${b.id}.json`, `unknown parent "${b.parent}"`);
    if (!(b.mu > 0) || !(b.radius > 0)) throw new DefError(`bodies/${b.id}.json`, 'mu and radius must be positive');
    if (b.parent !== null && b.orbit === null) throw new DefError(`bodies/${b.id}.json`, 'non-root body needs an orbit');
  }
  for (const s of Object.values(lib.sites)) {
    if (!lib.bodies[s.bodyId]) throw new DefError(`sites/${s.id}.json`, `unknown body "${s.bodyId}"`);
  }
  for (const r of Object.values(lib.rules ?? {})) validateRules(r, `rules/${r.id}.json`);
  for (const p of Object.values(lib.parts)) {
    for (const r of p.resources ?? []) {
      if (!lib.resources[r.resource]) throw new DefError(`parts/${p.id}.json`, `unknown resource "${r.resource}"`);
    }
  }
  for (const v of Object.values(lib.vehicles)) {
    const ids = new Set<string>();
    for (const p of v.parts) {
      if (!lib.parts[p.def]) throw new DefError(`vehicles/${v.id}.json`, `part "${p.id}" uses unknown def "${p.def}"`);
      if (ids.has(p.id)) throw new DefError(`vehicles/${v.id}.json`, `duplicate part instance id "${p.id}"`);
      ids.add(p.id);
    }
    for (const p of v.parts) {
      if (p.parent !== null && !ids.has(p.parent)) throw new DefError(`vehicles/${v.id}.json`, `part "${p.id}" has unknown parent "${p.parent}"`);
    }
  }
  for (const s of Object.values(lib.scenarios)) {
    const file = `scenarios/${s.id}.json`;
    if (!lib.vehicles[s.vehicle]) throw new DefError(file, `unknown vehicle "${s.vehicle}"`);
    const site = lib.sites[s.site];
    if (!site) throw new DefError(file, `unknown site "${s.site}"`);
    const pad: unknown = s.pad;
    if (pad !== undefined && (typeof pad !== 'string' || !padsOf(site).some((p) => p.id === pad))) {
      throw new DefError(file, `unknown pad ${JSON.stringify(pad)} of site "${s.site}" (pads: ${padsOf(site).map((p) => p.id).join(', ')})`);
    }
    if (s.target !== null && !lib.bodies[s.target]) throw new DefError(file, `unknown target "${s.target}"`);
    if (s.suggestedLanding && !lib.bodies[s.suggestedLanding.bodyId]) throw new DefError(file, `unknown landing body "${s.suggestedLanding.bodyId}"`);
    if (s.resources !== undefined) {
      if (!isObject(s.resources)) throw new DefError(file, '"resources" must be an object: part instance id -> resource id -> kg');
      const vehicle = lib.vehicles[s.vehicle]!;
      for (const [partId, amounts] of Object.entries(s.resources as Record<string, unknown>)) {
        const placement = vehicle.parts.find((p) => p.id === partId);
        if (!placement) throw new DefError(file, `resources: vehicle "${s.vehicle}" has no part "${partId}"`);
        if (!isObject(amounts)) throw new DefError(file, `resources of part "${partId}" must be an object: resource id -> kg`);
        const tanks = lib.parts[placement.def]!.resources ?? [];
        for (const [resource, kg] of Object.entries(amounts)) {
          const tank = tanks.find((t) => t.resource === resource);
          if (!tank) throw new DefError(file, `resources: part "${partId}" (${placement.def}) holds no "${resource}"`);
          // Amounts captured from a flight may sit a rounding error above the capacity.
          if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 0 || kg > tank.capacity * (1 + 1e-6)) {
            throw new DefError(file, `resources: "${resource}" of part "${partId}" must be a number of kg from 0 to its capacity ${tank.capacity}, got ${String(kg)}`);
          }
        }
      }
    }
    if (!Array.isArray(s.milestones)) throw new DefError(file, '"milestones" must be an array (it may be empty)');
    const seen = new Set<string>();
    for (const m of s.milestones) {
      if (typeof m.id !== 'string' || m.id === '') throw new DefError(file, 'every milestone needs a non-empty string id');
      if (seen.has(m.id)) throw new DefError(file, `duplicate milestone id "${m.id}"`);
      if (!isObject(m.trigger) || typeof m.trigger.kind !== 'string') throw new DefError(file, `milestone "${m.id}" needs a trigger with a kind`);
      // What the HUD announces (request flight-ui-5): optional, and a real title when it is there.
      const title: unknown = m.title;
      if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) throw new DefError(file, `milestone "${m.id}": "title" must be a non-empty string when present`);
      const bodyId = (m.trigger as { bodyId?: unknown }).bodyId;
      if (bodyId !== undefined && (typeof bodyId !== 'string' || !lib.bodies[bodyId])) throw new DefError(file, `milestone "${m.id}" refers to unknown body "${String(bodyId)}"`);
      for (const dep of m.after ?? []) {
        if (!seen.has(dep)) throw new DefError(file, `milestone "${m.id}" must be listed after its prerequisite "${dep}"`);
      }
      seen.add(m.id);
    }
  }
}

/** Directories whose JSON files are exposed as DefLibrary.sections. */
export const SECTION_DIRS = ['audio', 'visuals'] as const;

/** A section by key (path under data/defs without ".json"); throws a DefError naming the file when absent. */
export function getSection<T>(lib: DefLibrary, key: string): T {
  if (!(key in lib.sections)) throw new DefError(`${key}.json`, 'section file not found under data/defs');
  return lib.sections[key] as T;
}

/** All sections whose key starts with `prefix` (e.g. "visuals/cockpits/"), keyed by the remainder of the key. */
export function listSections<T>(lib: DefLibrary, prefix: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(lib.sections).sort()) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = lib.sections[key] as T;
  }
  return out;
}

export async function loadDefs(source: DefSource): Promise<DefLibrary> {
  const files = await source.list();
  const bodies = await loadDir<BodyDef>(source, files, 'bodies');
  const sites = await loadDir<LaunchSiteDef>(source, files, 'sites');
  for (const s of Object.values(sites)) normaliseSite(s, `sites/${s.id}.json`);
  const parts = await loadDir<PartDef>(source, files, 'parts');
  const vehicles = await loadDir<VehicleDef>(source, files, 'vehicles');
  const scenarios = await loadDir<ScenarioDef>(source, files, 'scenarios');
  const rules = await loadDir<UniverseRules>(source, files, 'rules');
  const resources: Record<string, ResourceDef> = {};
  const resList = await source.read('resources.json');
  if (resList !== undefined) {
    if (!Array.isArray(resList)) throw new DefError('resources.json', 'must be an array');
    for (const r of resList as ResourceDef[]) resources[r.id] = r;
  }
  const sections: Record<string, unknown> = {};
  for (const file of files.filter((f) => SECTION_DIRS.some((d) => f.startsWith(`${d}/`)) && f.endsWith('.json')).sort()) {
    sections[file.slice(0, -5)] = await resolveRefs(await source.read(file), file, source);
  }
  const rootBodyId = Object.values(bodies).find((b) => b.parent === null)?.id ?? '';
  const lib: DefLibrary = { bodies, rootBodyId, sites, resources, parts, vehicles, rules, scenarios, sections };
  validateLibrary(lib);
  return lib;
}
