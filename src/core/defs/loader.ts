/**
 * Loads data/defs/** into a DefLibrary. Platform-neutral: the caller supplies a DefSource (fetch-based in
 * the browser, fs-based in Node; see fetchSource.ts / fsSource.ts).
 *
 * Layout (paths relative to data/defs):
 *   bodies/*.json  sites/*.json  parts/*.json  vehicles/*.json  scenarios/*.json   one definition per file
 *   resources.json                                                                  array of ResourceDef
 * Only files whose name has no extra dot segment are definitions ("earth.json" yes, "earth.atmosphere.json"
 * and "ka-lae-lc1.location.json" no): dotted files are sections pulled in through { "$ref": ... }.
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
    if (!lib.vehicles[s.vehicle]) throw new DefError(`scenarios/${s.id}.json`, `unknown vehicle "${s.vehicle}"`);
    if (!lib.sites[s.site]) throw new DefError(`scenarios/${s.id}.json`, `unknown site "${s.site}"`);
    if (s.target !== null && !lib.bodies[s.target]) throw new DefError(`scenarios/${s.id}.json`, `unknown target "${s.target}"`);
  }
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
  const rootBodyId = Object.values(bodies).find((b) => b.parent === null)?.id ?? '';
  const lib: DefLibrary = { bodies, rootBodyId, sites, resources, parts, vehicles, scenarios };
  validateLibrary(lib);
  return lib;
}
