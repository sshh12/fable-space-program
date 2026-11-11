/**
 * Feature discovery for the integration lab: which render packages of wave 2 exist in the tree right now,
 * and how to build their RenderFeatures.
 *
 * The packages may not import each other and may not exist yet, so nothing here is a static import. Vite's
 * `import.meta.glob` lists the `index.ts` files that are present when the page is served; a package that
 * has not landed is simply not in the map (no failed request, no error). Each package has one adapter that
 * calls its public factory the way its hand-off documents it. A factory that is missing or throws is
 * recorded in `problems` and the lab carries on with the features that did build, so one broken package
 * never hides the checks of the others.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import type { Sim } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import type { MfdPainter, NavballRenderer } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';

export const FEATURE_PACKAGES = ['terrain', 'vehicle', 'cockpit', 'ocean', 'sky', 'atmosphere', 'vfx'] as const;
export type FeaturePackage = (typeof FEATURE_PACKAGES)[number];

type Module = Record<string, unknown>;
const RENDER_MODULES = import.meta.glob<Module>('/src/render/{terrain,vehicle,cockpit,ocean,sky,atmosphere,vfx}/index.ts');
const SIM_MODULES = import.meta.glob<Module>('/src/sim/index.ts');

const modulePath = (p: FeaturePackage): string => `/src/render/${p}/index.ts`;

/** Packages whose public entry point exists in the tree. */
export function availablePackages(): FeaturePackage[] {
  return FEATURE_PACKAGES.filter((p) => modulePath(p) in RENDER_MODULES);
}

export const realSimAvailable = (): boolean => '/src/sim/index.ts' in SIM_MODULES;

/** What an adapter gets to build its package's features. */
export interface FeatureEnv {
  defs: DefLibrary;
  sim: Sim;
  ctx: RenderContext;
  gpu: GpuHandle;
  /** The height authority (fetch tile source on the baked tiles); shared by terrain and the real sim. */
  terrain: TerrainProvider;
  /** The shared navball texture renderer and the MFD painter of src/ui (the cockpit's instruments). */
  navball: NavballRenderer;
  mfdPainter: MfdPainter;
  query: URLSearchParams;
}

export interface BuiltFeatures {
  /** In registration order. */
  features: RenderFeature[];
  /** Packages that contributed at least one feature. */
  loaded: FeaturePackage[];
  /** Whatever each factory returned (debug handles, controls), keyed `<package>.<export>`. */
  handles: Record<string, unknown>;
  /** Missing exports, thrown errors, unexpected return shapes: `<package>: <what>`. */
  problems: string[];
}

const isFeature = (x: unknown): x is RenderFeature => typeof x === 'object' && x !== null && typeof (x as RenderFeature).id === 'string' && typeof (x as RenderFeature).init === 'function';

/** RenderFeatures out of a factory result: the result itself, a list, or its `feature` / `features` member. */
function featuresOf(result: unknown): RenderFeature[] {
  if (isFeature(result)) return [result];
  if (Array.isArray(result)) return result.filter(isFeature);
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    if (isFeature(r['feature'])) return [r['feature']];
    if (Array.isArray(r['features'])) return r['features'].filter(isFeature);
  }
  return [];
}

type Factory = (...args: unknown[]) => unknown;

interface FactoryCall {
  /** Exported factory name. */
  name: string;
  /** Arguments, as the package's hand-off documents them. */
  args(env: FeatureEnv): unknown[];
}

/**
 * How each package is constructed, in registration order within the package. The lab registers packages
 * in the order of FEATURE_PACKAGES (opaque geometry first, vfx last); `RenderFeature.order` decides the
 * order inside each hook.
 */
const ADAPTERS: Record<FeaturePackage, FactoryCall[]> = {
  terrain: [{ name: 'createTerrainFeature', args: (env) => [env.ctx, () => env.terrain] }],
  vehicle: [
    { name: 'createVesselVisualFeature', args: (env) => [env.ctx] },
    { name: 'createSiteFeature', args: (env) => [env.ctx] },
  ],
  cockpit: [{ name: 'createCockpitFeature', args: (env) => [env.ctx, { navball: env.navball, mfdPainter: env.mfdPainter }] }],
  ocean: [{ name: 'createOceanFeature', args: (env) => [env.ctx] }],
  sky: [{ name: 'createSkyFeature', args: () => [] }],
  atmosphere: [{ name: 'createAtmosphereFeature', args: () => [] }],
  vfx: [{ name: 'createVfxFeature', args: (env) => [env.ctx] }],
};

/** Import the entry points of the wanted packages that exist. */
export async function importPackages(wanted: readonly FeaturePackage[]): Promise<{ modules: Partial<Record<FeaturePackage, Module>>; problems: string[] }> {
  const modules: Partial<Record<FeaturePackage, Module>> = {};
  const problems: string[] = [];
  await Promise.all(
    wanted.map(async (p) => {
      const load = RENDER_MODULES[modulePath(p)];
      if (!load) return;
      try {
        modules[p] = await load();
      } catch (e) {
        problems.push(`${p}: import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return { modules, problems };
}

/** Build the features of the imported packages. */
export function buildFeatures(modules: Partial<Record<FeaturePackage, Module>>, env: FeatureEnv): BuiltFeatures {
  const out: BuiltFeatures = { features: [], loaded: [], handles: {}, problems: [] };
  for (const p of FEATURE_PACKAGES) {
    const mod = modules[p];
    if (!mod) continue;
    let built = 0;
    for (const call of ADAPTERS[p]) {
      const factory = mod[call.name];
      if (typeof factory !== 'function') {
        const creators = Object.keys(mod).filter((k) => k.startsWith('create'));
        out.problems.push(`${p}: export ${call.name} not found (factories exported: ${creators.join(', ') || 'none'})`);
        continue;
      }
      try {
        const result = (factory as Factory)(...call.args(env));
        out.handles[`${p}.${call.name}`] = result;
        const features = featuresOf(result);
        if (features.length === 0) out.problems.push(`${p}: ${call.name} returned no RenderFeature`);
        out.features.push(...features);
        built += features.length;
      } catch (e) {
        out.problems.push(`${p}: ${call.name} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (built > 0) out.loaded.push(p);
  }
  return out;
}

export type CreateSim = (defs: DefLibrary, scenarioId: string, opts: { terrain: TerrainProvider }) => Sim;

/** `createSim` of src/sim (the real simulation), or null when it is not in the tree yet. */
export async function importRealSim(): Promise<CreateSim | null> {
  const load = SIM_MODULES['/src/sim/index.ts'];
  if (!load) return null;
  const mod = await load();
  const create = mod['createSim'];
  return typeof create === 'function' ? (create as CreateSim) : null;
}
