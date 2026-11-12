/**
 * Loads data/defs/** into a DefLibrary. Platform-neutral: the caller supplies a DefSource (fetch-based in
 * the browser, fs-based in Node; see fetchSource.ts / fsSource.ts).
 *
 * Layout (paths relative to data/defs):
 *   bodies/*.json  sites/*.json  parts/*.json  vehicles/*.json  scenarios/*.json   one definition per file
 *   resources.json                                                                  array of ResourceDef
 *   audio/**.json  visuals/**.json                                                  sections (DefLibrary.sections)
 * Only files whose name has no extra dot segment are definitions ("earth.json" yes, "earth.atmosphere.json"
 * and "ka-lae-lc1.location.json" no): dotted files are sections pulled in through { "$ref": ... }.
 * Every JSON file under the section directories is additionally exposed, with its $refs resolved, in
 * DefLibrary.sections under its path without the extension ("visuals/plumes", "audio/engines", ...).
 * `regions/` (bake manifests) is not loaded: only the Python bake tools read it.
 */
import type {
  BodyDef,
  DefLibrary,
  LaunchSiteDef,
  PartDef,
  ResourceDef,
  ScenarioDef,
  VehicleDef,
} from '../contracts/defs';

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

const isDefinitionFile = (path: string, dir: string): boolean => {
  if (!path.startsWith(`${dir}/`)) return false;
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
    if (!lib.sites[s.site]) throw new DefError(file, `unknown site "${s.site}"`);
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
      const title = (m as { title?: unknown }).title;
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
  const parts = await loadDir<PartDef>(source, files, 'parts');
  const vehicles = await loadDir<VehicleDef>(source, files, 'vehicles');
  const scenarios = await loadDir<ScenarioDef>(source, files, 'scenarios');
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
  const lib: DefLibrary = { bodies, rootBodyId, sites, resources, parts, vehicles, scenarios, sections };
  validateLibrary(lib);
  return lib;
}
