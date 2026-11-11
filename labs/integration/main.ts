/**
 * Integration lab (core-support): every render package that exists in the tree, together, on the real baked
 * tiles, for the cross-feature checks no single package can run (ARCHITECTURE 10.1-10.4, 17.1).
 *
 *   ?features=all | <list>      packages to load, of terrain, vehicle, cockpit, ocean, sky, atmosphere, vfx
 *                               (default all); a package that is not in the tree is simply absent
 *   &without=<list>             packages to leave out
 *   &planet=0                   no LabPlanet backdrop (it is added when the terrain feature is not loaded)
 *   &sim=real&scenario=<id>     the real Sim of src/sim when it exists (default: FakeSim, ?scene=<FakeScene>)
 *   &vehicle=<id>&stage=<n>     FakeSim: the real parts of this vehicle after n fired stages (default: the first
 *                               vehicle, staged as the scene needs; stage=none = the FakeSim's placeholder parts)
 *   &at=lat,lon                 FakeSim: stand the 'pad' and 'ascent' scenes here instead of at the site
 *   &throttle=<0..1>            FakeSim: throttle held from the start (engines of the fired stages burn)
 *   &sun=az,el&sunsite=body,lat,lon   pin the sun at azimuth / elevation (deg) as seen from a body-fixed point
 *   &noshadow=<list>            packages whose features do not cast sun shadows (A/B for the shadow checks)
 *   &probe=casters              log the cascades handed to drawShadow (render-core lab probe)
 *   &ballast=1                  add the render-core lab's ballast pass (feature lab-heavy, off until
 *                               setBallast): perf runs keep the GPU as busy as the full game's frame
 * plus every camera / renderer parameter of createLabApp (body=, lat=, lon=, alt=, heading=, pitch=,
 * orbit=, vessel=, fov=, ev=, perf=features, scale=, governor=off, deterministic=1, paused=1).
 *
 * Specs drive the page through window.__lab (the LabApp) and window.__integration (this file's handle).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import { DEG, mat4, quat, v3, type Vec3 } from '@/core/math';
import { coreOf, type SceneBindings, type Tracked } from '@/render/core';
import { installTestApi } from '@/core/testing/testApi';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp } from '@/render/core/lab';
import { createFetchTileSource, createTerrainProvider } from '@/terrain';
import { createMfdPainter, createNavballRenderer } from '@/ui';
import { createProbes } from '../render-core/probes';
import { sunAtSite, withSunOverride, type Site, type SunOverride } from '../render-core/world';
import { availablePackages, buildFeatures, FEATURE_PACKAGES, importPackages, importRealSim, realSimAvailable, realVesselParts, type FeaturePackage } from './features';

export interface IntegrationLab {
  app: LabApp;
  /** Packages whose entry point exists in the tree / that are registered in this page. */
  available: FeaturePackage[];
  loaded: FeaturePackage[];
  /** Factories that were missing or threw, features that were switched off: one line each. */
  problems: string[];
  /** Features switched off because they reported errors while starting up, with those errors. */
  quarantined: { pkg: FeaturePackage; featureId: string; errors: string[] }[];
  /** What each factory returned, keyed `<package>.<export>` (debug handles of the features). */
  handles: Record<string, unknown>;
  /** Package of each registered wave-2 feature id. */
  packageOf: Record<string, FeaturePackage>;
  /** Iterations of the ballast pass per pixel (?ballast=1; 0 = off). Its GPU time is pass 'lab-heavy.burn'. */
  setBallast(iterations: number): void;
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
  /**
   * Stay `distance` metres from the active vessel, off to the side of the sun line (along the axis the
   * view turns about, so the vessel never enters the frame and never covers the sun), and look at a
   * direction `offsetDeg` away from the sun (0 = straight at it), turning about the vessel's orbit normal.
   */
  lookNearSun(offsetDeg: number, distance?: number): void;
  /**
   * Render-target pixel of a body-fixed point (height above the reference radius) in the last frame, its
   * distance from the eye and its depth along the view axis (m); null when behind the camera.
   */
  project(bodyId: string, latDeg: number, lonDeg: number, alt: number): { x: number; y: number; distance: number; viewZ: number } | null;
  /** The same for the active vessel. */
  projectVessel(): { x: number; y: number; distance: number; viewZ: number } | null;
  /**
   * Show a G-buffer target instead of the lit scene (a fullscreen pass of the lab at the end of
   * drawTransparent writes it to the HDR target unexposed): 'albedo' = linear rgb, 'material' = roughness,
   * material id, parameter. null = the normal image. Read it back with renderer.readHdrPixels('hdr').
   */
  showGBuffer(which: 'albedo' | 'material' | null): void;
  /** Cascades handed to drawShadow since the last clear (?probe=casters). */
  cascadeLog(): { frame: number; index: number; everyFrame: boolean; fit: string; anchor: string; texelSize: number }[];
  clearCascadeLog(): void;
  /**
   * Stand on the line from the active vessel to a body-fixed point, `distance` metres from the vessel, and
   * look at the vessel: two calls with different distances are two views along ONE line of sight.
   */
  watchVesselAlong(site: Site, distance: number): void;
  /** Ride `below` metres under the active vessel (towards its body) and keep looking at a body-fixed point. */
  watchSiteFromVessel(site: Site, below?: number): void;
  /**
   * Sit in the seat the vehicle definition names for the cockpit camera (interior view), looking `yawDeg`
   * to the right and `pitchDeg` up from the seat's own look direction. False when the active vessel has no
   * such part or seat (placeholder parts, a stage without the capsule).
   */
  sitInCockpit(yawDeg?: number, pitchDeg?: number): boolean;
  /**
   * Switch the features of a package off or on in the running page (their hooks are skipped; what they
   * published keeps its last content, so use it for packages that only draw: vfx, vehicle, cockpit).
   */
  setEnabled(pkg: FeaturePackage, on: boolean): void;
  /** Stop following (the camera keeps its last placement). */
  release(): void;
}

/** Stages of the vehicle already fired in each FakeSim scene (the stack that flies that part of the mission). */
const SCENE_STAGES: Record<FakeScene, number> = { pad: 0, ascent: 1, lowOrbit: 4, translunar: 5, lunarOrbit: 5, lunarSurface: 6, reentry: 8, chutes: 10 };

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

const HOOKS = ['prepare', 'compute', 'drawShadow', 'drawGBuffer', 'drawWater', 'drawBackground', 'compositeAtmosphere', 'preTransparent', 'drawTransparent', 'drawOverlay'] as const;

/**
 * The same feature behind a switch: it has exactly the hooks of `inner` (the core decides from their
 * presence which passes exist), forwards them while enabled, and switches itself off, telling `onThrow`,
 * when one of them throws.
 */
function guardFeature(inner: RenderFeature, onThrow: (message: string) => void, castShadows = true): { feature: RenderFeature; disable(): void; setEnabled(on: boolean): void } {
  let enabled = true;
  let broken = false;
  const feature: Record<string, unknown> = {
    id: inner.id,
    init: (c: RenderContext) => inner.init(c),
    isIdle: () => !enabled || (inner.isIdle?.() ?? true),
    dispose: () => inner.dispose?.(),
  };
  if (inner.order !== undefined) feature['order'] = inner.order;
  if (inner.requires !== undefined) feature['requires'] = inner.requires;
  for (const hook of HOOKS) {
    const fn = inner[hook] as ((...args: unknown[]) => void) | undefined;
    if (typeof fn !== 'function' || (hook === 'drawShadow' && !castShadows)) continue;
    feature[hook] = (...args: unknown[]): void => {
      if (!enabled) return;
      try {
        fn.apply(inner, args);
      } catch (e) {
        enabled = false;
        broken = true;
        onThrow(`${hook} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
  }
  return {
    feature: feature as unknown as RenderFeature,
    disable() {
      enabled = false;
      broken = true;
    },
    setEnabled(on) {
      enabled = on && !broken;
    },
  };
}

/** Fullscreen pass (order last in drawTransparent) that writes a G-buffer target to the HDR target when asked. */
function createGBufferView(): { feature: RenderFeature; which: 'albedo' | 'material' | null } {
  let ctx: RenderContext;
  let bindings: SceneBindings;
  let layout: GPUBindGroupLayout;
  let group: GPUBindGroup | null = null;
  let version = -1;
  const pipelines: Partial<Record<'albedo' | 'material', Tracked<GPURenderPipeline>>> = {};
  const view: { feature: RenderFeature; which: 'albedo' | 'material' | null } = {
    which: null,
    feature: {
      id: 'lab-gbuffer-view',
      order: 1e6,
      init(c) {
        ctx = c;
        const core = coreOf(c);
        bindings = core.createSceneBindings(1, 0, ['gbuffer']);
        layout = c.device.createBindGroupLayout({ entries: bindings.layoutEntries });
        const make = (label: string, value: string): Tracked<GPURenderPipeline> =>
          core.fullscreenPipeline({
            label: `lab-gbuffer-view.${label}`,
            layouts: [layout],
            fragment: `${bindings.wgsl}
              @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { let px = vec2i(in.position.xy); return vec4f(${value}, 1.0); }`,
            targets: [{ format: RENDER_FORMATS.hdr }],
            depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
          });
        pipelines.albedo = make('albedo', 'textureLoad(gbufferAlbedoTex, px, 0).rgb');
        pipelines.material = make('material', 'vec3f(textureLoad(gbufferMaterialTex, px, 0).r, textureLoad(gbufferMaterialTex, px, 0).b * 255.0, textureLoad(gbufferMaterialTex, px, 0).a)');
      },
      drawTransparent(_frame, pass) {
        if (!view.which) return;
        if (!group || bindings.version() !== version) {
          version = bindings.version();
          group = ctx.device.createBindGroup({ layout, entries: bindings.entries() });
        }
        pass.setPipeline(pipelines[view.which]!.get());
        pass.setBindGroup(1, group);
        pass.draw(3);
      },
    },
  };
  return view;
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
    const scene = (query.get('scene') as FakeScene | null) ?? 'lowOrbit';
    const stage = query.get('stage');
    const real = stage === 'none' ? null : await realVesselParts(defs, query.get('vehicle') ?? Object.keys(defs.vehicles)[0] ?? '', stage !== null ? Number(stage) : SCENE_STAGES[scene], problems);
    const at = query.get('at')?.split(',').map(Number);
    inner = createFakeSim(defs, {
      scene,
      ...(real ? { parts: real.parts, stageLabels: real.stageLabels } : {}),
      ...(at && at.length === 2 && at.every(Number.isFinite) ? { location: { latDeg: at[0]!, lonDeg: at[1]! } } : {}),
    });
    const throttle = Number(query.get('throttle') ?? 0);
    if (throttle > 0) inner.setControls({ ...NEUTRAL_CONTROLS, translate: v3.zero(), throttle: Math.min(1, throttle) });
  }
  const sim = withSunOverride(inner, () => sunOverride);

  const app = await createLabApp({ canvas, name: 'integration', defs, sim, features: [], autoReady: false });
  const ctx = app.renderer.context;

  // The navball texture the cockpit instrument shows (the HUD renders it in the app).
  // (No perf recorder: it is encoded outside the frame graph here; its budget line is proven by hud.perf.spec.)
  const navball = createNavballRenderer(app.gpu);
  ctx.resources.publish('ui.navball', navball.view);

  const built = buildFeatures(imported.modules, { defs, sim, ctx, gpu: app.gpu, terrain, navball, mfdPainter: createMfdPainter(), query });
  problems.push(...built.problems);
  // Ballast for perf runs: with only some features present the GPU has too little to do and clocks down,
  // which inflates every pass time (docs/handoff/render-core.md 4.1).
  const firstSite = Object.values(defs.sites)[0];
  const probeNames = [query.get('ballast') === '1' ? 'heavy' : '', (query.get('probe') ?? '').split(',').includes('casters') ? 'casters' : ''].filter(Boolean);
  const ballast = probeNames.length > 0 ? createProbes(new URLSearchParams(`probe=${probeNames.join(',')}&heavy=0`), { bodyId: firstSite?.bodyId ?? defs.rootBodyId, latDeg: firstSite?.location.latDeg ?? 0, lonDeg: firstSite?.location.lonDeg ?? 0, alt: 0 }, defs, app.snapshot()) : null;
  if (ballast) {
    ballast.attach(app);
    for (const f of ballast.features) await app.renderer.addFeature(f);
  }

  // Register the features one at a time and watch the error list while each one initialises, compiles its
  // shaders and renders its first frames. A feature that reports an error (or throws in a hook) is switched
  // off and its errors move to `problems`: a package that is still being written must not take the page,
  // and the checks of the other packages, down with it.
  const errors = app.testApi.api.errors;
  const noShadow = new Set((query.get('noshadow') ?? '').split(','));
  const quarantined: IntegrationLab['quarantined'] = [];
  const quarantine = (featureId: string, messages: string[]): void => {
    const pkg = built.packageOf[featureId]!;
    quarantined.push({ pkg, featureId, errors: messages });
    problems.push(`${pkg}: feature ${featureId} was switched off after ${messages.length} error(s): ${messages[0]}`);
  };
  const compiled = async (): Promise<void> => {
    for (let i = 0; i < 200 && app.renderer.core.shaders.pendingCompilations() > 0; i++) await app.testApi.api.waitFrames(3);
  };
  const guards = new Map<string, { disable(): void; setEnabled(on: boolean): void }>();
  for (const inner of built.features) {
    const before = errors.length;
    const g = guardFeature(inner, (message) => quarantine(inner.id, [message]), !noShadow.has(built.packageOf[inner.id]!));
    guards.set(inner.id, g);
    try {
      await app.renderer.addFeature(g.feature);
    } catch (e) {
      g.disable();
      quarantine(inner.id, [`init failed: ${e instanceof Error ? e.message : String(e)}`]);
    }
    await compiled();
    await app.testApi.api.waitFrames(4);
    if (errors.length > before) {
      g.disable();
      quarantine(inner.id, errors.splice(before));
    }
  }
  const loaded = built.loaded.filter((p) => !quarantined.some((q) => q.pkg === p));
  // The LabPlanet stands in for the terrain when that package is absent or was switched off.
  const backdrop = !loaded.includes('terrain') && query.get('planet') !== '0';
  if (backdrop) await app.renderer.addFeature(createLabPlanetFeature({ defaultMap: 'tileset' }));
  // Errors that arrive later (a feature that validates its data when its body comes into view, a pipeline
  // compiled on first use) are attributed by name: a message that names a feature or its package switches
  // that feature off and moves to `problems`; anything else stays in window.__test.errors and fails the spec.
  // GPU errors of the frames a feature encoded before it was switched off arrive a few frames later and
  // name nothing ("invalid due to a previous error"): for GRACE_FRAMES after a feature is switched off they
  // are put down to it.
  const GRACE_FRAMES = 30;
  let seenErrors = errors.length;
  let frames = 0;
  let grace: { featureId: string; until: number } | null = quarantined.length > 0 ? { featureId: quarantined[quarantined.length - 1]!.featureId, until: GRACE_FRAMES } : null;
  const watchErrors = (): void => {
    frames++;
    if (errors.length === seenErrors) return;
    for (let i = errors.length - 1; i >= seenErrors; i--) {
      const message = errors[i]!;
      const named = built.features.find((f) => {
        const names = [f.id, built.packageOf[f.id]!];
        return names.some((n) => new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`, 'i').test(message));
      });
      const owner = named ?? (grace && frames <= grace.until ? built.features.find((f) => f.id === grace!.featureId) : undefined);
      if (!owner) continue;
      if (named) grace = { featureId: named.id, until: frames + GRACE_FRAMES };
      errors.splice(i, 1);
      guards.get(owner.id)?.disable();
      const known = quarantined.find((q) => q.featureId === owner.id);
      if (known) known.errors.push(message);
      else quarantine(owner.id, [message]);
      const at = loaded.indexOf(built.packageOf[owner.id]!);
      if (at >= 0) loaded.splice(at, 1);
    }
    seenErrors = errors.length;
  };

  // A lab feature that can replace the lit image by a G-buffer target (read back by the image-decode check).
  const gbufferView = createGBufferView();
  await app.renderer.addFeature(gbufferView.feature);

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
    watchErrors();
    follow?.(snapshot);
    const encoder = app.gpu.device.createCommandEncoder({ label: 'integration.navball' });
    navball.render(encoder, snapshot);
    app.gpu.device.queue.submit([encoder.finish()]);
  });

  /** Render-target pixel of a point given relative to the camera (ROOT axes). */
  const toPixel = (relCam: Vec3): { x: number; y: number; distance: number; viewZ: number } | null => {
    const f = app.renderer.frameContext!;
    const c = mat4.transformPoint(mat4.mul(f.projUnjittered, f.view), relCam);
    if (c.w <= 0) return null;
    return { x: (0.5 + (0.5 * c.x) / c.w) * f.renderSize[0], y: (0.5 - (0.5 * c.y) / c.w) * f.renderSize[1], distance: v3.len(relCam), viewZ: c.w };
  };

  const lab: IntegrationLab = {
    app,
    available: availablePackages(),
    loaded,
    problems,
    quarantined,
    handles: built.handles,
    packageOf: built.packageOf,
    setBallast(iterations) {
      ballast?.setHeavy(iterations);
    },
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
    lookNearSun(offsetDeg, distance = 60) {
      place((snapshot) => {
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
        if (!v) return;
        const sun = bodyOf(snapshot, v.bodyId).sunDir;
        let axis = v3.cross(v.r, v.v);
        axis = v3.lenSq(axis) > 0 ? v3.normalize(v3.reject(axis, sun)) : v3.anyOrthogonal(sun);
        const dir = quat.rotate(quat.fromAxisAngle(axis, offsetDeg * DEG), sun);
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(v.rRoot, axis, distance), qViewToRoot: lookRotation(dir, axis) };
      });
    },
    project(bodyId, latDeg, lonDeg, alt) {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const b = f.bodyPose(bodyId);
      const p = v3.add(b.centerRelCam, quat.rotate(b.qFixedToRoot, v3.scale(latLonToDir(latDeg * DEG, lonDeg * DEG), defs.bodies[bodyId]!.radius + alt)));
      return toPixel(p);
    },
    projectVessel() {
      const f = app.renderer.frameContext;
      const s = app.snapshot();
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      if (!f || !v) return null;
      return toPixel(v3.sub(v.rRoot, app.cameraState().positionRoot));
    },
    showGBuffer(which) {
      gbufferView.which = which;
    },
    watchVesselAlong(site, distance) {
      place((snapshot) => {
        const { pos, up } = pointRoot(snapshot, site);
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
        if (!v) return;
        const away = v3.normalize(v3.sub(pos, v.rRoot));
        app.camera.spec = { type: 'free', positionRoot: v3.addScaled(v.rRoot, away, distance), qViewToRoot: lookRotation(v3.neg(away), up) };
      });
    },
    watchSiteFromVessel(site, below = 30) {
      place((snapshot) => {
        const { pos } = pointRoot(snapshot, site);
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
        if (!v) return;
        const eye = v3.addScaled(v.rRoot, v3.normalize(v.r), -below);
        app.camera.spec = { type: 'free', positionRoot: eye, qViewToRoot: lookRotation(v3.sub(pos, eye), v3.lenSq(v.v) > 0 ? v.v : v3.anyOrthogonal(v.r)) };
      });
    },
    sitInCockpit(yawDeg = 0, pitchDeg = 0) {
      const find = (snapshot: SimSnapshot): { positionRoot: Vec3; qViewToRoot: ReturnType<typeof lookRotation> } | null => {
        const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
        const camera = Object.values(defs.vehicles).find((d) => v?.parts.some((p) => p.instanceId === d.cameras.cockpit.part))?.cameras.cockpit;
        const part = v?.parts.find((p) => p.instanceId === camera?.part);
        if (!v || !camera || !part) return null;
        const seats = defs.parts[part.def]?.modules.flatMap((m) => (m.type === 'command' ? m.seats : []));
        const seat = seats?.find((s) => s.id === camera.seat);
        if (!seat) return null;
        const L = v3.normalize(v3.fromTuple(seat.lookDir));
        const U = v3.normalize(v3.reject(v3.fromTuple(seat.upDir), L));
        const qLook = quat.mul(quat.fromAxisAngle(v3.unitY(), -yawDeg * DEG), quat.fromAxisAngle(v3.unitX(), pitchDeg * DEG));
        return {
          positionRoot: v3.add(v.rRoot, quat.rotate(v.q, v3.add(part.localPos, quat.rotate(part.localRot, v3.fromTuple(seat.pos))))),
          qViewToRoot: quat.normalize(quat.mul(quat.mul(v.q, part.localRot), quat.mul(lookRotation(L, U), qLook))),
        };
      };
      if (!find(app.snapshot())) return false;
      app.camera.settings.kind = 'interior';
      place((snapshot) => {
        const at = find(snapshot);
        if (at) app.camera.spec = { type: 'free', ...at };
      });
      return true;
    },
    setEnabled(pkg, on) {
      for (const f of built.features) if (built.packageOf[f.id] === pkg) guards.get(f.id)?.setEnabled(on);
    },
    cascadeLog: () => ballast?.cascadeLog() ?? [],
    clearCascadeLog: () => ballast?.clearCascadeLog(),
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
        `integration lab   sim ${simKind}   features ${loaded.join(', ') || 'none'}${backdrop ? '   (LabPlanet backdrop)' : ''}\n` +
        `not in the tree: ${FEATURE_PACKAGES.filter((x) => !lab.available.includes(x)).join(', ') || 'none'}   switched off: ${quarantined.map((q) => q.featureId).join(', ') || 'none'}   problems ${problems.length}\n` +
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
