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
 *   cover=0                 no ground cover (tussocks, shrubs, trees, loose stones)
 *   rocks=0                 no rock field                          ballast=<iterations> GPU ballast pass
 *   morph=0                 geomorphing and fade-ins off (control experiment of the pop detector)
 *   hud=0                   no text overlay
 *   p.<body>.<key>=<n>      override a tunable of data/defs/render/<body>.surface.json (A/B comparisons)
 *   coverkinds=<ids>        draw only these kinds of ground cover; covershadow=0: the cover casts no shadow;
 *   leaftest=0              leaf sprays drawn whole; casters=0: terrain, rocks and cover cast no sun shadow
 *
 * window.__terrain is the handle for specs.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { Sim } from '@/core/contracts/sim';
import { layerHasTile, TILE_LAYER } from '@/core/contracts/terrain';
import { dirToLatLon, latLonToDir, tilePath, tileUvToDir, type TileKey } from '@/core/geo/cubeSphere';
import { decodeTileFile } from '@/core/geo/tileCodec';
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
  /** Latitude and longitude (deg, body-fixed) of the point of a body under the camera. */
  cameraSubPoint(bodyId: string): { latDeg: number; lonDeg: number };
  /** The point of a body under the active vessel, and the vessel's height above the body's reference radius (m). */
  vesselSubPoint(bodyId: string): { latDeg: number; lonDeg: number; altitude: number };
  /** Copy the canvas (as presented this frame) into a 2-D canvas of the given size and return its RGBA bytes. Call right after renderFrame(). */
  grab(width: number, height: number): Uint8ClampedArray;
  /**
   * Reference decode of a tile's image data by paths the renderer does not use: the albedo through an
   * <img> element and a 2-D canvas (sRGB bytes), the water mask and land cover through tileCodec.
   */
  referenceTile(bodyId: string, key: TileKey): Promise<{ albedo: Uint8ClampedArray; watermask: Uint8Array | null; landcover: Uint8Array | null }>;
  /**
   * Compare GPU vertex heights of READY tiles of the body's deepest render level around a point with the
   * height authority's collision surface at the same vertices: `samples` vertices spread over the tiles.
   */
  surfaceMatch(bodyId: string, latDeg: number, lonDeg: number, samples: number): Promise<{ tiles: number; samples: number; maxAbs: number; rms: number }>;
  /** Altitude above the reference radius (m) of whatever 'scene.depth' holds at a pixel of the internal render target (NaN = sky). */
  probeAltitude(bodyId: string, px: number, py: number): Promise<number>;
  /**
   * Fly a scripted camera path over a point with the loop stopped, one rendered frame per step (waiting
   * for the next animation frame in between, so streaming runs in real time): the height falls (or rises)
   * exponentially from `from` to `to`.
   *
   * Every frame is taken from the canvas as presented (after the temporal filter and the tonemapper, at
   * half the canvas resolution) and compared with the previous one pixel by pixel (mean of the RGB
   * differences, 8-bit levels). Returned: the mean absolute difference per frame over the whole image, and
   * per frame and block of a 16 x 9 grid (`blocks`, frames x 144), plus the streaming queue and the deepest
   * level per frame. (Read back before the temporal filter, every high-contrast edge hops a whole pixel at
   * a time and drowns the measurement: the horizon alone changes its block by 3-5 levels every few frames.)
   */
  flyPath(spec: PathSpec): Promise<PathResult>;
}

export interface PathResult {
  diffs: number[];
  /** Mean absolute difference of each block, frame by frame (row-major, PATH_BLOCKS[0] x PATH_BLOCKS[1] per frame). */
  blocks: number[];
  queue: number[];
  deepest: number[];
}

export const PATH_BLOCKS: [number, number] = [16, 9];

export interface PathSpec {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
  /** Heights above the ground (agl) or above the datum, m. */
  from: number;
  to: number;
  agl: boolean;
  headingDeg: number;
  /** Pitch at the start and at the end (deg, negative = down), interpolated with the logarithm of the height. */
  pitchFromDeg: number;
  pitchToDeg: number;
  frames: number;
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
  const tileSource = createFetchTileSource(ctx.tilesUrl);
  for (const [key, value] of query) {
    const m = /^p\.([\w-]+)\.(\w+)$/.exec(key);
    const surface = m ? ctx.defs.bodies[m[1]!]?.render.surface : undefined;
    if (m && surface) surface.params[m[2]!] = Number(value);
  }
  terrain = createTerrainFeature(
    ctx,
    async () => {
      provider = await createTerrainProvider(ctx.defs, tileSource);
      return provider;
    },
    // With performance attribution the rocks are a feature of their own, so their passes are timed alone.
    { streamer: { workers: Number(query.get('workers') ?? 6) }, rocks: query.get('rocks') !== '0', cover: query.get('cover') !== '0', rocksSeparate: query.get('perf') === 'features' },
  );
  await app.renderer.addFeature(terrain);
  if (terrain.rocks) await app.renderer.addFeature(terrain.rocks);
  if (terrain.cover) await app.renderer.addFeature(terrain.cover);
  if (query.has('delay')) terrain.debug.setStreamDelay(Number(query.get('delay')));
  if (query.get('morph') === '0') terrain.debug.setMorphEnabled(false);
  // Measurement switches (A/B of what each part costs or draws): coverkinds=<ids>, covershadow=0, leaftest=0, casters=0.
  if (query.has('coverkinds')) terrain.debug.setCoverOptions({ kinds: query.get('coverkinds')!.split(',').filter(Boolean) });
  if (query.get('covershadow') === '0') terrain.debug.setCoverOptions({ shadows: false });
  if (query.get('leaftest') === '0') terrain.debug.setCoverOptions({ leafTest: false });
  if (query.get('casters') === '0') terrain.debug.setShadowCasting(false);
  if (query.has('coverlod')) {
    // coverlod=<shadow fine texels>,<shadow middle texels>,<shadow least texels>,<G-buffer fine pixels>
    const [shadowFineTexels, shadowMiddleTexels, shadowMinTexels, finePixels] = query.get('coverlod')!.split(',').map(Number);
    if ([shadowFineTexels, shadowMiddleTexels, shadowMinTexels, finePixels].every((x) => Number.isFinite(x))) terrain.debug.setCoverOptions({ shadowFineTexels, shadowMiddleTexels, shadowMinTexels, finePixels });
  }

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
    cameraSubPoint(bodyId) {
      const b = app.snapshot().bodies.find((x) => x.id === bodyId)!;
      const ll = dirToLatLon(quat.rotateInv(b.qFixedToRoot, v3.sub(app.cameraState().positionRoot, b.rRoot)));
      return { latDeg: ll.lat / DEG, lonDeg: ll.lon / DEG };
    },
    vesselSubPoint(bodyId) {
      const snap = app.snapshot();
      const b = snap.bodies.find((x) => x.id === bodyId)!;
      const vessel = snap.vessels.find((x) => x.id === snap.activeVesselId)!;
      const rel = v3.sub(vessel.rRoot, b.rRoot);
      const ll = dirToLatLon(quat.rotateInv(b.qFixedToRoot, rel));
      return { latDeg: ll.lat / DEG, lonDeg: ll.lon / DEG, altitude: v3.len(rel) - app.defs.bodies[bodyId]!.radius };
    },
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
    async referenceTile(bodyId, key) {
      const tileset = ctx.defs.bodies[bodyId]!.terrain!.tileset;
      const manifest = await tileSource.manifest(tileset);
      const albedoLayer = manifest.layers[TILE_LAYER.albedo]!;
      const url = `${ctx.tilesUrl}/${tilePath(tileset, TILE_LAYER.albedo, key, albedoLayer.ext)}?v=${encodeURIComponent(manifest.contentHash)}`;
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const c2d = c.getContext('2d', { willReadFrequently: true })!;
      c2d.drawImage(img, 0, 0);
      const albedo = c2d.getImageData(0, 0, c.width, c.height).data;
      const u8 = async (layer: string): Promise<Uint8Array | null> => {
        const lm = manifest.layers[layer];
        if (!lm || !layerHasTile(lm, key)) return null;
        const bytes = await tileSource.tile(tileset, layer, key);
        if (!bytes) return null;
        const t = await decodeTileFile(bytes);
        return t.kind === 'u8' ? t.data : null;
      };
      return { albedo, watermask: await u8(TILE_LAYER.watermask), landcover: await u8(TILE_LAYER.landcover) };
    },
    async surfaceMatch(bodyId, latDeg, lonDeg, samples) {
      const level = ctx.defs.bodies[bodyId]!.terrain!.maxRenderLevel;
      const keys = terrain.debug.readyTiles(bodyId, level, latDeg, lonDeg, 24);
      if (keys.length === 0) return { tiles: 0, samples: 0, maxAbs: NaN, rms: NaN };
      await provider.ensureLoaded(bodyId, latLonToDir(latDeg * DEG, lonDeg * DEG), 400, 'lab:surface-match');
      const per = Math.ceil(samples / keys.length);
      let maxAbs = 0;
      let sum = 0;
      let count = 0;
      for (const [t, key] of keys.entries()) {
        const { heights } = await terrain.debug.readTile(bodyId, key);
        for (let s = 0; s < per && count < samples; s++) {
          // A fixed pseudo-random spread over the 65 x 65 vertices of each tile.
          const i = (s * 37 + t * 11) % 65;
          const j = (s * 53 + t * 29 + Math.floor(s / 65)) % 65;
          const gpu = heights[j * 65 + i]!;
          const cpu = provider.heightAt(bodyId, tileUvToDir(key, i / 64, j / 64));
          const d = Math.abs(gpu - cpu);
          maxAbs = Math.max(maxAbs, d);
          sum += d * d;
          count++;
        }
      }
      return { tiles: keys.length, samples: count, maxAbs, rms: Math.sqrt(sum / count) };
    },
    async probeAltitude(bodyId, px, py) {
      const depth = await app.renderer.readDepth();
      const d = depth.data[py * depth.width + px]!;
      if (!(d > 0)) return NaN;
      const cam = app.cameraState();
      const snap = app.snapshot();
      const body = snap.bodies.find((b) => b.id === bodyId)!;
      const tanY = Math.tan(cam.fovY / 2);
      const tanX = (tanY * depth.width) / depth.height;
      const ndcX = ((px + 0.5) / depth.width) * 2 - 1;
      const ndcY = 1 - ((py + 0.5) / depth.height) * 2;
      const viewZ = 0.05 / d;
      const pView = { x: ndcX * tanX * viewZ, y: ndcY * tanY * viewZ, z: -viewZ };
      const pRoot = v3.add(cam.positionRoot, quat.rotate(cam.qViewToRoot, pView));
      return v3.dist(pRoot, body.rRoot) - ctx.defs.bodies[bodyId]!.radius;
    },
    async flyPath(spec) {
      const ground = spec.agl ? await lab.groundHeight(spec.bodyId, spec.latDeg, spec.lonDeg) : 0;
      const diffs: number[] = [];
      const blocks: number[] = [];
      const queue: number[] = [];
      const deepest: number[] = [];
      const [bx, by] = PATH_BLOCKS;
      const w = canvas.width >> 1;
      const h = canvas.height >> 1;
      let prev: Uint8ClampedArray | null = null;
      const sums = new Float64Array(bx * by);
      const counts = new Float64Array(bx * by);
      app.setLoop(false);
      try {
        for (let f = 0; f < spec.frames; f++) {
          const t = f / Math.max(1, spec.frames - 1);
          const height = spec.from * (spec.to / spec.from) ** t;
          app.camera.spec = { type: 'surface', bodyId: spec.bodyId, latDeg: spec.latDeg, lonDeg: spec.lonDeg, alt: ground + height, headingDeg: spec.headingDeg, pitchDeg: spec.pitchFromDeg + (spec.pitchToDeg - spec.pitchFromDeg) * t };
          app.renderFrame(1 / 60);
          const now = lab.grab(w, h).slice();
          if (prev) {
            sums.fill(0);
            counts.fill(0);
            let total = 0;
            for (let y = 0; y < h; y++) {
              const row = Math.min(by - 1, Math.floor((y * by) / h)) * bx;
              for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const d = (Math.abs(now[o]! - prev[o]!) + Math.abs(now[o + 1]! - prev[o + 1]!) + Math.abs(now[o + 2]! - prev[o + 2]!)) / 3;
                const b = row + Math.min(bx - 1, Math.floor((x * bx) / w));
                sums[b] = sums[b]! + d;
                counts[b] = counts[b]! + 1;
                total += d;
              }
            }
            diffs.push(total / (w * h));
            for (let b = 0; b < bx * by; b++) blocks.push(Math.round((sums[b]! / counts[b]!) * 1000) / 1000);
          }
          prev = now;
          const st = terrain.debug.stats();
          queue.push(st.stream.queued + st.stream.loading + st.stream.uploading);
          deepest.push(st.bodies[spec.bodyId]?.deepestLevel ?? 0);
          await new Promise(requestAnimationFrame);
        }
      } finally {
        app.setLoop(true);
      }
      return { diffs, blocks, queue, deepest };
    },
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
        `select ${st.selectMs.toFixed(2)} ms  records ${st.records}  rocks ${st.rocks.instances}  cover ${st.cover.instances}`;
    });
  }
  await app.testApi.api.waitFrames(2);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((e: unknown) => {
  console.error(e);
});
