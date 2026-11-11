/**
 * Detail material sets (public/assets/terrain/{set}/set.json + texture layers), the per-body material
 * uniform built from the set and the surface tunables, and the periodic noise volume of the orbital detail.
 */
import type { SurfaceRenderDef } from '@/core/contracts/defs';
import type { RenderContext } from '@/core/contracts/render';
import { LANDCOVER_CLASS } from '@/core/contracts/terrain';
import { hash4, hashToUnit } from '@/core/math';
import { coreOf, mipCount } from '@/render/core';
import { MATERIAL_UNIFORM_FLOATS, MAX_CLASSES, MAX_MATERIALS, NOISE_GRADIENT_RANGE, NOISE_PERIOD } from './shaders/surface';
import { IMAGE_DECODE_OPTIONS } from './workerProtocol';

/** public/assets/terrain/{set}/set.json (written by tools/terrain/gen_materials.py). */
export interface MaterialSetManifest {
  formatVersion: 1;
  id: string;
  /** Edge of every texture layer, texels. */
  size: number;
  materials: {
    id: string;
    /** RGBA image: rgb = sRGB albedo, a = height (0..1). */
    albedoHeight: string;
    /** RGBA image: rg = tangent-space normal xy (0.5 = flat), b = perceptual roughness, a = ambient occlusion. */
    normalRoughAo: string;
    /** Mean linear albedo of the albedo layer (the imagery is multiplied by albedo / mean). */
    meanAlbedo: [number, number, number];
    meanRoughness: number;
    /** Relative relief of the height layer in the height blend between materials. */
    heightGain: number;
  }[];
  /** Material weights per land-cover class name (keys of LANDCOVER_CLASS); "unknown" is the default row. */
  classWeights: Record<string, Record<string, number>>;
  /** Per class: orbital albedo amplitude, orbital relief amplitude (slope per unit noise gradient). */
  classOrbital: Record<string, [number, number]>;
  /** Weight added per unit of the bake's material channel (rockiness on Earth, crater freshness on the Moon). */
  channelGain: Record<string, number>;
  /** Weight added on steep ground. */
  slopeGain: Record<string, number>;
  /** Weight added per unit of macro noise (-1..1). */
  noiseGain: Record<string, number>;
  /** Material of launch-pad aprons, or null. */
  apronMaterial: string | null;
  /** Material whose textures the rock meshes carry. */
  rockMaterial: string;
}

/** Required numeric tunables of render/*.surface.json `params` (every key must be present). */
export const SURFACE_PARAM_KEYS = [
  'detailFadeDistanceM',
  'detailScale0M',
  'detailScale1M',
  'detailScale2M',
  'detailBias1',
  'detailBias2',
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
  'apronRadiusM',
  'apronEdgeM',
  'lakeDepthM',
  'shoreWetnessHeightM',
  'rockRangeM',
  'rockMinPixels',
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
  /** rgba8unorm-srgb array: albedo + height. */
  albedoHeight: GPUTexture;
  /** rgba8unorm array: normal xy, roughness, AO. */
  normalRoughAo: GPUTexture;
  viewA: GPUTextureView;
  viewB: GPUTextureView;
  index: Map<string, number>;
}

export async function loadMaterialSet(ctx: RenderContext, setId: string): Promise<MaterialSet> {
  const base = `${ctx.assetsUrl}/terrain/${setId}`;
  const res = await fetch(`${base}/set.json`);
  if (!res.ok) throw new Error(`terrain material set "${setId}": set.json HTTP ${res.status}`);
  const manifest = (await res.json()) as MaterialSetManifest;
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.materials) || manifest.materials.length === 0) throw new Error(`terrain material set "${setId}": bad set.json`);
  if (manifest.materials.length > MAX_MATERIALS) throw new Error(`terrain material set "${setId}": ${manifest.materials.length} materials, at most ${MAX_MATERIALS}`);
  const core = coreOf(ctx);
  const size = manifest.size;
  const layers = manifest.materials.length;
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  const mk = (label: string, format: GPUTextureFormat): GPUTexture =>
    core.createTextureChecked({ label, format, size: [size, size, layers], mipLevelCount: mipCount(size, size), usage });
  const albedoHeight = mk(`terrain.detailA.${setId}`, 'rgba8unorm-srgb');
  const normalRoughAo = mk(`terrain.detailB.${setId}`, 'rgba8unorm');
  const load = async (file: string, texture: GPUTexture, layer: number): Promise<void> => {
    const r = await fetch(`${base}/${file}`);
    if (!r.ok) throw new Error(`terrain material set "${setId}": ${file} HTTP ${r.status}`);
    const bitmap = await createImageBitmap(await r.blob(), IMAGE_DECODE_OPTIONS);
    if (bitmap.width !== size || bitmap.height !== size) throw new Error(`terrain material set "${setId}": ${file} is ${bitmap.width} x ${bitmap.height}, expected ${size}`);
    ctx.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, origin: [0, 0, layer], premultipliedAlpha: false }, [size, size]);
    bitmap.close();
  };
  await Promise.all(manifest.materials.flatMap((m, i) => [load(m.albedoHeight, albedoHeight, i), load(m.normalRoughAo, normalRoughAo, i)]));
  core.mips.generate(albedoHeight);
  core.mips.generate(normalRoughAo);
  return {
    manifest,
    albedoHeight,
    normalRoughAo,
    viewA: albedoHeight.createView({ dimension: '2d-array' }),
    viewB: normalRoughAo.createView({ dimension: '2d-array' }),
    index: new Map(manifest.materials.map((m, i) => [m.id, i])),
  };
}

/** The TerrainMaterial uniform (shaders/surface.ts) of a body. */
export function buildMaterialUniform(set: MaterialSet, p: SurfaceParams): Float32Array<ArrayBuffer> {
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
  }
  let o = orbBase + MAX_CLASSES * 4;
  m.materials.forEach((mt, i) => f.set([mt.meanAlbedo[0], mt.meanAlbedo[1], mt.meanAlbedo[2], mt.meanRoughness], o + i * 4));
  o += MAX_MATERIALS * 4;
  const gains = (table: Record<string, number>, at: number): void => {
    for (const [id, value] of Object.entries(table)) f[at + idx(id)] = value;
  };
  gains(m.channelGain, o);
  gains(m.slopeGain, o + 8);
  gains(m.noiseGain, o + 16);
  m.materials.forEach((mt, i) => (f[o + 24 + i] = mt.heightGain));
  o += 32;
  // The macro noise shares the orbital lattice, so its wavelength is the base wavelength over an integer.
  const macroRatio = Math.max(1, Math.round(p.orbitalWavelengthM / p.macroNoiseWavelengthM));
  f.set([p.slopeLo, p.slopeHi, m.apronMaterial ? idx(m.apronMaterial) : -1, m.materials.length], o);
  f.set([p.detailAlbedoStrength, p.detailNormalStrength, p.detailHeightContrast, p.orbitalWavelengthM / macroRatio], o + 4);
  f.set([p.baseRoughness, p.toksvigGain, p.apronEdgeM, p.lakeDepthM], o + 8);
  f.set([p.shoreWetnessHeightM, p.freshAlbedoBoost, p.detailAoStrength, p.detailChroma], o + 12);
  f.set([0, p.detailBias1, p.detailBias2, 0], o + 16);
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
