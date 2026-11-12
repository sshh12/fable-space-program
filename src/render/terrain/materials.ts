/**
 * Detail material sets (public/assets/terrain/{set}/set.json + texture layers), the per-body material
 * uniform built from the set and the surface tunables, and the periodic noise volume of the orbital detail.
 */
import type { SurfaceRenderDef } from '@/core/contracts/defs';
import type { RenderContext } from '@/core/contracts/render';
import { COVERAGE_BLEND_TILES, LANDCOVER_CLASS, type TileLayerManifest } from '@/core/contracts/terrain';
import { CUBE_FACES, type FaceId } from '@/core/geo/cubeSphere';
import { hash4, hashToUnit } from '@/core/math';
import { coreOf, mipCount } from '@/render/core';
import type { CoverDef } from './cover';
import { DETAIL_SCALES, MATERIAL_UNIFORM_FLOATS, MAX_CLASSES, MAX_MATERIALS, MAX_REGIONS, NOISE_GRADIENT_RANGE, NOISE_PERIOD } from './shaders/surface';
import { MAX_SITES, MAX_SITE_SHAPES, packSiteShapes, type SitePlan } from './sitePlan';
import { IMAGE_DECODE_OPTIONS } from './workerProtocol';

/** One texture layer of a material: its content at one detail scale. */
export interface MaterialLayerManifest {
  /** RGBA image: rgb = sRGB albedo, a = height (0..1 over `reliefM`). */
  albedoHeight: string;
  /** RGBA image: rg = tangent-space normal xy (0.5 = flat; true slopes at the layer's ground size), b = perceptual roughness, a = ambient occlusion. */
  normalRoughAo: string;
  /** Mean linear albedo of the albedo image as decoded (the imagery is multiplied by albedo / mean). */
  meanAlbedo: [number, number, number];
  meanRoughness: number;
  /** Height range of the height channel, m. */
  reliefM: number;
  /** Mean of the height channel, 0..1 (heights are measured from it). */
  meanHeight: number;
}

/** public/assets/terrain/{set}/set.json (written by tools/terrain/gen_materials.py). */
export interface MaterialSetManifest {
  formatVersion: 2;
  id: string;
  /** Edge of the near layers and of the mid / far / aerial layers, texels. */
  nearSize: number;
  wideSize: number;
  /** Ground size the near, mid, far and aerial layers were made for, m (the tunables detailScale0M..3M tile them). */
  scalesM: [number, number, number, number];
  materials: {
    id: string;
    /** Near, mid, far and aerial layer: different content, each of the sizes its scale shows. */
    layers: [MaterialLayerManifest, MaterialLayerManifest, MaterialLayerManifest, MaterialLayerManifest];
  }[];
  /** Material weights per land-cover class name (keys of LANDCOVER_CLASS); "unknown" is the default row. */
  classWeights: Record<string, Record<string, number>>;
  /** Per class: orbital albedo amplitude, orbital relief amplitude (slope per unit noise gradient). */
  classOrbital: Record<string, [number, number]>;
  /**
   * Per class (default [1, 0]): what the class looks like from where the canopy over its ground is no longer
   * drawn (beyond the ground cover's range), relative to the ground itself: brightness, and how far the
   * colour goes to leaf green. A forest from the air is its crowns, darker and greener than the grass under them.
   */
  classTone: Record<string, [number, number]>;
  /** Weight added per unit of the bake's material channel (rockiness on Earth, crater freshness on the Moon). */
  channelGain: Record<string, number>;
  /** Weight added on steep ground. */
  slopeGain: Record<string, number>;
  /** Weight added per unit of macro noise (-1..1). */
  noiseGain: Record<string, number>;
  /**
   * Weight added by the colour of the imagery: per unit of darkness (1 = black, 0 = albedo 0.12 or more), of
   * saturation (0 below 0.25, 1 above 0.6 of (max - min) / max) and of greenness ((g - max(r, b)) / max).
   */
  albedoGain: Record<string, [number, number, number]>;
  /**
   * The hexagon pattern that hides the repetition blends three copies of a layer; a copy's weight is
   * multiplied by 2^(hexBlend[0] x height above the layer's mean) and 2^(hexBlend[1] x depth below it)
   * (heights 0..1). [6, -6]: the higher surface wins (stones stay whole, gaps give way); [8, 8]: whatever
   * stands out from the mean wins (stones and pits stay whole).
   */
  hexBlend: [number, number];
  /**
   * Share (0..1) of the relief of the far and aerial layers that the terrain's own normal map replaces once
   * it resolves their sizes: 1 where the layers hold what the height function also holds (craters), near 0
   * where they hold what it does not (bushes, tussocks).
   */
  terrainRelief: number;
  /** Weight added on low, level ground at the water's edge (beaches). */
  shoreGain: Record<string, number>;
  /**
   * Roughness factor of what stands above a layer's mean height, per material (default 1): the crests of
   * ropy lava are glassy, the hollows between them are not.
   */
  gloss: Record<string, number>;
  /** Share of a material's colour variation kept where the ground takes its albedo (default 1): rock is grey, growth is not. */
  chroma: Record<string, number>;
  /**
   * Albedo the ground takes where a material covers it and the imagery is calibrated (linear rgb), per
   * material; default: the mean of its near layer. Lets a set state what its ground is (olive, dry grass)
   * where the photographs its layers were made from are not (a watered lawn).
   */
  anchorAlbedo: Record<string, [number, number, number]>;
  /**
   * How far above its albedo the brightness of the imagery may lift the ground of a material (default 1.1):
   * rock is as dark as it is wherever the mosaic is pale; dry grass and soil vary.
   */
  toneMax: Record<string, number>;
  /** Material of launch-pad aprons, or null. */
  apronMaterial: string | null;
  /** Material whose layers the compacted gravel of a launch site carries (with the body's gravel albedo), or null. */
  gravelMaterial: string | null;
  /** Material whose near layer the rock meshes carry. */
  rockMaterial: string;
  /** What stands up from the ground by land-cover class (cover.ts), or null for bare ground. */
  cover: CoverDef | null;
}

/** Required numeric tunables of render/*.surface.json `params` (every key must be present). */
export const SURFACE_PARAM_KEYS = [
  'detailFadeDistanceM',
  'detailScale0M',
  'detailScale1M',
  'detailScale2M',
  'detailScale3M',
  'detailAlbedoStrength',
  'detailNormalStrength',
  'detailHeightContrast',
  'detailAoStrength',
  'detailChroma',
  'macroNoiseWavelengthM',
  'baseRoughness',
  'toksvigGain',
  'orbitalWavelengthM',
  'orbitalOctaves',
  'orbitalAlbedoStrength',
  'orbitalReliefStrength',
  'slopeLo',
  'slopeHi',
  'freshAlbedoBoost',
  'nightLuminance',
  'nightOnCos',
  'nightOffCos',
  'nightTintR',
  'nightTintG',
  'nightTintB',
  'nightMinMip',
  'nightClusterM',
  'nightClusterStrength',
  'deepWaterSrgbR',
  'deepWaterSrgbG',
  'deepWaterSrgbB',
  'deepWaterDepthM',
  'apronRadiusM',
  'apronMarginM',
  'apronJointM',
  'apronShoulderM',
  'gravelAlbedoR',
  'gravelAlbedoG',
  'gravelAlbedoB',
  'imageryCalibrationLevel',
  'imagerySaturation',
  'imagerySaturationGlobal',
  'classBandM',
  'imageryRefLuminance',
  'imageryContrast',
  'anchorNear',
  'anchorFar',
  'reliefShadow',
  'reliefShadowTaps',
  'reliefShadowFar',
  'shoreReachM',
  'lakeDepthM',
  'shoreWetnessHeightM',
  'rockRangeM',
  'rockMinPixels',
  'rockMinRadiusM',
  'rockAlbedoScale',
  'rockRoughness',
] as const;
export type SurfaceParamKey = (typeof SURFACE_PARAM_KEYS)[number];
export type SurfaceParams = Record<SurfaceParamKey, number>;

export function readSurfaceParams(bodyId: string, surface: SurfaceRenderDef): SurfaceParams {
  const out = {} as SurfaceParams;
  for (const key of SURFACE_PARAM_KEYS) {
    const v = surface.params[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`body "${bodyId}": render surface params lack "${key}" (data/defs/render/*.surface.json)`);
    out[key] = v;
  }
  return out;
}

export interface MaterialSet {
  manifest: MaterialSetManifest;
  /** Near layers (layer = material): rgba8unorm-srgb albedo + height, rgba8unorm normal xy + roughness + AO. */
  nearA: GPUTexture;
  nearB: GPUTexture;
  /** Mid, far and aerial layers (layer = 3 x material + scale - 1). */
  wideA: GPUTexture;
  wideB: GPUTexture;
  viewNearA: GPUTextureView;
  viewNearB: GPUTextureView;
  viewWideA: GPUTextureView;
  viewWideB: GPUTextureView;
  index: Map<string, number>;
  /** Bytes of the four arrays with their mip chains. */
  bytes: number;
}

export async function loadMaterialSet(ctx: RenderContext, setId: string): Promise<MaterialSet> {
  const base = `${ctx.assetsUrl}/terrain/${setId}`;
  const res = await fetch(`${base}/set.json`);
  if (!res.ok) throw new Error(`terrain material set "${setId}": set.json HTTP ${res.status}`);
  const manifest = (await res.json()) as MaterialSetManifest;
  if (manifest.formatVersion !== 2 || !Array.isArray(manifest.materials) || manifest.materials.length === 0) throw new Error(`terrain material set "${setId}": bad set.json (formatVersion 2 expected)`);
  if (manifest.materials.length > MAX_MATERIALS) throw new Error(`terrain material set "${setId}": ${manifest.materials.length} materials, at most ${MAX_MATERIALS}`);
  if (manifest.materials.some((m) => m.layers.length !== DETAIL_SCALES)) throw new Error(`terrain material set "${setId}": every material needs ${DETAIL_SCALES} layers`);
  if (!Array.isArray(manifest.hexBlend) || manifest.hexBlend.length !== 2 || typeof manifest.terrainRelief !== 'number') throw new Error(`terrain material set "${setId}": set.json lacks hexBlend or terrainRelief`);
  if (typeof manifest.shoreGain !== 'object' || typeof manifest.gloss !== 'object' || typeof manifest.chroma !== 'object' || typeof manifest.anchorAlbedo !== 'object' || typeof manifest.toneMax !== 'object' || typeof manifest.classTone !== 'object' || manifest.gravelMaterial === undefined || manifest.cover === undefined) throw new Error(`terrain material set "${setId}": set.json lacks shoreGain, gloss, toneMax, classTone or gravelMaterial (rebuild it: tools/terrain/gen_materials.py --manifest-only)`);
  const core = coreOf(ctx);
  const count = manifest.materials.length;
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  let bytes = 0;
  const mk = (label: string, format: GPUTextureFormat, size: number, layers: number): GPUTexture => {
    bytes += Math.round((size * size * layers * 4 * 4) / 3);
    return core.createTextureChecked({ label, format, size: [size, size, layers], mipLevelCount: mipCount(size, size), usage });
  };
  const nearA = mk(`terrain.detailA.${setId}`, 'rgba8unorm-srgb', manifest.nearSize, count);
  const nearB = mk(`terrain.detailB.${setId}`, 'rgba8unorm', manifest.nearSize, count);
  const wide = DETAIL_SCALES - 1;
  const wideA = mk(`terrain.detailWideA.${setId}`, 'rgba8unorm-srgb', manifest.wideSize, count * wide);
  const wideB = mk(`terrain.detailWideB.${setId}`, 'rgba8unorm', manifest.wideSize, count * wide);
  const load = async (file: string, texture: GPUTexture, layer: number): Promise<void> => {
    const r = await fetch(`${base}/${file}`);
    if (!r.ok) throw new Error(`terrain material set "${setId}": ${file} HTTP ${r.status}`);
    const bitmap = await createImageBitmap(await r.blob(), IMAGE_DECODE_OPTIONS);
    if (bitmap.width !== texture.width || bitmap.height !== texture.height) throw new Error(`terrain material set "${setId}": ${file} is ${bitmap.width} x ${bitmap.height}, expected ${texture.width}`);
    ctx.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, origin: [0, 0, layer], premultipliedAlpha: false }, [texture.width, texture.height]);
    bitmap.close();
  };
  await Promise.all(
    manifest.materials.flatMap((m, i) =>
      m.layers.flatMap((l, s) => (s === 0 ? [load(l.albedoHeight, nearA, i), load(l.normalRoughAo, nearB, i)] : [load(l.albedoHeight, wideA, wide * i + s - 1), load(l.normalRoughAo, wideB, wide * i + s - 1)])),
    ),
  );
  for (const t of [nearA, nearB, wideA, wideB]) core.mips.generate(t);
  return {
    manifest,
    nearA,
    nearB,
    wideA,
    wideB,
    viewNearA: nearA.createView({ dimension: '2d-array' }),
    viewNearB: nearB.createView({ dimension: '2d-array' }),
    viewWideA: wideA.createView({ dimension: '2d-array' }),
    viewWideB: wideB.createView({ dimension: '2d-array' }),
    index: new Map(manifest.materials.map((m, i) => [m.id, i])),
    bytes,
  };
}

/** A launch site as the material uniform holds it: its ground plan and the east and north unit vectors at the pad (body-fixed). */
export interface SiteGroundPlan {
  plan: SitePlan;
  east: [number, number, number];
  north: [number, number, number];
}

/**
 * A region of a body whose ground takes the albedo of its materials: a rectangle in the coordinates of a cube
 * face (s, t in -1..1), with the width of the feather inside its edge.
 */
export interface MaterialRegion {
  face: FaceId;
  s0: number;
  t0: number;
  s1: number;
  t1: number;
  feather: number;
}

/**
 * The regions of a body: the rectangles of the imagery layer's first level above `calibrationLevel` (where
 * regional imagery, and the ground the material set was made for, begin), feathered over the width the
 * bakes blend regional data into the body-wide data over. None when the level is negative (the whole body is
 * one region) or the layer has no such level.
 */
export function materialRegions(layer: TileLayerManifest, calibrationLevel: number): MaterialRegion[] {
  if (calibrationLevel < 0) return [];
  const level = Math.round(calibrationLevel) + 1;
  const n = 2 ** level;
  return (layer.coverage[String(level)] ?? []).slice(0, MAX_REGIONS).map((r) => ({
    face: r.face,
    s0: -1 + (2 * r.x0) / n,
    t0: -1 + (2 * r.y0) / n,
    s1: -1 + (2 * (r.x1 + 1)) / n,
    t1: -1 + (2 * (r.y1 + 1)) / n,
    feather: (2 * COVERAGE_BLEND_TILES) / n,
  }));
}

/** The TerrainMaterial uniform (shaders/surface.ts) of a body. `sites`: at most MAX_SITES, in the order of their index. */
export function buildMaterialUniform(set: MaterialSet, p: SurfaceParams, sites: readonly SiteGroundPlan[] = [], regions: readonly MaterialRegion[] = []): Float32Array<ArrayBuffer> {
  const f = new Float32Array(MATERIAL_UNIFORM_FLOATS);
  const m = set.manifest;
  const idx = (id: string): number => {
    const i = set.index.get(id);
    if (i === undefined) throw new Error(`terrain material set "${m.id}": unknown material "${id}"`);
    return i;
  };
  const classNames = Object.keys(LANDCOVER_CLASS) as (keyof typeof LANDCOVER_CLASS)[];
  const defaultW = m.classWeights.unknown;
  const defaultOrb = m.classOrbital.unknown;
  if (!defaultW || !defaultOrb) throw new Error(`terrain material set "${m.id}": classWeights.unknown and classOrbital.unknown are required`);
  const orbBase = MAX_CLASSES * 2 * 4;
  for (let c = 0; c < MAX_CLASSES; c++) {
    const name = classNames.find((n) => LANDCOVER_CLASS[n] === c);
    const w = (name && m.classWeights[name]) || defaultW;
    for (const [id, value] of Object.entries(w)) f[c * 8 + idx(id)] = value;
    const orb = (name && m.classOrbital[name]) || defaultOrb;
    f[orbBase + c * 4] = orb[0];
    f[orbBase + c * 4 + 1] = orb[1];
    const tone = (name && m.classTone[name]) || [1, 0];
    f[orbBase + c * 4 + 2] = tone[0]!;
    f[orbBase + c * 4 + 3] = tone[1]!;
  }
  let o = orbBase + MAX_CLASSES * 4;
  m.materials.forEach((mt, i) => mt.layers.forEach((l, s) => f.set([l.meanAlbedo[0], l.meanAlbedo[1], l.meanAlbedo[2], l.reliefM], o + (i * DETAIL_SCALES + s) * 4)));
  o += MAX_MATERIALS * DETAIL_SCALES * 4;
  m.materials.forEach((mt, i) => mt.layers.forEach((l, s) => f.set([l.meanHeight, m.gloss[mt.id] ?? 1, m.chroma[mt.id] ?? 1, m.toneMax[mt.id] ?? 1.1], o + (i * DETAIL_SCALES + s) * 4)));
  o += MAX_MATERIALS * DETAIL_SCALES * 4;
  const gains = (table: Record<string, number>, at: number): void => {
    for (const [id, value] of Object.entries(table)) f[at + idx(id)] = value;
  };
  gains(m.channelGain, o);
  gains(m.slopeGain, o + 8);
  gains(m.noiseGain, o + 16);
  for (const [id, g] of Object.entries(m.albedoGain)) g.forEach((value, feature) => (f[o + 24 + feature * 8 + idx(id)] = value));
  o += 48;
  // The macro noise shares the orbital lattice, so its wavelength is the base wavelength over an integer.
  const macroRatio = Math.max(1, Math.round(p.orbitalWavelengthM / p.macroNoiseWavelengthM));
  f.set([p.slopeLo, p.slopeHi, m.apronMaterial ? idx(m.apronMaterial) : -1, m.materials.length], o);
  f.set([p.detailAlbedoStrength, p.detailNormalStrength, p.detailHeightContrast, p.orbitalWavelengthM / macroRatio], o + 4);
  f.set([p.baseRoughness, p.toksvigGain, 0, p.lakeDepthM], o + 8);
  f.set([p.shoreWetnessHeightM, p.freshAlbedoBoost, p.detailAoStrength, p.detailChroma], o + 12);
  f.set([p.detailScale0M / m.nearSize, p.detailScale1M / m.wideSize, p.detailScale2M / m.wideSize, p.detailScale3M / m.wideSize], o + 16);
  f.set([m.hexBlend[0], m.hexBlend[1], m.terrainRelief, Math.max(p.apronShoulderM, 1e-3)], o + 20);
  o += 24;
  gains(m.shoreGain, o);
  o += 8;
  f.set([p.imageryCalibrationLevel, p.imagerySaturation, Math.max(p.imageryRefLuminance, 1e-4), p.imageryContrast], o);
  f.set([p.anchorNear, p.anchorFar, Math.max(p.apronJointM, 0.5), m.gravelMaterial ? idx(m.gravelMaterial) : -1], o + 4);
  f.set([p.gravelAlbedoR, p.gravelAlbedoG, p.gravelAlbedoB, p.reliefShadow], o + 8);
  if (regions.length > MAX_REGIONS) throw new Error(`terrain material set "${m.id}": ${regions.length} regions, at most ${MAX_REGIONS}`);
  f.set([Math.max(p.shoreReachM, 1e-3), Math.max(p.shoreWetnessHeightM, 1e-3), regions.length, Math.max(2, Math.round(p.reliefShadowTaps))], o + 12);
  f.set([p.imagerySaturationGlobal, Math.max(0, p.classBandM), p.reliefShadowFar, 0], o + 16);
  o += 20;
  m.materials.forEach((mt, i) => f.set(m.anchorAlbedo[mt.id] ?? mt.layers[0].meanAlbedo, o + i * 4));
  o += MAX_MATERIALS * 4;
  if (sites.length > MAX_SITES) throw new Error(`terrain: ${sites.length} launch sites on one body, at most ${MAX_SITES}`);
  let shape = 0;
  sites.forEach((site, i) => {
    const count = Math.min(site.plan.shapes.length, MAX_SITE_SHAPES - shape);
    f.set([site.east[0], site.east[1], site.east[2], shape, site.north[0], site.north[1], site.north[2], count], o + i * 8);
    packSiteShapes({ ...site.plan, shapes: site.plan.shapes.slice(0, count) }, f, o + MAX_SITES * 8 + shape * 8);
    shape += count;
  });
  o += MAX_SITES * 8 + MAX_SITE_SHAPES * 8;
  regions.forEach((r, i) => {
    const face = CUBE_FACES[r.face]!;
    f.set([face.n[0], face.n[1], face.n[2], r.s0, face.u[0], face.u[1], face.u[2], r.t0, face.v[0], face.v[1], face.v[2], r.s1, r.t1, r.feather, 0, 0], o + i * 16);
  });
  return f;
}

/** Texels of the noise volume per side, and per lattice cell. */
export const NOISE_SIZE = 64;
const NOISE_TEXELS_PER_CELL = NOISE_SIZE / NOISE_PERIOD;

/**
 * Periodic gradient noise, NOISE_SIZE^3 rgba8unorm: rgb = gradient per lattice cell / NOISE_GRADIENT_RANGE,
 * a = value, each as x * 0.5 + 0.5. Period NOISE_PERIOD cells in every axis.
 */
export function buildNoiseVolume(seed: number): Uint8Array<ArrayBuffer> {
  const n = NOISE_SIZE;
  const period = NOISE_PERIOD;
  const grad = new Float32Array(period * period * period * 3);
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) {
        const h = hash4(x, y, z, seed);
        const cz = hashToUnit(h) * 2 - 1;
        const a = hashToUnit(hash4(z, x, y, seed + 1)) * 2 * Math.PI;
        const r = Math.sqrt(Math.max(0, 1 - cz * cz));
        grad.set([r * Math.cos(a), r * Math.sin(a), cz], ((z * period + y) * period + x) * 3);
      }
    }
  }
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const value = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) {
    const pz = (k + 0.5) / NOISE_TEXELS_PER_CELL;
    const iz = Math.floor(pz);
    const fz = pz - iz;
    for (let j = 0; j < n; j++) {
      const py = (j + 0.5) / NOISE_TEXELS_PER_CELL;
      const iy = Math.floor(py);
      const fy = py - iy;
      for (let i = 0; i < n; i++) {
        const px = (i + 0.5) / NOISE_TEXELS_PER_CELL;
        const ix = Math.floor(px);
        const fx = px - ix;
        let v = 0;
        for (let c = 0; c < 8; c++) {
          const ox = c & 1;
          const oy = (c >> 1) & 1;
          const oz = c >> 2;
          const g = ((((iz + oz) % period) * period + ((iy + oy) % period)) * period + ((ix + ox) % period)) * 3;
          const d = grad[g]! * (fx - ox) + grad[g + 1]! * (fy - oy) + grad[g + 2]! * (fz - oz);
          v += d * (ox ? fade(fx) : 1 - fade(fx)) * (oy ? fade(fy) : 1 - fade(fy)) * (oz ? fade(fz) : 1 - fade(fz));
        }
        value[(k * n + j) * n + i] = v * 1.6;
      }
    }
  }
  const out = new Uint8Array(n * n * n * 4);
  const at = (i: number, j: number, k: number): number => value[((((k + n) % n) * n + ((j + n) % n)) * n + ((i + n) % n))]!;
  const enc = (x: number): number => Math.max(0, Math.min(255, Math.round((x * 0.5 + 0.5) * 255)));
  // Central differences over two texels, converted to "per lattice cell".
  const gs = NOISE_TEXELS_PER_CELL / 2 / NOISE_GRADIENT_RANGE;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = ((k * n + j) * n + i) * 4;
        out[o] = enc((at(i + 1, j, k) - at(i - 1, j, k)) * gs);
        out[o + 1] = enc((at(i, j + 1, k) - at(i, j - 1, k)) * gs);
        out[o + 2] = enc((at(i, j, k + 1) - at(i, j, k - 1)) * gs);
        out[o + 3] = enc(at(i, j, k));
      }
    }
  }
  return out;
}

export function createNoiseTexture(ctx: RenderContext): GPUTexture {
  const tex = coreOf(ctx).createTextureChecked({
    label: 'terrain.noise',
    format: 'rgba8unorm',
    dimension: '3d',
    size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  ctx.device.queue.writeTexture({ texture: tex }, buildNoiseVolume(0x51ed270b), { bytesPerRow: NOISE_SIZE * 4, rowsPerImage: NOISE_SIZE }, [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE]);
  return tex;
}
