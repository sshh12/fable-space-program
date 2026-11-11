/**
 * Integration lab (core-support): every render package that exists in the tree, together, on the real baked
 * tiles, for the cross-feature checks no single package can run (ARCHITECTURE 10.1-10.4, 17.1).
 *
 *   ?features=all | <list>      packages to load, of terrain, vehicle, cockpit, ocean, sky, atmosphere, vfx
 *                               (default all); a package that is not in the tree is simply absent
 *   &without=<list>             packages to leave out
 *   &planet=0                   no LabPlanet backdrop (it is added when the terrain feature is not loaded)
 *   &sim=real&scenario=<id>     the real Sim of src/sim when it exists (default: FakeSim, ?scene=<FakeScene>)
 *   &sun=az,el&sunsite=body,lat,lon   pin the sun at azimuth / elevation (deg) as seen from a body-fixed point
 * plus every camera / renderer parameter of createLabApp (body=, lat=, lon=, alt=, heading=, pitch=,
 * orbit=, vessel=, fov=, ev=, perf=features, scale=, governor=off, deterministic=1, paused=1).
 *
 * Specs drive the page through window.__lab (the LabApp) and window.__integration (this file's handle).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderFeature } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { installTestApi } from '@/core/testing/testApi';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp } from '@/render/core/lab';
import { createFetchTileSource, createTerrainProvider } from '@/terrain';
import { createMfdPainter, createNavballRenderer } from '@/ui';
import { sunAtSite, withSunOverride, type Site, type SunOverride } from '../render-core/world';
import { availablePackages, buildFeatures, FEATURE_PACKAGES, importPackages, importRealSim, realSimAvailable, type FeaturePackage } from './features';

export interface IntegrationLab {
  app: LabApp;
  /** Packages whose entry point exists in the tree / that are registered in this page. */
  available: FeaturePackage[];
  loaded: FeaturePackage[];
  /** Factories that were missing or threw, features whose init failed: one line each. */
  problems: string[];
  /** What each factory returned, keyed `<package>.<export>` (debug handles of the features). */
  handles: Record<string, unknown>;
  /** 'real' when the Sim of src/sim drives the page. */
  simKind: 'fake' | 'real';
  terrain: TerrainProvider;
  /** Camera on a body: height above the REFERENCE radius (sea level on an ocean body), heading clockwise from north. */
  surface(bodyId: string, latDeg: number, lonDeg: number, alt: number, headingDeg: number, pitchDeg: number): void;
  /** The same with the height measured above the terrain (final data: resolves once the tiles are in). */
  aboveGround(bodyId: string, latDeg: number, lonDeg: number, height: number, headingDeg: number, pitchDeg: number): Promise<number>;
  /** Terrain height above the reference radius at a point, m (final data). */
  groundHeight(bodyId: string, latDeg: number, lonDeg: number): Promise<number>;
  /**
   * Keep the camera `distance` metres from a body's centre at `phaseDeg` from the body -> sun direction
   * (0 = full disc, 90 = terminator in the middle, 180 = new), looking at the centre.
   */
  viewBodyAtPhase(bodyId: string, phaseDeg: number, distance: number, towardsDeg?: number): void;
  /** Stand at a body-fixed point (height above the reference radius) and keep looking at the active vessel. */
  watchVesselFrom(site: Site): void;
  /** Stand at a body-fixed point and look at another one (both heights above the reference radius). */
  lookFromTo(from: Site, to: Site): void;
  /** Pin the sun at azimuth / elevation (deg) as seen from a body-fixed point, or release it with null. */
  setSun(site: Site | null, azDeg?: number, elDeg?: number): void;
  /** Stop following (the camera keeps its last placement). */
  release(): void;
}

declare global {
  interface Window {
    __integration?: IntegrationLab;
  }
}

const query = new URLSearchParams(location.search);

function wantedPackages(): FeaturePackage[] {
  const list = (v: string | null): FeaturePackage[] => (v ?? '').split(',').filter((x): x is FeaturePackage => (FEATURE_PACKAGES as readonly string[]).includes(x));
  const f = query.get('features');
  const base = !f || f === 'all' ? [...FEATURE_PACKAGES] : f === 'none' ? [] : list(f);
  const without = new Set(list(query.get('without')));
  return base.filter((p) => !without.has(p));
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const problems: string[] = [];

  const defs: DefLibrary = await loadDefs(fetchDefSource());
  const terrain = await createTerrainProvider(defs, createFetchTileSource('/tiles'));
  const wanted = wantedPackages();
  const imported = await importPackages(wanted);
  problems.push(...imported.problems);

  // Simulation: the real one when asked for and present, else the FakeSim; the sun can be pinned on either.
  let sunOverride: SunOverride | null = null;
  const sunArg = query.get('sun');
  if (sunArg) {
    const [az, el] = sunArg.split(',').map(Number);
    const [body, lat, lon] = (query.get('sunsite') ?? '').split(',');
    const first = Object.values(defs.sites)[0];
    const site: Site = body ? { bodyId: body, latDeg: Number(lat), lonDeg: Number(lon), alt: 0 } : { bodyId: first?.bodyId ?? defs.rootBodyId, latDeg: first?.location.latDeg ?? 0, lonDeg: first?.location.lonDeg ?? 0, alt: 0 };
    sunOverride = sunAtSite(site, az ?? 120, el ?? 40);
  }
  let simKind: 'fake' | 'real' = 'fake';
  let inner: Sim;
  const createSim = query.get('sim') === 'real' ? await importRealSim() : null;
  if (query.get('sim') === 'real' && !createSim) problems.push(`sim: the real Sim was asked for but ${realSimAvailable() ? 'src/sim/index.ts does not export createSim' : 'src/sim/index.ts is not in the tree'}; using the FakeSim`);
  if (createSim) {
    inner = createSim(defs, query.get('scenario') ?? Object.keys(defs.scenarios)[0] ?? '', { terrain });
    simKind = 'real';
  } else {
    inner = createFakeSim(defs, { scene: (query.get('scene') as FakeScene | null) ?? 'lowOrbit' });
  }
  const sim = withSunOverride(inner, () => sunOverride);

  // The LabPlanet stands in for the terrain when that package is not loaded.
  const backdrop: RenderFeature[] = [];
  if (!imported.modules.terrain && query.get('planet') !== '0') backdrop.push(createLabPlanetFeature({ defaultMap: 'tileset' }));

  const app = await createLabApp({ canvas, name: 'integration', defs, sim, features: backdrop, autoReady: false });
  const ctx = app.renderer.context;

  // The navball texture the cockpit instrument shows (the HUD renders it in the app).
  const navball = createNavballRenderer(app.gpu, { perf: ctx.perf });
  ctx.resources.publish('ui.navball', navball.view);

  const built = buildFeatures(imported.modules, { defs, sim, ctx, gpu: app.gpu, terrain, navball, mfdPainter: createMfdPainter(), query });
  problems.push(...built.problems);
  const loaded: FeaturePackage[] = [];
  for (const f of built.features) {
    try {
      await app.renderer.addFeature(f);
    } catch (e) {
      problems.push(`feature ${f.id}: init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const ids = new Set(app.renderer.featureOrder());
  for (const p of built.loaded) if (built.features.some((f) => ids.has(f.id))) loaded.push(p);

  // ----------------------------------------------------------------------------------------- camera
  let follow: ((snapshot: SimSnapshot) => void) | null = null;
  const bodyOf = (snapshot: SimSnapshot, id: string): SimSnapshot['bodies'][number] => {
    const b = snapshot.bodies.find((x) => x.id === id);
    if (!b) throw new Error(`integration lab: unknown body "${id}"`);
    return b;
  };
  const pointRoot = (snapshot: SimSnapshot, s: Site): { pos: Vec3; up: Vec3 } => {
    const b = bodyOf(snapshot, s.bodyId);
    const up = quat.rotate(b.qFixedToRoot, latLonToDir(s.latDeg * DEG, s.lonDeg * DEG));
    return { pos: v3.addScaled(b.rRoot, up, defs.bodies[s.bodyId]!.radius + s.alt), up };
  };
  const place = (fn: ((snapshot: SimSnapshot) => void) | null): void => {
    follow = fn;
    fn?.(app.snapshot());
  };
  const groundHeight = async (bodyId: string, latDeg: number, lonDeg: number): Promise<number> => {
    const dir = latLonToDir(latDeg * DEG, lonDeg * DEG);
    await terrain.ensureLoaded(bodyId, dir, 50, 'integration-lab');
    return terrain.heightAt(bodyId, dir);
  };

  app.onFrame((snapshot) => {
    follow?.(snapshot);
    const encoder = app.gpu.device.createCommandEncoder({ label: 'integration.navball' });
    navball.render(encoder, snapshot);
    app.gpu.device.queue.submit([encoder.finish()]);
  });

  const lab: IntegrationLab = {
    app,
    available: availablePackages(),
    loaded,
    problems,
    handles: built.handles,
    simKind,
    terrain,
    surface(bodyId, latDeg, lonDeg, alt, headingDeg, pitchDeg) {
      follow = null;
      app.camera.spec = { type: 'surface', bodyId, latDeg, lonDeg, alt, headingDeg, pitchDeg };
    },
    async aboveGround(bodyId, latDeg, lonDeg, height, headingDeg, pitchDeg) {
      const ground = await groundHeight(bodyId, latDeg, lonDeg);
      lab.surface(bodyId, latDeg, lonDeg, ground + height, headingDeg, pitchDeg);
      return ground;
    },
    groundHeight,
    viewBodyAtPhase(bodyId, phaseDeg, distance, towardsDeg = 0) {
      place((snapshot) => {
        const b = bodyOf(snapshot, bodyId);
        const side = quat.rotate(quat.fromAxisAngle(b.sunDir, towardsDeg * DEG), v3.anyOrthogonal(b.sunDir));
        const axis = v3.cross(b.sunDir, side);
        const out = quat.rotate(quat.fromAxisAngle(axis, phaseDeg * DEG), b.sunDir);
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(b.rRoot, out, distance), qViewToRoot: lookRotation(v3.neg(out), axis) };
      });
    },
    watchVesselFrom(site) {
      place((snapshot) => {
        const { pos, up } = pointRoot(snapshot, site);
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
        if (!v) return;
        app.camera.spec = { type: 'free', positionRoot: pos, qViewToRoot: lookRotation(v3.sub(v.rRoot, pos), up) };
      });
    },
    lookFromTo(from, to) {
      place((snapshot) => {
        const a = pointRoot(snapshot, from);
        const b = pointRoot(snapshot, to);
        app.camera.spec = { type: 'free', positionRoot: a.pos, qViewToRoot: lookRotation(v3.sub(b.pos, a.pos), a.up) };
      });
    },
    setSun(site, azDeg = 120, elDeg = 40) {
      sunOverride = site ? sunAtSite(site, azDeg, elDeg) : null;
    },
    release() {
      follow = null;
    },
  };
  window.__integration = lab;

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      const c = app.cameraState();
      info.textContent =
        `integration lab   sim ${simKind}   features ${loaded.join(', ') || 'none'}${imported.modules.terrain ? '' : '   (LabPlanet backdrop)'}\n` +
        `not in the tree: ${FEATURE_PACKAGES.filter((x) => !lab.available.includes(x)).join(', ') || 'none'}   problems ${problems.length}\n` +
        `gpu ${p.gpu.p50.toFixed(2)} ms (p99 ${p.gpu.p99.toFixed(2)})   cpu ${p.cpu.p50.toFixed(2)} ms   quality ${p.qualityScale.toFixed(2)}   scale ${p.renderScale.toFixed(2)}   EV100 ${e.ev100.toFixed(2)}\n` +
        `camera ${c.kind}  fov ${(c.fovY / DEG).toFixed(0)} deg`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  const message = `integration lab boot: ${err instanceof Error ? err.message : String(err)}`;
  if (window.__test) {
    window.__test.errors.push(message);
    return;
  }
  // Failed before the lab app existed (definitions or tile manifests): report through a test API of our own.
  const api = installTestApi({ kind: 'lab', name: 'integration', scenarioId: 'none' });
  api.reportError(message);
  api.markReady(false);
});
