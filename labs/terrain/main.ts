/**
 * Terrain lab: the terrain feature alone (plus the lab stand-ins of labKit.ts) on the FakeSim.
 *
 * Query string, in addition to the lab app's own (scene=, body= / lat= / lon= / alt= / heading= / pitch=,
 * orbit= / target=, fov=, ev=, perf=features, scale=, governor=off, deterministic=1, paused=1):
 *   agl=<m>                 with body=...: place the eye this far above the GROUND (alt= is above the datum)
 *   sun=<az>,<el>           sun azimuth / elevation (deg) at the camera's site (body= or target=site:)
 *   subsolar=<lat>,<lon>    sub-solar point on the camera's body (deg, body-fixed)
 *   sky=<lux>               stand-in sky illuminance at zenith sun on bodies with an atmosphere (default 16000; 0 = none)
 *   magenta=1               magenta behind the body silhouette (holes and cracks); silhouette=<m> radius offset
 *   nearfield=<start>,<end> publish 'ocean.nearField' for the camera's body
 *   workers=<n>             tile workers (default 6 in the lab)   delay=<ms> artificial streaming delay
 *   rocks=0                 no rock field                          ballast=<iterations> GPU ballast pass
 *   hud=0                   no text overlay
 *   p.<body>.<key>=<n>      override a tunable of data/defs/render/<body>.surface.json (A/B comparisons)
 *
 * window.__terrain is the handle for specs.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { Sim } from '@/core/contracts/sim';
import { dirToLatLon, latLonToDir } from '@/core/geo/cubeSphere';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { DEG, quat, v3 } from '@/core/math';
import { createLabApp, type LabApp } from '@/render/core/lab';
import { createTerrainFeature, type TerrainDebug, type TerrainFeature } from '@/render/terrain';
import { createFetchTileSource, createTerrainProvider, type TerrainAuthority } from '@/terrain';
import { createBallast, createMagentaBackground, createNearFieldPublisher, createSkyStandIn, withSun, type SunSpec } from './labKit';

export interface TerrainLab {
  debug: TerrainDebug;
  provider: TerrainAuthority;
  /** Ground height (m above the reference radius) of the collision surface at a point; loads the data first. */
  groundHeight(bodyId: string, latDeg: number, lonDeg: number): Promise<number>;
  /** Place the camera on a body: `height` above the ground (agl = true) or above the datum. */
  placeCamera(bodyId: string, latDeg: number, lonDeg: number, height: number, headingDeg: number, pitchDeg: number, agl?: boolean): Promise<void>;
  setSun(spec: SunSpec): void;
  setNearField(v: { bodyId: string; fadeStart: number; fadeEnd: number } | null): void;
  setBallast(iterations: number): void;
  ballast(): number;
  /** Copy the canvas (as presented this frame) into a 2-D canvas of the given size and return its RGBA bytes. Call right after renderFrame(). */
  grab(width: number, height: number): Uint8ClampedArray;
}

declare global {
  interface Window {
    __terrain?: TerrainLab;
  }
}

const query = new URLSearchParams(location.search);
const pair = (key: string): [number, number] | null => {
  const v = query.get(key);
  if (!v) return null;
  const a = v.split(',').map(Number);
  return a.length === 2 && a.every(Number.isFinite) ? [a[0]!, a[1]!] : null;
};

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let sun: SunSpec = null;
  let provider!: TerrainAuthority;
  let terrain!: TerrainFeature;
  const ballast = createBallast(Number(query.get('ballast') ?? 0));
  let nearField!: ReturnType<typeof createNearFieldPublisher>;
  let app!: LabApp;

  app = await createLabApp({
    canvas,
    name: 'terrain',
    autoReady: false,
    sim: (defs: DefLibrary): Sim => withSun(createFakeSim(defs, { scene: (query.get('scene') as FakeScene | null) ?? 'lowOrbit' }), () => sun),
    features: (defs) => {
      nearField = createNearFieldPublisher(defs, () => app.renderer.resources);
      const list = [createSkyStandIn(Number(query.get('sky') ?? 16000)), ballast.feature, nearField.feature];
      if (query.get('magenta') === '1') {
        const offset = query.has('silhouette') ? Number(query.get('silhouette')) : null;
        list.push(createMagentaBackground(offset === null ? {} : Object.fromEntries(Object.keys(defs.bodies).map((id) => [id, offset]))));
      }
      return list;
    },
  });
  const ctx = app.renderer.context;
  for (const [key, value] of query) {
    const m = /^p\.([\w-]+)\.(\w+)$/.exec(key);
    const surface = m ? ctx.defs.bodies[m[1]!]?.render.surface : undefined;
    if (m && surface) surface.params[m[2]!] = Number(value);
  }
  terrain = createTerrainFeature(
    ctx,
    async () => {
      provider = await createTerrainProvider(ctx.defs, createFetchTileSource(ctx.tilesUrl));
      return provider;
    },
    { streamer: { workers: Number(query.get('workers') ?? 6) }, rocks: query.get('rocks') !== '0' },
  );
  await app.renderer.addFeature(terrain);
  if (query.has('delay')) terrain.debug.setStreamDelay(Number(query.get('delay')));

  const cameraBody = (): string => {
    const s = app.camera.spec;
    if (s.type === 'surface') return s.bodyId;
    if (s.type === 'orbit' && 'bodyId' in s.target) return s.target.bodyId;
    const snap = app.snapshot();
    return snap.vessels.find((v) => v.id === snap.activeVesselId)?.bodyId ?? app.defs.rootBodyId;
  };

  const lab: TerrainLab = {
    debug: terrain.debug,
    provider,
    async groundHeight(bodyId, latDeg, lonDeg) {
      const dir = latLonToDir(latDeg * DEG, lonDeg * DEG);
      await provider.ensureLoaded(bodyId, dir, 300, 'lab:camera');
      return provider.heightAt(bodyId, dir);
    },
    async placeCamera(bodyId, latDeg, lonDeg, height, headingDeg, pitchDeg, agl = true) {
      const ground = agl ? await lab.groundHeight(bodyId, latDeg, lonDeg) : 0;
      app.camera.spec = { type: 'surface', bodyId, latDeg, lonDeg, alt: ground + height, headingDeg, pitchDeg };
    },
    setSun(spec) {
      sun = spec;
    },
    setNearField: (v) => nearField.set(v),
    setBallast: (n) => ballast.set(n),
    ballast: () => ballast.get(),
    grab: (() => {
      let scratch: HTMLCanvasElement | null = null;
      return (width: number, height: number): Uint8ClampedArray => {
        if (!scratch || scratch.width !== width || scratch.height !== height) {
          scratch = document.createElement('canvas');
          scratch.width = width;
          scratch.height = height;
        }
        const c2d = scratch.getContext('2d', { willReadFrequently: true })!;
        c2d.drawImage(canvas, 0, 0, width, height);
        return c2d.getImageData(0, 0, width, height).data;
      };
    })(),
  };
  window.__terrain = lab;

  // Camera and sun from the query string.
  const spec = app.camera.spec;
  if (spec.type === 'surface' && query.has('agl')) await lab.placeCamera(spec.bodyId, spec.latDeg, spec.lonDeg, Number(query.get('agl')), spec.headingDeg, spec.pitchDeg);
  const sunAzEl = pair('sun');
  const subsolar = pair('subsolar');
  if (sunAzEl) {
    const s = app.camera.spec;
    let site: { bodyId: string; latDeg: number; lonDeg: number } | null = null;
    if (s.type === 'surface') site = { bodyId: s.bodyId, latDeg: s.latDeg, lonDeg: s.lonDeg };
    else if (s.type === 'orbit' && 'latDeg' in s.target) site = { bodyId: s.target.bodyId, latDeg: s.target.latDeg, lonDeg: s.target.lonDeg };
    else {
      // Under the camera: its sub-point on the body it looks at.
      const bodyId = cameraBody();
      const b = app.snapshot().bodies.find((x) => x.id === bodyId)!;
      const ll = dirToLatLon(quat.rotateInv(b.qFixedToRoot, v3.sub(app.cameraState().positionRoot, b.rRoot)));
      site = { bodyId, latDeg: ll.lat / DEG, lonDeg: ll.lon / DEG };
    }
    sun = { kind: 'site', ...site, azDeg: sunAzEl[0], elDeg: sunAzEl[1] };
  } else if (subsolar) {
    sun = { kind: 'subsolar', bodyId: cameraBody(), latDeg: subsolar[0], lonDeg: subsolar[1] };
  }
  const nf = pair('nearfield');
  if (nf) nearField.set({ bodyId: cameraBody(), fadeStart: nf[0], fadeEnd: nf[1] });

  if (query.get('hud') !== '0') {
    app.onFrame(() => {
      const st = terrain.debug.stats();
      const lines = Object.entries(st.bodies).map(
        ([id, b]) => `${id}: ${b.visible}/${b.selected} tiles  L${b.deepestLevel}  water ${b.waterTiles}  casters ${b.casters}  cap ${b.cap.toFixed(1)}  v ${b.groundSpeed.toFixed(0)} m/s  fading ${b.fading}`,
      );
      const s = st.stream;
      info.textContent =
        `${lines.join('\n')}\n` +
        `queue ${s.queued}  loading ${s.loading}  uploading ${s.uploading}  ready ${s.ready}  free ${s.freeTileLayers}/${s.freeImageLayers}/${s.freeNightLayers}\n` +
        `uploaded ${s.uploadedTotal}  evicted ${s.evictedTotal}  cancelled ${s.cancelledTotal}  bake ${s.bakeMs.toFixed(1)} ms  image ${s.imageMs.toFixed(1)} ms\n` +
        `select ${st.selectMs.toFixed(2)} ms  records ${st.records}  rocks ${st.rocks.instances}`;
    });
  }
  await app.testApi.api.waitFrames(2);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((e: unknown) => {
  console.error(e);
});
