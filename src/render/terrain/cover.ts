/**
 * Ground cover: what stands up from the ground and is not in the height function. Grass tussocks, shrubs,
 * low trees and loose stones, placed by land-cover class around the camera and drawn as instanced meshes
 * (coverMesh.ts) into the G-buffer and the sun shadow cascades.
 *
 * A photograph taken at eye height is made of things seen from the side that overlap, hide the ground behind
 * them and cast shadows on it; no texture on a plane does that. None of the cover collides: stones stay
 * below the size at which the height function carries rocks, plants are plants.
 *
 * Placement is a pure function of the body, the baked land-cover layer and the set's `cover` table: a kind
 * of cover lives in chunks (cube-sphere tiles of about its `chunkM`), a chunk scatters candidates by hash
 * over its own tile, keeps each with the density of the class under it (times a clumping noise fixed to the
 * ground), never on a launch site's concrete and gravel, never in the sea, and stands it on the height
 * function (band-limited to the size of the thing). An instance is drawn within radius x range-per-radius
 * (the kind's `minPixels`; at most its `rangeM`) and grows from nothing over the outer 30 % of that, so
 * nothing pops in; a chunk that is built while in view fades in. Levels of detail are prefixes of a chunk's
 * instances by size, as in the rock field.
 */
import type { BodyDef } from '@/core/contracts/defs';
import { MATERIAL_ID, RENDER_FORMATS, type FrameContext, type RenderContext, type ShadowCascadeView } from '@/core/contracts/render';
import { deepestAvailable, LANDCOVER_CLASS, TILE_LAYER, type TileLayerManifest, type TileSource } from '@/core/contracts/terrain';
import { dirToTile, tileUvToDir, type TileKey } from '@/core/geo/cubeSphere';
import { decodeFrt1 } from '@/core/geo/tileCodec';
import { DEG, hash4, hashToUnit, mat3, quat, v3, type Mat3, type Vec3 } from '@/core/math';
import { coreOf, mipCount, type Tracked } from '@/render/core';
import type { TerrainAuthority } from '@/terrain';
import { buildCoverMesh, COVER_LODS, COVER_SHAPES, COVER_VARIANTS, COVER_VERTEX_FLOATS, FOLIAGE_CELLS, type CoverShape } from './coverMesh';
import type { ViewFrustum } from './quadtree';
import { siteGround, type SitePlan } from './sitePlan';
import { tileId } from './tileMath';
import { IMAGE_DECODE_OPTIONS } from './workerProtocol';

/** One kind of cover (set.json `cover.kinds`). */
export interface CoverKindDef {
  id: string;
  shape: CoverShape;
  /** Footprint radius, smallest and largest, m (small ones are the many). */
  radiusM: [number, number];
  /** Height per metre of radius, least and most. */
  heightPerRadius: [number, number];
  /** Largest distance at which the kind is drawn, m, and the size on screen (pixels across) below which an instance is not. */
  rangeM: number;
  minPixels: number;
  /**
   * Distance from which the kind is drawn, m (0 = from the eye): an instance grows from nothing between
   * 0.7 of it and it. A stand of trees takes over where the single trees have shrunk away.
   */
  nearM: number;
  /** Edge of the chunks the kind lives in, m (about). */
  chunkM: number;
  /** Linear albedo, and the albedo the driest instances go to. */
  tint: [number, number, number];
  tintDry: [number, number, number];
  /** 0 = evenly scattered .. 1 = in patches with bare ground between them; wavelength of the patches, m. */
  clump: number;
  clumpM: number;
}

/** The `cover` table of a material set. */
export interface CoverDef {
  kinds: CoverKindDef[];
  /** Instances per square metre, by land-cover class name and kind id. */
  classDensity: Record<string, Record<string, number>>;
  /** Direction the prevailing wind blows towards (deg clockwise from north) and how far it bends grass (share of its height). */
  windToDeg: number;
  windLean: number;
  /**
   * The leaf atlas of the set's shrubs and trees (a file beside set.json: 2 x 2 cells, tools/terrain/gen_foliage.py),
   * or null when no kind of the set has leaves.
   */
  foliage: string | null;
}

/** Measurement switches of the ground cover: the kinds that are drawn (null = all), whether it casts shadows, whether leaf sprays are tested for coverage. */
export interface CoverOptions {
  kinds: string[] | null;
  shadows: boolean;
  leafTest: boolean;
  /**
   * Levels of detail: an instance casts into a cascade from its finest mesh when its radius is
   * `shadowFineTexels` texels, from the middle one from `shadowMiddleTexels`, and not at all below
   * `shadowMinTexels`; in the G-buffer it takes the finest mesh when its radius spans `finePixels` pixels and
   * the middle one from `middlePixels`.
   */
  shadowFineTexels: number;
  shadowMiddleTexels: number;
  shadowMinTexels: number;
  finePixels: number;
  middlePixels: number;
}

export interface CoverSite {
  /** Pad centre (body-fixed, m), east and north unit vectors there, and the site's ground plan. */
  centre: Vec3;
  east: Vec3;
  north: Vec3;
  plan: SitePlan;
}

export interface CoverBodyInfo {
  id: string;
  def: BodyDef;
  cover: CoverDef;
  tileset: string;
  landcover: TileLayerManifest;
  sites: CoverSite[];
  /** Sea level above the reference radius, m, or null without an ocean. */
  seaLevel: number | null;
  /** The set's leaf atlas (loadLeafAtlas). */
  leaves: GPUTextureView;
}

/**
 * The leaf atlas of a material set as a texture array of its FOLIAGE_CELLS cells (sRGB, mip chain; alpha =
 * coverage, which the mips average: a spray seen small keeps its share of leaf). Without a file: one texel,
 * opaque, of the plant's own tint.
 */
export async function loadLeafAtlas(ctx: RenderContext, setId: string, file: string | null): Promise<GPUTextureView> {
  const core = coreOf(ctx);
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  if (!file) {
    const texture = core.createTextureChecked({ label: `terrain.leaves.${setId}`, format: 'rgba8unorm-srgb', size: [1, 1, FOLIAGE_CELLS], usage });
    for (let layer = 0; layer < FOLIAGE_CELLS; layer++) ctx.device.queue.writeTexture({ texture, origin: [0, 0, layer] }, new Uint8Array([137, 137, 137, 255]), {}, [1, 1, 1]);
    return texture.createView({ dimension: '2d-array' });
  }
  const res = await fetch(`${ctx.assetsUrl}/terrain/${setId}/${file}`);
  if (!res.ok) throw new Error(`terrain material set "${setId}": ${file} HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), IMAGE_DECODE_OPTIONS);
  const side = Math.round(Math.sqrt(FOLIAGE_CELLS));
  const cell = bitmap.width / side;
  if (bitmap.width !== bitmap.height || !Number.isInteger(cell) || (cell & (cell - 1)) !== 0) throw new Error(`terrain material set "${setId}": ${file} is ${bitmap.width} x ${bitmap.height}, expected ${side} x ${side} square cells of a power of two`);
  const texture = core.createTextureChecked({ label: `terrain.leaves.${setId}`, format: 'rgba8unorm-srgb', size: [cell, cell, FOLIAGE_CELLS], mipLevelCount: mipCount(cell, cell), usage });
  for (let layer = 0; layer < FOLIAGE_CELLS; layer++) {
    ctx.device.queue.copyExternalImageToTexture({ source: bitmap, origin: [(layer % side) * cell, Math.floor(layer / side) * cell] }, { texture, origin: [0, 0, layer], premultipliedAlpha: false }, [cell, cell]);
  }
  bitmap.close();
  core.mips.generate(texture);
  return texture.createView({ dimension: '2d-array' });
}

export interface CoverObserver {
  id: string;
  bodyIndex: number;
  /** Camera in the body-fixed frame, its length and direction, and the view frustum. */
  eye: Vec3;
  r: number;
  dir: Vec3;
  frustum: ViewFrustum;
}

const RECORD_FLOATS = 16;
const CHUNK_FLOATS = 8;
/** Floats of the CoverBody uniform before its table of kinds. */
const BODY_FLOATS = 36;
/**
 * Chunk origins go to the GPU relative to an anchor, a body-fixed point near the camera, and the anchor goes
 * up every frame relative to the camera: a chunk's row is written when the chunk is built, not every frame
 * (the body turns under the camera, so camera-relative rows changed every frame even at rest). The anchor
 * is moved to the camera when the camera has left it by this much, m (32-bit positions stay exact to a
 * fraction of a millimetre near the eye).
 */
const ANCHOR_REACH_M = 64;
const MAX_RECORDS = 1 << 19;
const MAX_CHUNKS = 4096;
const MAX_INSTANCES = 1 << 19;
const MAX_KINDS = 6;
/** Density of a clumped kind across its drifts: in the bare lanes and in the thick of a drift, relative to the class's own. */
const DRIFT_MIN = 0.3;
const DRIFT_MAX = 1.7;
/** A plant takes the class of the ground up to this far from where it stands, m (class boundaries are bands). */
const EDGE_REACH_M = 22;
/** Chunk builds per frame are limited by time (ms). */
const BUILD_BUDGET_MS = 0.5;
/** IDENTITY[i] = i: instance lists are runs of consecutive record indices. */
const IDENTITY = ((): Uint32Array => {
  const a = new Uint32Array(MAX_RECORDS);
  for (let i = 0; i < a.length; i++) a[i] = i;
  return a;
})();
/** A chunk built while in view fades in over this many seconds. */
const FADE_SECONDS = 0.5;
/** The eye may move this far (m) before the G-buffer lists are built again (levels of detail are chosen by size on screen; the vertex shader applies range and growth exactly every frame). */
const LIST_TOLERANCE_M = 0.02;
/** Shading modes of the fragment shader, by shape. */
const SHAPE_MODE: Record<CoverShape, number> = { tuft: 0, bush: 1, tree: 1, grove: 1, stone: 2 };
/** Shapes whose leaves are sprays of the leaf atlas: their shadows are cast through its coverage. */
const SHAPE_LEAFY: Record<CoverShape, boolean> = { tuft: false, bush: true, tree: true, grove: false, stone: false };
/**
 * An instance casts into a cascade from its finest mesh when its radius is this many texels (never: a crown's
 * shadow is as dappled from its middle level, whose sprays pass the same coverage test), from the middle one
 * from this many, and not at all below the last. Measured (perf spec, 1440p, the views among kiawe and over
 * the thickets): with 48 / 8 / 1 the cover's shadows cost 2.1 and 1.6 ms, with never / 16 / 3 they cost 0.48
 * and 0.37 ms; a tussock under six texels across leaves no shadow that a map of those texels could show.
 */
const SHADOW_FINE_TEXELS = 1e9;
const SHADOW_MIDDLE_TEXELS = 24;
const SHADOW_MIN_TEXELS = 3;
/**
 * An instance takes its finest mesh in the G-buffer when its radius spans this many pixels, the middle one
 * from this many (20: a tree 40 pixels across; below that its sprays are a few pixels each and the coarsest
 * level's larger ones show the same crown. Over the thickets the middle level of some hundreds of trees was
 * most of 5.5 million triangles a frame).
 */
const FINE_PIXELS = 55;
const MIDDLE_PIXELS = 20;

const COVER_WGSL = /* wgsl */ `
struct CoverBody {
  rot: mat3x3f,
  prevRot: mat3x3f,
  p0: vec4f,                       // material id, frame body index, leaf coverage test (1; 0 = sprays drawn whole: A/B of its cost), unused
  anchor: vec4f,                   // xyz = the body's anchor (a body-fixed point near the camera) relative to the camera (ROOT axes)
  prevAnchor: vec4f,               // the same a frame ago
  kinds: array<vec4f, ${MAX_KINDS}>, // per kind: largest range (m), range per metre of radius, shading mode (0 grass, 1 foliage, 2 stone), distance it is drawn from (m)
}
struct CoverRecord {
  pos: vec4f,      // xyz = base point relative to the chunk origin (body-fixed, m), w = footprint radius (m)
  q: vec4f,        // instance axes -> body-fixed (+Z = local up, +X = downwind)
  misc: vec4f,     // height (m), chunk slot, random number, kind
  tint: vec4f,     // rgb = linear albedo, a = unused
}
struct CoverChunk {
  origin: vec4f,      // xyz = chunk origin relative to the body's anchor (body-fixed, m), w = fade-in 0..1
  wind: vec4f,        // xyz = unit direction the wind blows towards (body-fixed), w = lean of grass (share of its height)
}
@group(2) @binding(0) var<uniform> coverBody: CoverBody;
@group(2) @binding(1) var<storage, read> coverRecords: array<CoverRecord>;
@group(2) @binding(2) var<storage, read> coverChunks: array<CoverChunk>;
@group(2) @binding(3) var<storage, read> coverInstances: array<u32>;

fn quatRotate(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

struct CoverVertex {
  fixed: vec3f,    // offset from the chunk origin (body-fixed)
  pos: vec3f,      // camera-relative
  normal: vec3f,   // body-fixed
  up: vec3f,       // local up (body-fixed)
  rec: u32,
}
fn coverVertex(position: vec3f, normal: vec3f, instance: u32) -> CoverVertex {
  let ri = coverInstances[instance];
  let r = coverRecords[ri];
  let c = coverChunks[u32(r.misc.y)];
  let kind = coverBody.kinds[u32(r.misc.w)];
  let centre = coverBody.rot * (r.pos.xyz + c.origin.xyz) + coverBody.anchor.xyz;
  let range = min(r.pos.w * kind.y, kind.x);
  let dist = length(centre);
  var grow = saturate((range - dist) / (0.3 * range)) * c.origin.w;
  if (kind.w > 0.0) { grow *= saturate((dist - 0.7 * kind.w) / (0.3 * kind.w)); }
  let scale = vec3f(r.pos.w, r.pos.w, r.misc.x);
  let local = position * scale * grow;
  var o: CoverVertex;
  o.up = quatRotate(r.q, vec3f(0.0, 0.0, 1.0));
  o.fixed = quatRotate(r.q, local) + r.pos.xyz;
  if (kind.z < 0.5) {
    // Grass bends with the prevailing wind: the higher on the blade, the further.
    o.fixed += c.wind.xyz * (c.wind.w * local.z * position.z);
  }
  o.pos = coverBody.rot * (o.fixed + c.origin.xyz) + coverBody.anchor.xyz;
  o.normal = quatRotate(r.q, normalize(normal / scale));
  o.rec = ri;
  return o;
}
`;

/**
 * Leaf sprays: the cards of shrubs and trees carry a cell of the set's leaf atlas (layer = cell; rgb = colour
 * relative to the plant's tint, linear 0.25 = the tint; a = coverage). Near the eye, where a texel spans a
 * pixel or more, a fragment shows where the coverage is above a half: the outline of every leaflet. Further
 * away a leaflet is smaller than a pixel and the coverage is a share: the fragment shows with that
 * probability, by a threshold that is fixed to the surface in cells of about a pixel (Wyman and McGuire,
 * "Hashed Alpha Testing", 2017), so the crown is a fine speckle of leaf and sky that neither swims with the
 * camera nor thins out with distance. The coarser levels of detail have fewer, larger sprays: their coverage
 * is raised, for a crown is as closed from afar as from near.
 */
const COVER_LEAF_WGSL = /* wgsl */ `
@group(2) @binding(5) var coverLeaves: texture_2d_array<f32>;

fn coverHash(cell: vec3i) -> f32 {
  let u = bitcast<vec3u>(cell);
  var h = (u.x * 0x9E3779B1u) ^ (u.y * 0x85EBCA77u) ^ (u.z * 0xC2B2AE3Du);
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return f32(h >> 8u) / 16777216.0;
}

/// A threshold in 0..1 that is uniformly distributed and fixed to the surface: 'p' = position on it (m),
/// 'dpx' / 'dpy' its screen derivatives. Two hash lattices of the powers of two around the pixel's size are
/// blended, and the blend is mapped back to a uniform distribution.
fn coverThreshold(p: vec3f, dpx: vec3f, dpy: vec3f) -> f32 {
  let rate = max(max(length(dpx), length(dpy)), 1e-6);
  let l = log2(1.0 / rate);
  let s0 = exp2(floor(l));
  let f = fract(l);
  let x = mix(coverHash(vec3i(floor(p * s0))), coverHash(vec3i(floor(p * (2.0 * s0)))), f);
  let a = min(f, 1.0 - f);
  var t = x;
  if (a > 1e-3) {
    if (x < a) { t = x * x / (2.0 * a * (1.0 - a)); }
    else if (x < 1.0 - a) { t = (x - 0.5 * a) / (1.0 - a); }
    else { t = 1.0 - (1.0 - x) * (1.0 - x) / (2.0 * a * (1.0 - a)); }
  }
  return clamp(t, 0.02, 0.98);
}

/// A fragment of a leaf spray: rgb = colour relative to the plant's tint, a = 1 where it shows, 0 where it
/// does not. 'uv' on the card (v = 0 at the foot of the spray), 'duvx' / 'duvy' its screen derivatives,
/// 'cell' of the atlas, 'lod' = level of detail of the mesh (0 finest), 'threshold' from coverThreshold.
fn coverLeaf(uv: vec2f, duvx: vec2f, duvy: vec2f, cell: f32, lod: f32, threshold: f32) -> vec4f {
  let at = vec2f(clamp(uv.x, 0.004, 0.996), 1.0 - clamp(uv.y, 0.004, 0.996));
  let t = textureSampleGrad(coverLeaves, anisoRepeat, at, i32(cell + 0.5), duvx, duvy);
  if (coverBody.p0.z < 0.5) { return vec4f(t.rgb * 4.0, 1.0); }
  let size = f32(textureDimensions(coverLeaves).x);
  let level = 0.5 * log2(max(max(dot(duvx, duvx), dot(duvy, duvy)) * size * size, 1e-12));
  let cover = saturate(t.a * (1.0 + 0.4 * lod + 0.1 * lod * lod));
  let limit = mix(0.5, threshold, smoothstep(-0.5, 1.0, level));
  return vec4f(t.rgb * 4.0, select(0.0, 1.0, cover >= limit));
}
`;

const COVER_GBUFFER_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"
${COVER_WGSL}
${COVER_LEAF_WGSL}
@group(2) @binding(4) var coverNoise: texture_3d<f32>;

struct CoverVaryings {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) currClip: vec4f,
  @location(2) prevClip: vec4f,
  @location(3) @interpolate(flat) rec: u32,
  @location(4) model: vec3f,
  @location(5) fixed: vec3f,
  @location(6) extra: vec2f,
  @location(7) up: vec3f,
  @location(8) uv: vec2f,
  @location(9) aux: vec2f,
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) extra: vec2f, @location(3) uv: vec2f, @location(4) aux: vec2f, @builtin(instance_index) instance: u32) -> CoverVaryings {
  let v = coverVertex(position, normal, instance);
  let r = coverRecords[v.rec];
  let c = coverChunks[u32(r.misc.y)];
  var o: CoverVaryings;
  o.position = frame.viewProj * vec4f(v.pos, 1.0);
  o.normal = v.normal;
  o.currClip = frame.viewProjUnjittered * vec4f(v.pos, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(coverBody.prevRot * (v.fixed + c.origin.xyz) + coverBody.prevAnchor.xyz, 1.0);
  o.rec = v.rec;
  o.model = position;
  o.fixed = v.fixed;
  o.extra = extra;
  o.up = v.up;
  o.uv = uv;
  o.aux = aux;
  return o;
}

@fragment fn fs(in: CoverVaryings, @builtin(front_facing) front: bool) -> GBufferOut {
  let r = coverRecords[in.rec];
  let mode = coverBody.kinds[u32(r.misc.w)].z;
  // The face normal from the position (taken here, in uniform control flow, like every other derivative).
  let dfx = dpdx(in.fixed);
  let dfy = dpdy(in.fixed);
  var face = cross(dfx, dfy);
  let fl = length(face);
  var nv = normalize(in.normal);
  if (fl > 0.0) { face /= fl; } else { face = nv; }
  let up = normalize(in.up);
  let seed = r.misc.z;
  let duvx = dpdx(in.uv);
  let duvy = dpdy(in.uv);
  let threshold = coverThreshold(in.fixed, dfx, dfy);
  // Bark (wood only; uv = ridges around the stem, length along it in ridge widths): ridges that wander along
  // the stem between furrows, broken across into plates. Every term is zero where it wraps.
  let barkU = in.uv.x + 0.22 * sin(0.9 * in.uv.y + 6.2832 * in.aux.y) + 0.1 * sin(2.3 * in.uv.y + 1.7);
  let barkX = fract(barkU);
  let barkC = fract(0.31 * in.uv.y + 0.5 * floor(barkU));
  let bark = smoothstep(0.0, 0.5, 1.0 - abs(2.0 * barkX - 1.0)) * mix(0.55, 1.0, smoothstep(0.0, 0.16, min(barkC, 1.0 - barkC)));
  let dbx = dpdx(bark);
  let dby = dpdy(bark);
  // Two octaves of noise fixed to the ground, in metres: leaves and the gaps between them (cells of 12 and
  // 4 cm), the grain of a stone (cells of 3 and 1 cm).
  let cells = select(8.0, 34.0, mode > 1.5);
  let q = in.fixed * cells + vec3f(seed * 37.0, seed * 11.0, seed * 5.0);
  let n1 = textureSampleLevel(coverNoise, linearRepeat, q / 16.0, 0.0);
  let n2 = textureSampleLevel(coverNoise, linearRepeat, q.zxy * (2.9 / 16.0) + vec3f(0.31, 0.57, 0.11), 0.0);
  let lumps = (n1.a * 2.0 - 1.0) * 0.6 + (n2.a * 2.0 - 1.0) * 0.4;
  let h = saturate(in.extra.x);
  var albedo = r.tint.rgb;
  var n = nv;
  var ao = 1.0;
  var rough = 0.8;
  var shade = 0.0;
  // Share of the light that falls on the far side of a leaf or a blade and comes through it (G-buffer
  // metallic of MATERIAL_TERRAIN, read by this package's brdf_terrain; nothing here is metal).
  var through = 0.0;
  if (mode < 0.5) {
    through = 0.3;
    // Grass: blades are lit from both sides; their normals lean towards the vertical, so a tussock shades
    // as a soft mass and not as a hundred mirrors. Dark at the base, pale and dry towards the tips.
    if (!front) { nv = -nv; }
    n = normalize(mix(nv, up, 0.6));
    albedo *= mix(0.45, 1.2, h) * (0.8 + 0.4 * in.extra.y);
    albedo = mix(albedo, albedo * vec3f(1.25, 1.1, 0.8), h * 0.6);
    ao = mix(0.35, 1.0, smoothstep(0.0, 0.6, h));
    shade = 0.55 * (1.0 - h) * (1.0 - h);
    // Dry blades are matt: a glossier tussock lit from behind turned into a white tuft against the light.
    rough = 0.92;
  } else if (mode < 1.5) {
    if (in.extra.y > 1.5) {
      // Wood: furrowed bark, grey-brown, darker in the furrows, weathered pale in patches; the furrows are
      // relief (the bark's height turned into a normal through its screen derivatives).
      let depthM = 0.2 * 6.2832 * in.aux.x * r.pos.w / 6.0;
      let r1 = cross(dfy, nv);
      let r2 = cross(nv, dfx);
      let det = dot(dfx, r1);
      n = nv;
      if (abs(det) > 1e-12) { n = normalize(abs(det) * nv - depthM * sign(det) * (dbx * r1 + dby * r2)); }
      n = normalize(n + (n1.rgb * 2.0 - 1.0) * 0.2);
      albedo = vec3f(0.082, 0.066, 0.052) * mix(0.45, 1.2, bark) * (0.85 + 0.3 * n1.a);
      albedo = mix(albedo, vec3f(0.115, 0.108, 0.098) * (0.7 + 0.5 * bark), 0.4 * saturate(n2.a * 1.6 - 0.3));
      rough = 0.92;
      ao = mix(0.45, 1.0, bark) * 0.85;
    } else if (in.aux.x > -0.5) {
      // A spray of leaves: a card of the leaf atlas. Its normal is the crown's (the vertex normal leans away
      // from the crown's middle, the same from both sides of the card); sprays deep in the crown are in its shade.
      let depth = saturate(in.extra.y);
      let leaf = coverLeaf(in.uv, duvx, duvy, in.aux.x, floor(in.aux.y), threshold);
      if (leaf.a < 0.5) { discard; }
      n = normalize(nv + (n1.rgb * 2.0 - 1.0) * 0.45);
      albedo *= leaf.rgb * (0.8 + 0.4 * fract(in.aux.y)) * mix(0.62, 1.1, h) * mix(0.6, 1.0, depth);
      ao = mix(0.4, 1.0, h) * mix(0.5, 1.0, depth);
      shade = 0.5 * (1.0 - depth);
      // (Leaves of a dry coast are matt: with a gloss the crowns looked frosted against the light.)
      rough = 0.88;
      through = 0.6;
    } else {
      // Leaf clusters of a stand of trees: gaps between the leaves when the stand is large on screen (not
      // from afar, where a gap is less than a pixel and the cluster is its mean); clusters deep in the crown
      // are in its shade.
      let depth = saturate(in.extra.y);
      let holes = smoothstep(0.006, 0.02, r.pos.w / max(in.currClip.w, 1e-3));
      if (lumps < mix(-2.0, -0.07, holes)) { discard; }
      if (!front) { nv = -nv; }
      n = normalize(nv + (n1.rgb * 2.0 - 1.0) * 0.5);
      albedo *= (0.72 + 0.6 * saturate(lumps + 0.45)) * mix(0.6, 1.1, h) * mix(0.6, 1.0, depth);
      ao = mix(0.35, 1.0, h) * mix(0.5, 1.0, depth);
      shade = 0.5 * (1.0 - depth);
      rough = 0.7;
      through = 0.3;
    }
  } else {
    // A loose piece of clinker: broken faces (a share of the facets kept), a rough, pitted skin (two
    // octaves of grain in the normal and the tone), shade in its hollows and at its foot.
    if (dot(face, nv) < 0.0) { face = -face; }
    n = normalize(mix(nv, face, 0.45) + (n1.rgb * 2.0 - 1.0) * 0.6 + (n2.rgb * 2.0 - 1.0) * 0.35);
    let cavity = saturate(in.extra.y);
    albedo *= (0.6 + 0.8 * saturate(0.5 + 0.9 * lumps)) * mix(0.6, 1.0, cavity);
    ao = mix(0.4, 1.0, saturate(in.model.z / 0.6)) * mix(0.55, 1.0, cavity) * (0.75 + 0.25 * n2.a);
    rough = 0.95;
  }
  albedo = clamp(albedo, vec3f(0.0), vec3f(1.0));
  var packed = gbufferPack(albedo, ao, coverBody.rot * n, rough, through, u32(coverBody.p0.x), 0.0, velocityFromClip(in.currClip, in.prevClip), vec3f(0.0));
  // RT4.b: the share of the sun the plant keeps off its own inside (shaders/lighting.ts).
  packed.extra.b = shade;
  return packed;
}
`;

const COVER_SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${COVER_WGSL}
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
  let v = coverVertex(position, normal, instance);
  return shadowPass.viewProj * vec4f(v.pos, 1.0);
}
`;

/**
 * The shadow pass of shrubs and trees: the leaf sprays cast through the same coverage test as the G-buffer
 * pass (a crown's shadow is dappled, not the outline of its cards); wood casts whole.
 */
const COVER_LEAF_SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${COVER_WGSL}
${COVER_LEAF_WGSL}
struct LeafShadowVaryings {
  @builtin(position) position: vec4f,
  @location(0) fixed: vec3f,
  @location(1) uv: vec2f,
  @location(2) part: vec3f,
}
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) extra: vec2f, @location(3) uv: vec2f, @location(4) aux: vec2f, @builtin(instance_index) instance: u32) -> LeafShadowVaryings {
  let v = coverVertex(position, normal, instance);
  var o: LeafShadowVaryings;
  o.position = shadowPass.viewProj * vec4f(v.pos, 1.0);
  o.fixed = v.fixed;
  o.uv = uv;
  o.part = vec3f(extra.y, aux);
  return o;
}
@fragment fn fs(in: LeafShadowVaryings) {
  let dfx = dpdx(in.fixed);
  let dfy = dpdy(in.fixed);
  let duvx = dpdx(in.uv);
  let duvy = dpdy(in.uv);
  let threshold = coverThreshold(in.fixed, dfx, dfy);
  if (in.part.x < 1.5 && in.part.y > -0.5) {
    if (coverLeaf(in.uv, duvx, duvy, in.part.y, floor(in.part.z), threshold).a < 0.5) { discard; }
  }
}
`;

interface Chunk {
  key: TileKey;
  id: number;
  centre: Vec3;
  /** Chunk origin in the body-fixed frame (float64). */
  origin: Vec3;
  /** Half diagonal of the chunk on the ground plus the largest instance, m. */
  reach: number;
  data: Float32Array;
  count: number;
  /** The instances' radii in the order of `data` (by variant, largest first within a variant). */
  radii: Float32Array;
  variantStart: Int32Array;
  maxRadius: number;
  built: boolean;
  /** Offset of the chunk's instances in the GPU record buffer (-1: the buffer was full). */
  base: number;
  slot: number;
  /** Distance from the camera to the nearest point of the chunk this frame, m; in view; when it was built (feature clock, s). */
  near: number;
  visible: boolean;
  born: number;
  lastUsed: number;
  /** Ends of the listed prefixes per variant (for the shadow lists). */
  listEnd: Int32Array;
  listed: boolean;
  /** What the chunk's row on the GPU was written with: the anchor's version and the fade-in (-1: never). */
  rowAnchor: number;
  rowFade: number;
}

interface Tier {
  kind: CoverKindDef;
  kindIndex: number;
  shape: number;
  chunkLevel: number;
  chunkSize: number;
  maxDensity: number;
  /** Density per class id. */
  density: Float32Array;
  chunks: Map<number, Chunk>;
  wanted: Chunk[];
  scanned: Vec3 | null;
  rangePerRadius: number;
}

interface CoverBody {
  info: CoverBodyInfo;
  tiers: Tier[];
  uniform: GPUBuffer;
  group: GPUBindGroup;
  land: LandcoverCache;
  loaded: { centre: Vec3; radius: number } | null;
  loading: boolean;
  active: boolean;
  bodyIndex: number;
  rot: Mat3;
  prevRot: Mat3;
  centre: Vec3;
  prevCentre: Vec3;
  /** Instance ranges of this frame per (shape, variant, lod): start, count. */
  draws: Int32Array;
  empty: boolean;
  /** Wind direction (body-fixed) is a tangent vector: it is taken at the camera. */
  wind: Vec3;
  /** The camera in the body-fixed frame, this frame. */
  eye: Vec3;
  /** The G-buffer lists of the last build: what they were built from (signature of the listed chunks, eye, pixel scale) and where they lie in the instance buffer. */
  list: { sig: number; eye: Vec3; pixelAngle: number; start: number; count: number; triangles: number } | null;
  /** The anchor (body-fixed, m), a counter of its moves, and where it is relative to the camera now and a frame ago (ROOT axes). */
  anchor: Vec3 | null;
  anchorVersion: number;
  anchorRel: Vec3;
  prevAnchorRel: Vec3;
  /** This frame's observer of the body (null: the body is out of range). */
  observer: CoverObserver | null;
  ground: number;
  /**
   * The view the body was last worked through for, when that left nothing to do (every chunk built and faded
   * in): while the camera stands in it, the chunks, their rows and the lists are as they are, and a frame
   * costs the uniform only.
   */
  rest: { eye: Vec3; planes: Vec3[]; pixelAngle: number; empty: boolean } | null;
  /** This frame was not worked through (the view rests): the lists are those of `rest`. */
  resting: boolean;
  /**
   * The shadow lists of the cascades as they were last built while the view rested, by cascade index: kept
   * while `rest` is the same, the same chunks lie inside the cascade and its texel is the same (at rest the
   * lists were built again for every cascade that rendered, every frame: 0.4 ms on the pad).
   */
  shadowLists: Map<number, { rest: object; sig: number; chunks: number; texel: number; data: Uint32Array; ranges: Int32Array }>;
}

/** Land-cover classes of a body's deepest baked level around the camera, decoded on the main thread. */
class LandcoverCache {
  private readonly tiles = new Map<number, Uint8Array | null>();
  private readonly loading = new Set<number>();
  private readonly deepest: number;
  private lastId = -1;
  private lastData: Uint8Array | null = null;
  pending = 0;

  constructor(
    private readonly source: TileSource,
    private readonly tileset: string,
    private readonly layer: TileLayerManifest,
    private readonly onError: (message: string) => void,
  ) {
    this.deepest = Math.max(layer.globalMaxLevel, ...Object.keys(layer.coverage).map(Number));
  }

  /** Class id at a direction; -1 while the tile that holds it is on its way. */
  classAt(dir: Vec3): number {
    const want = dirToTile(dir, this.deepest);
    const key = deepestAvailable(this.layer, want.key);
    const at = key.level === want.key.level ? want : dirToTile(dir, key.level);
    const id = tileId(key.face, key.level, key.x, key.y);
    let data: Uint8Array | null | undefined;
    if (id === this.lastId) data = this.lastData;
    else {
      data = this.tiles.get(id);
      if (data === undefined) {
        this.request(id, key);
        return -1;
      }
      this.lastId = id;
      this.lastData = data;
    }
    if (!data) return LANDCOVER_CLASS.unknown;
    const x = Math.min(255, Math.floor(at.u * 256));
    const y = Math.min(255, Math.floor(at.v * 256));
    return data[y * 256 + x]!;
  }

  private request(id: number, key: TileKey): void {
    if (this.loading.has(id)) return;
    this.loading.add(id);
    this.pending++;
    const done = (data: Uint8Array | null): void => {
      this.tiles.set(id, data);
      this.loading.delete(id);
      this.pending--;
    };
    this.source
      .tile(this.tileset, TILE_LAYER.landcover, key)
      .then(async (bytes) => {
        if (!bytes) return done(null);
        const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
        const tile = decodeFrt1(new Uint8Array(await new Response(stream).arrayBuffer()));
        done(tile.kind === 'u8' && tile.width === 256 && tile.height === 256 ? tile.data : null);
      })
      .catch((e: unknown) => {
        done(null);
        this.onError(`terrain cover: land cover ${key.face}/${key.level}/${key.x}/${key.y}: ${e instanceof Error ? e.message : String(e)}`);
      });
  }
}

/** Smooth value noise of a position, 0..1. */
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1;
    const oy = (c >> 1) & 1;
    const oz = c >> 2;
    v += hashToUnit(hash4(ix + ox, iy + oy, iz + oz, seed)) * (ox ? sx : 1 - sx) * (oy ? sy : 1 - sy) * (oz ? sz : 1 - sz);
  }
  return v;
}

interface MeshBuffers {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

const BUCKETS = COVER_SHAPES.length * COVER_VARIANTS * COVER_LODS;

export class CoverRenderer {
  private readonly device: GPUDevice;
  private readonly bodies: CoverBody[] = [];
  private readonly meshes: MeshBuffers[] = [];
  private readonly gbuffer: Tracked<GPURenderPipeline>;
  private readonly shadow: Tracked<GPURenderPipeline>;
  private readonly leafShadow: Tracked<GPURenderPipeline>;
  private readonly layout: GPUBindGroupLayout;
  private readonly emptyGroup: GPUBindGroup;
  private readonly recordBuffer: GPUBuffer;
  private readonly chunkBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly recordData = new Float32Array(MAX_RECORDS * RECORD_FLOATS);
  private readonly chunkData = new Float32Array(MAX_CHUNKS * CHUNK_FLOATS);
  private readonly instances = new Uint32Array(MAX_INSTANCES);
  private bucketData: Uint32Array<ArrayBuffer>[] = Array.from({ length: BUCKETS }, () => new Uint32Array(1024));
  private readonly bucketCount = new Int32Array(BUCKETS);
  private readonly shadowRanges = new Int32Array(BUCKETS * 2);
  private readonly uniformData = new Float32Array(BODY_FLOATS + MAX_KINDS * 4);
  /** Rows of chunkData that differ from the GPU's: first and last slot. */
  private chunkDirty: [number, number] = [Infinity, -1];
  private readonly freeSlots: number[] = Array.from({ length: MAX_CHUNKS }, (_, i) => MAX_CHUNKS - 1 - i);
  private instanceCount = 0;
  /** The CPU copy of the instance lists differs from the GPU's in [0, instanceCount) this frame. */
  private instancesDirty = false;
  private triangles = 0;
  /** Records in use at the front of the record buffer (chunks are appended; holes are closed by compact()). */
  private used = 0;
  private overflow = false;
  private unbuilt = 0;
  private fading = 0;
  private clock = 0;
  private frameIndex = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly provider: TerrainAuthority,
    source: TileSource,
    noiseView: GPUTextureView,
    infos: CoverBodyInfo[],
  ) {
    const device = (this.device = ctx.device);
    const core = coreOf(ctx);
    for (const shape of COVER_SHAPES) {
      for (let variant = 0; variant < COVER_VARIANTS; variant++) {
        for (let lod = 0; lod < COVER_LODS; lod++) {
          const m = buildCoverMesh(shape, variant, lod);
          const vertexBuffer = device.createBuffer({ label: `terrain.cover.${shape}.${variant}.${lod}`, size: m.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(vertexBuffer, 0, m.vertices);
          const padded = m.indices.length % 2 === 0 ? m.indices : new Uint16Array(m.indices.length + 1);
          if (padded !== m.indices) padded.set(m.indices);
          const indexBuffer = device.createBuffer({ label: `terrain.cover.${shape}.${variant}.${lod}.i`, size: padded.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(indexBuffer, 0, padded);
          this.meshes.push({ vertexBuffer, indexBuffer, indexCount: m.indices.length });
        }
      }
    }
    this.recordBuffer = device.createBuffer({ label: 'terrain.cover.records', size: this.recordData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.chunkBuffer = device.createBuffer({ label: 'terrain.cover.chunks', size: this.chunkData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.instanceBuffer = device.createBuffer({ label: 'terrain.cover.instances', size: this.instances.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'terrain.cover',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      ],
    });
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: COVER_VERTEX_FLOATS * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'float32x2' },
        { shaderLocation: 4, offset: 40, format: 'float32x2' },
      ],
    };
    const emptyLayout = device.createBindGroupLayout({ label: 'terrain.cover.empty', entries: [] });
    this.emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] });
    this.gbuffer = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('terrain.cover.gbuffer', COVER_GBUFFER_WGSL);
      return device.createRenderPipeline({
        label: 'terrain.cover.gbuffer',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, emptyLayout, this.layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            { format: RENDER_FORMATS.gbufferAlbedo },
            { format: RENDER_FORMATS.gbufferNormal },
            { format: RENDER_FORMATS.gbufferMaterial },
            { format: RENDER_FORMATS.gbufferVelocity },
            { format: RENDER_FORMATS.gbufferExtra },
            { format: RENDER_FORMATS.hdr },
          ],
        },
        // Blades and the shells of a crown are seen from both sides.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
      });
    });
    this.shadow = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('terrain.cover.shadow', COVER_SHADOW_WGSL);
      return device.createRenderPipeline({
        label: 'terrain.cover.shadow',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, core.shadowPassLayout, this.layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
        depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      });
    });
    this.leafShadow = core.shaders.tracked(() => {
      const module = ctx.shaders.createModule('terrain.cover.leafShadow', COVER_LEAF_SHADOW_WGSL);
      return device.createRenderPipeline({
        label: 'terrain.cover.leafShadow',
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, core.shadowPassLayout, this.layout] }),
        vertex: { module, entryPoint: 'vs', buffers: [vertexLayout] },
        fragment: { module, entryPoint: 'fs', targets: [] },
        primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
        depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      });
    });

    const classNames = Object.keys(LANDCOVER_CLASS) as (keyof typeof LANDCOVER_CLASS)[];
    for (const info of infos) {
      if (info.cover.kinds.length > MAX_KINDS) throw new Error(`terrain cover of "${info.id}": ${info.cover.kinds.length} kinds, at most ${MAX_KINDS}`);
      const faceSize = (Math.PI * info.def.radius) / 2;
      const tiers: Tier[] = info.cover.kinds.map((kind, kindIndex) => {
        const shape = COVER_SHAPES.indexOf(kind.shape);
        if (shape < 0) throw new Error(`terrain cover of "${info.id}": kind "${kind.id}" has no shape "${String(kind.shape)}"`);
        const chunkLevel = Math.max(0, Math.round(Math.log2(faceSize / kind.chunkM)));
        const density = new Float32Array(16);
        for (const name of classNames) density[LANDCOVER_CLASS[name]] = info.cover.classDensity[name]?.[kind.id] ?? 0;
        return { kind, kindIndex, shape, chunkLevel, chunkSize: faceSize / 2 ** chunkLevel, maxDensity: Math.max(...density), density, chunks: new Map(), wanted: [], scanned: null, rangePerRadius: 0 };
      });
      const uniform = device.createBuffer({ label: `terrain.cover.body.${info.id}`, size: this.uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        label: `terrain.cover.${info.id}`,
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.recordBuffer } },
          { binding: 2, resource: { buffer: this.chunkBuffer } },
          { binding: 3, resource: { buffer: this.instanceBuffer } },
          { binding: 4, resource: noiseView },
          { binding: 5, resource: info.leaves },
        ],
      });
      this.bodies.push({
        info,
        tiers,
        uniform,
        group,
        land: new LandcoverCache(source, info.tileset, info.landcover, (m) => core.reportError(m)),
        loaded: null,
        loading: false,
        active: false,
        bodyIndex: 0,
        rot: mat3.identity(),
        prevRot: mat3.identity(),
        centre: v3.zero(),
        prevCentre: v3.zero(),
        draws: new Int32Array(BUCKETS * 2),
        empty: true,
        wind: { x: 1, y: 0, z: 0 },
        eye: v3.zero(),
        list: null,
        anchor: null,
        anchorVersion: 0,
        anchorRel: v3.zero(),
        prevAnchorRel: v3.zero(),
        observer: null,
        ground: 0,
        rest: null,
        resting: false,
        shadowLists: new Map(),
      });
    }
  }

  /** The renderer's pipelines, for the feature to have them created ahead (`shaders.warm`). */
  pipelines(): Tracked<unknown>[] {
    return [this.gbuffer, this.shadow, this.leafShadow];
  }

  /**
   * The instance of a kind that stands nearest to a point of the ground (body-fixed, m), among the chunks
   * that are built: where it stands, its footprint radius and its height. For specs that want a camera
   * beside a plant (TerrainDebug.nearestCover).
   */
  nearest(bodyId: string, kindId: string, point: Vec3): { position: Vec3; radius: number; height: number; distance: number } | null {
    const b = this.bodies.find((x) => x.info.id === bodyId);
    const tier = b?.tiers.find((t) => t.kind.id === kindId);
    if (!tier) return null;
    let best: { position: Vec3; radius: number; height: number; distance: number } | null = null;
    for (const c of tier.chunks.values()) {
      if (!c.built) continue;
      for (let i = 0; i < c.count; i++) {
        const k = i * RECORD_FLOATS;
        const position = { x: c.origin.x + c.data[k]!, y: c.origin.y + c.data[k + 1]!, z: c.origin.z + c.data[k + 2]! };
        const distance = v3.dist(position, point);
        if (!best || distance < best.distance) best = { position, radius: c.data[k + 3]!, height: c.data[k + 8]!, distance };
      }
    }
    return best;
  }

  /** Switches for measurements (TerrainDebug.setCoverOptions): what each part of the cover costs. Never used by the app. */
  private options: CoverOptions = { kinds: null, shadows: true, leafTest: true, shadowFineTexels: SHADOW_FINE_TEXELS, shadowMiddleTexels: SHADOW_MIDDLE_TEXELS, shadowMinTexels: SHADOW_MIN_TEXELS, finePixels: FINE_PIXELS, middlePixels: MIDDLE_PIXELS };
  /** Scratch of drawShadow: the chunks inside the cascade and their tiers. */
  private readonly shadowChunks: Chunk[] = [];
  private readonly shadowTiers: Tier[] = [];

  setOptions(o: Partial<CoverOptions>): void {
    this.options = { ...this.options, ...o };
    for (const b of this.bodies) {
      b.rest = null;
      b.list = null;
      for (const tier of b.tiers) tier.scanned = null;
    }
  }

  /** Scatter a chunk's instances. Returns false while the land cover under it is still loading. */
  private buildChunk(b: CoverBody, tier: Tier, c: Chunk): boolean {
    const info = b.info;
    const id = info.id;
    const R = info.def.radius;
    const kind = tier.kind;
    const area = tier.chunkSize * tier.chunkSize;
    const sea = info.seaLevel;
    // The densest class under the chunk (looked up on a 9 x 9 grid; the land cover must be there before
    // anything is placed): candidates are scattered for that density, so a chunk of bare ground costs
    // next to nothing.
    let densest = 0;
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const cls = b.land.classAt(tileUvToDir(c.key, i / 8, j / 8));
        if (cls < 0) return false;
        densest = Math.max(densest, tier.density[cls]!);
      }
    }
    const ceiling = densest * (1 + kind.clump) * (kind.clump > 0 ? DRIFT_MAX : 1);
    const candidates = Math.ceil(area * ceiling);
    // Where two classes meet, each thins out into the other over some tens of metres (the class of a plant
    // is looked up a random step away from where it stands), as the ground's materials do.
    const reachDir = EDGE_REACH_M / R;
    const found: { data: number[]; radius: number; variant: number }[] = [];
    const [r0, r1] = kind.radiusM;
    const seed = hash4(c.key.face, c.key.x, c.key.y, 0x0c07e4 + tier.kindIndex);
    for (let i = 0; i < candidates; i++) {
      const h = hash4(i, seed, 1, 0);
      const dir = tileUvToDir(c.key, hashToUnit(h), hashToUnit(hash4(i, seed, 2, 0)));
      const jx = (hashToUnit(hash4(i, seed, 11, 0)) - 0.5) * 2 * reachDir;
      const jy = (hashToUnit(hash4(i, seed, 12, 0)) - 0.5) * 2 * reachDir;
      const jz = (hashToUnit(hash4(i, seed, 13, 0)) - 0.5) * 2 * reachDir;
      const cls = b.land.classAt({ x: dir.x + jx, y: dir.y + jy, z: dir.z + jz });
      if (cls < 0) return false;
      let density = tier.density[cls]!;
      if (density <= 0) continue;
      const px = dir.x * R;
      const py = dir.y * R;
      const pz = dir.z * R;
      if (kind.clump > 0) {
        const n = valueNoise(px / kind.clumpM, py / kind.clumpM, pz / kind.clumpM, 0x1234 + tier.kindIndex);
        const t = Math.min(1, Math.max(0, (n - 0.35) / 0.3));
        density *= 1 - kind.clump + kind.clump * 2 * t * t * (3 - 2 * t);
        // Drifts and bare lanes at four times the size of the clumps: cover is never evenly sprinkled.
        const wide = valueNoise(px / (4.3 * kind.clumpM), py / (4.3 * kind.clumpM), pz / (4.3 * kind.clumpM), 0x4321 + tier.kindIndex);
        const d = Math.min(1, Math.max(0, (wide - 0.3) / 0.4));
        density *= DRIFT_MIN + (DRIFT_MAX - DRIFT_MIN) * d * d * (3 - 2 * d);
      }
      if (hashToUnit(hash4(i, seed, 3, 0)) * ceiling >= density) continue;
      // Nothing grows or lies on a launch site's concrete and gravel, and little beside it.
      let blocked = false;
      for (const site of info.sites) {
        const dx = px - site.centre.x;
        const dy = py - site.centre.y;
        const dz = pz - site.centre.z;
        const e = dx * site.east.x + dy * site.east.y + dz * site.east.z;
        const n = dx * site.north.x + dy * site.north.y + dz * site.north.z;
        if (Math.hypot(e, n) > site.plan.reach + 10) continue;
        const g = siteGround(site.plan, e, n).gravel;
        // (The gravel's ragged edge reaches 0.7 shoulder widths beyond its nominal line.)
        if (g < 0.7 * site.plan.shoulder + 0.5 || hashToUnit(hash4(i, seed, 4, 0)) > (g - 0.7 * site.plan.shoulder) / 12) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const u1 = hashToUnit(hash4(i, seed, 5, 0));
      const u2 = hashToUnit(hash4(i, seed, 6, 0));
      const u3 = hashToUnit(hash4(i, seed, 7, 0));
      const u4 = hashToUnit(hash4(i, seed, 8, 0));
      // Small ones are the many.
      const radius = r0 * Math.pow(r1 / r0, u1 * u1);
      const height = this.provider.heightAt(id, dir, Math.max(0.4, radius));
      if (sea !== null && height < sea + 0.6) continue;
      const tall = radius * (kind.heightPerRadius[0] + (kind.heightPerRadius[1] - kind.heightPerRadius[0]) * u2);
      // Axes: +Z up, turned so that +X points downwind (shrubs and trees are wind-shaped; grass and stones any way).
      const up = quat.fromTo({ x: 0, y: 0, z: 1 }, dir);
      let yaw = u3 * 2 * Math.PI;
      if (kind.shape === 'bush' || kind.shape === 'tree' || kind.shape === 'grove') {
        const tx = quat.rotate(up, { x: 1, y: 0, z: 0 });
        const ty = quat.rotate(up, { x: 0, y: 1, z: 0 });
        yaw = Math.atan2(v3.dot(b.wind, ty), v3.dot(b.wind, tx)) + (u3 - 0.5) * 0.9;
      }
      const tilt = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, (u4 - 0.5) * (kind.shape === 'stone' ? 1.1 : 0.25));
      const q = quat.mul(up, quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, yaw), tilt));
      // Stones sit a third in the ground; plants start a little below it (the ground under them is not flat).
      const sink = kind.shape === 'stone' ? 0 : 0.06 * tall;
      const base = v3.scale(dir, R + height - sink);
      // Colour: between the kind's tint and its dry tint, by patches of the ground and by the plant.
      const dryPatch = valueNoise(px / 37, py / 37, pz / 37, 0x77);
      const dry = Math.min(1, Math.max(0, 0.7 * dryPatch + 0.6 * u4 - 0.15));
      const shade = 0.82 + 0.36 * hashToUnit(hash4(i, seed, 9, 0));
      const variant = (hash4(i, seed, 10, 0) >>> 0) % COVER_VARIANTS;
      found.push({
        radius,
        variant,
        data: [
          base.x - c.origin.x, base.y - c.origin.y, base.z - c.origin.z, radius,
          q.x, q.y, q.z, q.w,
          tall, c.slot, u2, tier.kindIndex,
          (kind.tint[0] + (kind.tintDry[0] - kind.tint[0]) * dry) * shade, (kind.tint[1] + (kind.tintDry[1] - kind.tint[1]) * dry) * shade, (kind.tint[2] + (kind.tintDry[2] - kind.tint[2]) * dry) * shade, 0,
        ],
      });
    }
    found.sort((p, q) => p.variant - q.variant || q.radius - p.radius);
    c.data = new Float32Array(found.length * RECORD_FLOATS);
    c.radii = new Float32Array(found.length);
    c.variantStart.fill(found.length);
    found.forEach((f, n) => {
      for (let v = f.variant; v >= 0 && c.variantStart[v]! > n; v--) c.variantStart[v] = n;
      c.data.set(f.data, n * RECORD_FLOATS);
      c.radii[n] = f.radius;
    });
    c.count = found.length;
    c.maxRadius = found.reduce((m, f) => Math.max(m, f.radius), 0);
    c.built = true;
    c.born = this.clock;
    this.place(c);
    return true;
  }

  /** Give a built chunk its place in the GPU record buffer: appended, after closing the holes when the end is reached. */
  private place(c: Chunk): void {
    if (c.count === 0) {
      c.base = 0;
      return;
    }
    if (this.used + c.count > MAX_RECORDS) this.compact();
    if (this.used + c.count > MAX_RECORDS) {
      if (!this.overflow) {
        this.overflow = true;
        coreOf(this.ctx).reportError('terrain cover: instance buffer is full; some ground cover is missing');
      }
      c.base = -1;
      return;
    }
    c.base = this.used;
    this.recordData.set(c.data, this.used * RECORD_FLOATS);
    this.device.queue.writeBuffer(this.recordBuffer, this.used * RECORD_FLOATS * 4, this.recordData, this.used * RECORD_FLOATS, c.count * RECORD_FLOATS);
    this.used += c.count;
  }

  /** Drop every chunk that is out of range now and lay the others out again from the front of the buffer. */
  private compact(): void {
    let n = 0;
    for (const b of this.bodies) {
      for (const tier of b.tiers) {
        for (const [id, c] of tier.chunks) {
          if (c.lastUsed !== this.frameIndex && !tier.wanted.includes(c)) {
            tier.chunks.delete(id);
            this.freeSlots.push(c.slot);
            continue;
          }
          if (!c.built || c.count === 0) continue;
          if (n + c.count > MAX_RECORDS) {
            c.base = -1;
            continue;
          }
          c.base = n;
          this.recordData.set(c.data, n * RECORD_FLOATS);
          n += c.count;
        }
      }
    }
    this.used = n;
    if (n > 0) this.device.queue.writeBuffer(this.recordBuffer, 0, this.recordData, 0, n * RECORD_FLOATS);
  }

  /** The chunks of a tier within range of the camera. */
  private scan(b: CoverBody, tier: Tier, o: CoverObserver, ground: number): void {
    const R = b.info.def.radius;
    const range = tier.kind.rangeM;
    tier.wanted.length = 0;
    tier.scanned = v3.clone(o.eye);
    if (tier.maxDensity <= 0 || o.r - R - ground > range) return;
    const east = v3.normalize(v3.cross(Math.abs(o.dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, o.dir));
    const north = v3.cross(o.dir, east);
    const step = 0.5 * tier.chunkSize;
    const steps = Math.ceil((range + tier.chunkSize) / step);
    const seen = new Set<number>();
    for (let j = -steps; j <= steps; j++) {
      for (let i = -steps; i <= steps; i++) {
        if (Math.hypot(i, j) * step > range + 2 * tier.chunkSize) continue;
        const dir = v3.normalize(v3.add(v3.scale(o.dir, R), v3.add(v3.scale(east, i * step), v3.scale(north, j * step))));
        const key = dirToTile(dir, tier.chunkLevel).key;
        const id = tileId(key.face, key.level, key.x, key.y);
        if (seen.has(id)) continue;
        seen.add(id);
        let c = tier.chunks.get(id);
        if (!c) {
          const slot = this.freeSlots.pop();
          if (slot === undefined) continue;
          const centre = tileUvToDir(key, 0.5, 0.5);
          c = {
            key,
            id,
            centre,
            origin: v3.scale(centre, R + this.provider.heightAt(b.info.id, centre, 20)),
            reach: 0.75 * tier.chunkSize * 1.3 + tier.kind.radiusM[1] * Math.max(1, tier.kind.heightPerRadius[1]),
            data: new Float32Array(0),
            count: 0,
            radii: new Float32Array(0),
            variantStart: new Int32Array(COVER_VARIANTS + 1),
            maxRadius: 0,
            built: false,
            base: -1,
            slot,
            near: 0,
            visible: false,
            born: 0,
            lastUsed: -1,
            listEnd: new Int32Array(COVER_VARIANTS),
            listed: false,
            rowAnchor: -1,
            rowFade: -1,
          };
          tier.chunks.set(id, c);
        }
        tier.wanted.push(c);
      }
    }
  }

  prepare(frame: FrameContext, observers: readonly CoverObserver[]): void {
    this.frameIndex = frame.frameIndex;
    this.clock += frame.realDt;
    this.instanceCount = 0;
    this.triangles = 0;
    this.unbuilt = 0;
    this.fading = 0;
    const t0 = performance.now();
    const pixelAngle = (2 * Math.tan(frame.camera.fovY / 2)) / frame.renderSize[1];
    // Which bodies are in range, and where their anchors are.
    let resting = true;
    for (const b of this.bodies) {
      const o = observers.find((x) => x.id === b.info.id);
      b.active = false;
      b.empty = true;
      b.observer = null;
      if (!o) continue;
      const R = b.info.def.radius;
      const pose = frame.bodies[o.bodyIndex]!;
      b.bodyIndex = o.bodyIndex;
      b.rot = mat3.fromQuat(pose.qFixedToRoot);
      b.prevRot = mat3.fromQuat(pose.prevQFixedToRoot);
      b.centre = pose.centerRelCam;
      b.prevCentre = pose.prevCenterRelCam;
      const longest = b.tiers.reduce((m, t) => Math.max(m, t.kind.rangeM), 0);
      if (o.r - R > longest + 12000) continue;
      b.ground = this.provider.heightAt(b.info.id, o.dir, 20);
      if (o.r - R - b.ground > longest) continue;
      b.observer = o;
      if (!b.anchor || v3.dist(b.anchor, o.eye) > ANCHOR_REACH_M) {
        b.anchor = v3.clone(o.eye);
        b.anchorVersion++;
        b.rest = null;
      }
      const a = b.anchor;
      const m = b.rot;
      const q = b.prevRot;
      b.anchorRel = { x: m[0] * a.x + m[1] * a.y + m[2] * a.z + b.centre.x, y: m[3] * a.x + m[4] * a.y + m[5] * a.z + b.centre.y, z: m[6] * a.x + m[7] * a.y + m[8] * a.z + b.centre.z };
      b.prevAnchorRel = { x: q[0] * a.x + q[1] * a.y + q[2] * a.z + b.prevCentre.x, y: q[3] * a.x + q[4] * a.y + q[5] * a.z + b.prevCentre.y, z: q[6] * a.x + q[7] * a.y + q[8] * a.z + b.prevCentre.z };
      const rest = b.rest;
      if (!rest || !b.list || rest.pixelAngle !== pixelAngle || v3.dist(rest.eye, o.eye) >= LIST_TOLERANCE_M || rest.planes.length !== o.frustum.planes.length || rest.planes.some((pl, i) => v3.dist(pl, o.frustum.planes[i]!) > 1e-5)) resting = false;
    }
    // (The lists of every body lie one after another in the instance buffer: they are kept only together.)
    if (!resting) for (const b of this.bodies) b.rest = null;
    this.instancesDirty = false;
    let any = false;
    for (const b of this.bodies) {
      const o = b.observer;
      if (!o) continue;
      const rest = b.rest;
      if (rest && b.list) {
        // Nothing has changed since the last frame that was worked through.
        b.resting = true;
        b.active = true;
        b.empty = rest.empty;
        this.instanceCount += b.list.count;
        this.triangles += b.list.triangles;
      } else {
        const unbuiltBefore = this.unbuilt;
        b.resting = false;
        this.refresh(b, o, t0, pixelAngle);
        if (!b.active) continue;
        const fadingBefore = this.fading;
        this.buildDraws(b, pixelAngle);
        if (this.unbuilt === unbuiltBefore && this.fading === fadingBefore && !b.loading) {
          b.rest = { eye: v3.clone(o.eye), planes: o.frustum.planes.map((pl) => v3.clone(pl)), pixelAngle, empty: b.empty };
        }
      }
      if (b.empty) continue;
      any = true;
      const u = this.uniformData;
      u.fill(0);
      const m = b.rot;
      const pm = b.prevRot;
      u.set([m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0], 0);
      u.set([pm[0], pm[3], pm[6], 0, pm[1], pm[4], pm[7], 0, pm[2], pm[5], pm[8], 0], 12);
      u.set([MATERIAL_ID.terrain, b.bodyIndex, this.options.leafTest ? 1 : 0, 0], 24);
      u.set([b.anchorRel.x, b.anchorRel.y, b.anchorRel.z, 0, b.prevAnchorRel.x, b.prevAnchorRel.y, b.prevAnchorRel.z, 0], 28);
      for (const tier of b.tiers) u.set([tier.kind.rangeM, tier.rangePerRadius, SHAPE_MODE[tier.kind.shape], tier.kind.nearM], BODY_FLOATS + tier.kindIndex * 4);
      this.device.queue.writeBuffer(b.uniform, 0, u);
    }
    if (this.chunkDirty[1] >= this.chunkDirty[0]) {
      this.device.queue.writeBuffer(this.chunkBuffer, this.chunkDirty[0] * CHUNK_FLOATS * 4, this.chunkData, this.chunkDirty[0] * CHUNK_FLOATS, (this.chunkDirty[1] - this.chunkDirty[0] + 1) * CHUNK_FLOATS);
      this.chunkDirty = [Infinity, -1];
    }
    if (any && this.instanceCount > 0 && this.instancesDirty) this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instances, 0, this.instanceCount);
  }

  /** Work a body through for this frame's view: the height data around the camera, the chunks in range (scanned, tested against the view, built within the frame's budget). */
  private refresh(b: CoverBody, o: CoverObserver, t0: number, pixelAngle: number): void {
    const R = b.info.def.radius;
    const ground = b.ground;
    const longest = b.tiers.reduce((m, t) => Math.max(m, t.kind.rangeM), 0);
    // Height data around the camera for the placements (pinned under one slot).
    const groundPos = v3.scale(o.dir, R + ground);
    const wantRadius = Math.min(longest, 1500) + 300;
    if (!b.loading && (!b.loaded || v3.dist(b.loaded.centre, groundPos) > 250)) {
      b.loading = true;
      this.provider.ensureLoaded(b.info.id, o.dir, wantRadius, 'terrain-render:cover').then(
        () => {
          b.loaded = { centre: groundPos, radius: wantRadius };
          b.loading = false;
        },
        (e: unknown) => {
          b.loading = false;
          coreOf(this.ctx).reportError(`terrain cover: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    }
    if (!b.loaded) {
      this.unbuilt++;
      return;
    }
    // The wind is a compass direction: its body-fixed vector is taken at the camera.
    const east = v3.normalize(v3.cross(Math.abs(o.dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, o.dir));
    const north = v3.cross(o.dir, east);
    const az = b.info.cover.windToDeg * DEG;
    b.wind = v3.add(v3.scale(east, Math.sin(az)), v3.scale(north, Math.cos(az)));
    b.eye = o.eye;
    b.active = true;

    let build: { tier: Tier; c: Chunk }[] | null = null;
    for (const tier of b.tiers) {
      tier.rangePerRadius = 2 / (Math.max(tier.kind.minPixels, 0.5) * pixelAngle);
      if (this.options.kinds && !this.options.kinds.includes(tier.kind.id)) {
        tier.wanted.length = 0;
        tier.scanned = null;
        continue;
      }
      if (!tier.scanned || v3.dist(o.eye, tier.scanned) > 0.25 * tier.chunkSize) this.scan(b, tier, o, ground);
      const range = tier.kind.rangeM;
      for (const c of tier.wanted) {
        const dx = c.origin.x - o.eye.x;
        const dy = c.origin.y - o.eye.y;
        const dz = c.origin.z - o.eye.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        c.near = Math.max(0, d - c.reach);
        c.visible = false;
        if (c.near > range || d + c.reach < 0.7 * tier.kind.nearM) continue;
        c.lastUsed = this.frameIndex;
        let inside = true;
        for (const pl of o.frustum.planes) {
          if (dx * pl.x + dy * pl.y + dz * pl.z < -c.reach) {
            inside = false;
            break;
          }
        }
        c.visible = inside;
        if (!c.built) (build ??= []).push({ tier, c });
      }
    }
    if (build) {
      // In view first, then nearest first.
      build.sort((p, q) => Number(q.c.visible) - Number(p.c.visible) || p.c.near / p.tier.kind.rangeM - q.c.near / q.tier.kind.rangeM);
      for (const { tier, c } of build) {
        if (performance.now() - t0 > BUILD_BUDGET_MS || !this.buildChunk(b, tier, c)) this.unbuilt++;
      }
    }
    this.unbuilt += b.land.pending;
    // Forget chunks that have not been in range for a while (their records become a hole in the buffer,
    // closed when its end is reached).
    if (this.frameIndex % 120 === 0) {
      for (const tier of b.tiers) {
        for (const [id, c] of tier.chunks) {
          if (c.lastUsed < this.frameIndex - 600 && !tier.wanted.includes(c)) {
            tier.chunks.delete(id);
            this.freeSlots.push(c.slot);
          }
        }
      }
    }
  }

  private pushRange(bucket: number, from: number, to: number): void {
    const n = to - from;
    if (n <= 0) return;
    const count = this.bucketCount[bucket]!;
    let data = this.bucketData[bucket]!;
    if (count + n > data.length) {
      const grown = new Uint32Array(Math.max(2 * data.length, count + n));
      grown.set(data.subarray(0, count));
      this.bucketData[bucket] = data = grown;
    }
    // A range of records is a run of consecutive indices: copied from the identity table (a block copy), not
    // written one by one (shadow lists of thick cover are some hundred thousand indices per cascade).
    if (n < 16) {
      for (let i = 0; i < n; i++) data[count + i] = from + i;
    } else {
      data.set(IDENTITY.subarray(from, to), count);
    }
    this.bucketCount[bucket] = count + n;
  }

  /** End of the prefix of start .. end - 1 (largest first) whose radius is at least minRadius. */
  private static prefixEnd(radii: Float32Array, start: number, end: number, minRadius: number): number {
    let lo = start;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (radii[mid]! >= minRadius) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private flushBuckets(ranges: Int32Array): void {
    for (let k = 0; k < BUCKETS; k++) {
      const count = Math.min(this.bucketCount[k]!, MAX_INSTANCES - this.instanceCount);
      ranges[k * 2] = this.instanceCount;
      ranges[k * 2 + 1] = count;
      if (count > 0) this.instances.set(this.bucketData[k]!.subarray(0, count), this.instanceCount);
      this.instanceCount += count;
    }
  }

  /**
   * Chunk rows and instance lists of the G-buffer pass per (shape, variant, level of detail): of every chunk in
   * view, the prefix of each variant that can cover the kind's minPixels at the chunk's nearest point, split
   * into the three levels by size on screen: instance by instance in the chunks around the camera, by the
   * middle of the chunk further out.
   */
  private buildDraws(b: CoverBody, pixelAngle: number): void {
    const lean = b.info.cover.windLean;
    // First the chunk rows (relative to the body's anchor: written when a chunk is first listed, while it
    // fades in and when the anchor has moved) and which chunks are listed, with a signature of everything
    // the lists are built from apart from the eye. The lists themselves are kept between frames while that
    // signature, the pixel scale and the eye (within LIST_TOLERANCE_M) stay: a camera that moves a little
    // costs neither rows nor some hundred thousand instance indices sorted into buckets and uploaded again.
    let sig = 0x811c9dc5;
    const mix = (x: number): void => {
      sig = Math.imul(sig ^ (x | 0), 0x01000193);
    };
    for (const tier of b.tiers) {
      for (const c of tier.wanted) {
        c.listed = false;
        if (!c.built || c.base < 0 || c.count === 0 || c.lastUsed !== this.frameIndex) continue;
        const age = this.clock - c.born;
        const fade = age >= FADE_SECONDS ? 1 : Math.max(0, age / FADE_SECONDS);
        if (fade < 1) this.fading++;
        if (c.rowAnchor !== b.anchorVersion || c.rowFade !== fade) {
          const g = c.origin;
          const a = b.anchor!;
          const o = c.slot * CHUNK_FLOATS;
          const d = this.chunkData;
          d[o] = g.x - a.x;
          d[o + 1] = g.y - a.y;
          d[o + 2] = g.z - a.z;
          d[o + 3] = fade * fade * (3 - 2 * fade);
          d[o + 4] = b.wind.x;
          d[o + 5] = b.wind.y;
          d[o + 6] = b.wind.z;
          d[o + 7] = lean;
          c.rowAnchor = b.anchorVersion;
          c.rowFade = fade;
          if (c.slot < this.chunkDirty[0]) this.chunkDirty[0] = c.slot;
          if (c.slot > this.chunkDirty[1]) this.chunkDirty[1] = c.slot;
        }
        const minRadius = c.near / tier.rangePerRadius;
        if (c.maxRadius < minRadius) continue;
        c.listed = true;
        mix(c.slot);
        mix(c.base);
        mix(c.visible ? 1 : 0);
        for (let v = 0; v < COVER_VARIANTS; v++) {
          c.listEnd[v] = CoverRenderer.prefixEnd(c.radii, c.variantStart[v]!, c.variantStart[v + 1]!, minRadius);
          mix(c.listEnd[v]!);
        }
      }
    }
    const kept = b.list;
    if (kept && kept.sig === sig && kept.pixelAngle === pixelAngle && kept.start === this.instanceCount && v3.dist(kept.eye, b.eye) < LIST_TOLERANCE_M) {
      // The instance buffer still holds these lists (shadow lists are appended after them).
      this.instanceCount += kept.count;
      this.triangles += kept.triangles;
      b.empty = kept.count === 0 && !b.tiers.some((t) => t.wanted.some((c) => c.listed));
      return;
    }
    this.instancesDirty = true;
    const start = this.instanceCount;
    const trianglesBefore = this.triangles;
    this.bucketCount.fill(0);
    for (const tier of b.tiers) {
      const base = tier.shape * COVER_VARIANTS * COVER_LODS;
      for (const c of tier.wanted) {
        if (!c.listed || !c.visible) continue;
        const g = c.origin;
        // An instance spans 110 pixels (finest mesh) or 28 (middle) where its radius is this share of its distance.
        const fineShare = this.options.finePixels * pixelAngle;
        const middleShare = this.options.middlePixels * pixelAngle;
        if (c.near < c.reach) {
          // The camera is in or beside the chunk: distances differ by more than the chunk's own size.
          const ex = b.eye.x - g.x;
          const ey = b.eye.y - g.y;
          const ez = b.eye.z - g.z;
          const rec = c.data;
          for (let v = 0; v < COVER_VARIANTS; v++) {
            const bucket = base + v * COVER_LODS;
            for (let i = c.variantStart[v]!; i < c.listEnd[v]!; i++) {
              const k = i * RECORD_FLOATS;
              const dx = rec[k]! - ex;
              const dy = rec[k + 1]! - ey;
              const dz = rec[k + 2]! - ez;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const r = c.radii[i]!;
              this.pushRange(bucket + (r >= fineShare * dist ? 0 : r >= middleShare * dist ? 1 : 2), c.base + i, c.base + i + 1);
            }
          }
          continue;
        }
        const mid = c.near + 0.4 * c.reach;
        const fineRadius = fineShare * mid;
        const middleRadius = middleShare * mid;
        for (let v = 0; v < COVER_VARIANTS; v++) {
          const start = c.variantStart[v]!;
          const end = c.listEnd[v]!;
          if (end === start) continue;
          const fine = CoverRenderer.prefixEnd(c.radii, start, end, fineRadius);
          const middle = CoverRenderer.prefixEnd(c.radii, fine, end, middleRadius);
          const bucket = base + v * COVER_LODS;
          this.pushRange(bucket, c.base + start, c.base + fine);
          this.pushRange(bucket + 1, c.base + fine, c.base + middle);
          this.pushRange(bucket + 2, c.base + middle, c.base + end);
        }
      }
    }
    this.flushBuckets(b.draws);
    for (let k = 0; k < BUCKETS; k++) {
      const count = b.draws[k * 2 + 1]!;
      if (count > 0) b.empty = false;
      this.triangles += (count * this.meshes[k]!.indexCount) / 3;
    }
    b.list = { sig, eye: { ...b.eye }, pixelAngle, start, count: this.instanceCount - start, triangles: this.triangles - trianglesBefore };
    // A body with listed chunks out of view still casts.
    if (b.empty) b.empty = !b.tiers.some((t) => t.wanted.some((c) => c.listed));
  }

  drawGBuffer(pass: GPURenderPassEncoder): void {
    let set = false;
    for (const b of this.bodies) {
      if (!b.active || b.empty) continue;
      if (!set) {
        pass.setPipeline(this.gbuffer.get());
        pass.setBindGroup(1, this.emptyGroup);
        set = true;
      }
      pass.setBindGroup(2, b.group);
      for (let k = 0; k < BUCKETS; k++) {
        const count = b.draws[k * 2 + 1]!;
        if (count === 0) continue;
        const m = this.meshes[k]!;
        pass.setVertexBuffer(0, m.vertexBuffer);
        pass.setIndexBuffer(m.indexBuffer, 'uint16');
        pass.drawIndexed(m.indexCount, count, 0, 0, b.draws[k * 2]!);
      }
    }
  }

  /**
   * Cover is body-fixed: it casts into every cascade of its body whose texels are small enough to hold it
   * (an instance at least two texels across), from the coarsest mesh, or from a finer one where the map
   * resolves the difference (SHADOW_MIDDLE_TEXELS, SHADOW_FINE_TEXELS); only what is drawn casts.
   */
  drawShadow(pass: GPURenderPassEncoder, cascade: ShadowCascadeView, bodyId: string): void {
    const b = this.bodies.find((x) => x.info.id === bodyId);
    if (!b || !b.active || b.empty || !this.options.shadows) return;
    const m = cascade.viewProj;
    const rot = b.rot;
    const opt = this.options;
    const texelRadius = opt.shadowMinTexels * cascade.texelSize;
    const ndcPerMetre = 1 / (cascade.texelSize * 1024);
    const start0 = this.instanceCount;
    const ranges = this.shadowRanges;
    // The chunks inside the cascade (a few multiplications each), and a signature of them.
    const chunks = this.shadowChunks;
    const tiers = this.shadowTiers;
    chunks.length = 0;
    tiers.length = 0;
    let sig = 0x811c9dc5;
    for (const tier of b.tiers) {
      if (tier.kind.radiusM[1] < texelRadius) continue;
      for (const c of tier.wanted) {
        if (!c.listed || c.maxRadius < texelRadius) continue;
        // The chunk relative to the camera (ROOT axes), from its anchor-relative row.
        const o = c.slot * CHUNK_FLOATS;
        const ox = this.chunkData[o]!;
        const oy = this.chunkData[o + 1]!;
        const oz = this.chunkData[o + 2]!;
        const px = rot[0] * ox + rot[1] * oy + rot[2] * oz + b.anchorRel.x;
        const py = rot[3] * ox + rot[4] * oy + rot[5] * oz + b.anchorRel.y;
        const pz = rot[6] * ox + rot[7] * oy + rot[8] * oz + b.anchorRel.z;
        const margin = 1 + (c.reach + 8) * ndcPerMetre;
        if (Math.abs(m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) > margin || Math.abs(m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) > margin) continue;
        chunks.push(c);
        tiers.push(tier);
        sig = Math.imul(sig ^ c.slot, 0x01000193);
      }
    }
    const rest = b.resting ? b.rest : null;
    const kept = rest ? b.shadowLists.get(cascade.index) : undefined;
    if (kept && kept.rest === rest && kept.sig === sig && kept.chunks === chunks.length && kept.texel === cascade.texelSize && start0 + kept.data.length <= MAX_INSTANCES) {
      this.instances.set(kept.data, start0);
      for (let k = 0; k < BUCKETS; k++) {
        ranges[k * 2] = start0 + kept.ranges[k * 2]!;
        ranges[k * 2 + 1] = kept.ranges[k * 2 + 1]!;
      }
      this.instanceCount = start0 + kept.data.length;
    } else {
      this.bucketCount.fill(0);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const base = tiers[i]!.shape * COVER_VARIANTS * COVER_LODS;
        for (let v = 0; v < COVER_VARIANTS; v++) {
          const start = c.variantStart[v]!;
          const end = CoverRenderer.prefixEnd(c.radii, start, c.listEnd[v]!, texelRadius);
          // A crown that spans many texels casts from a finer mesh: the coarsest one draws its shadow as a
          // few large sprays on the ground beside the eye.
          const fine = CoverRenderer.prefixEnd(c.radii, start, end, opt.shadowFineTexels * cascade.texelSize);
          const middle = CoverRenderer.prefixEnd(c.radii, fine, end, opt.shadowMiddleTexels * cascade.texelSize);
          this.pushRange(base + v * COVER_LODS, c.base + start, c.base + fine);
          this.pushRange(base + v * COVER_LODS + 1, c.base + fine, c.base + middle);
          this.pushRange(base + v * COVER_LODS + 2, c.base + middle, c.base + end);
        }
      }
      this.flushBuckets(ranges);
      if (rest) {
        const rel = new Int32Array(BUCKETS * 2);
        for (let k = 0; k < BUCKETS; k++) {
          rel[k * 2] = ranges[k * 2]! - start0;
          rel[k * 2 + 1] = ranges[k * 2 + 1]!;
        }
        b.shadowLists.set(cascade.index, { rest, sig, chunks: chunks.length, texel: cascade.texelSize, data: this.instances.slice(start0, this.instanceCount), ranges: rel });
      }
    }
    if (this.instanceCount === start0) return;
    this.device.queue.writeBuffer(this.instanceBuffer, start0 * 4, this.instances, start0, this.instanceCount - start0);
    pass.setBindGroup(2, b.group);
    let leafy: boolean | null = null;
    for (let k = 0; k < BUCKETS; k++) {
      const count = ranges[k * 2 + 1]!;
      if (count === 0) continue;
      const wantLeafy = SHAPE_LEAFY[COVER_SHAPES[Math.floor(k / (COVER_VARIANTS * COVER_LODS))]!];
      if (wantLeafy !== leafy) {
        pass.setPipeline(wantLeafy ? this.leafShadow.get() : this.shadow.get());
        leafy = wantLeafy;
      }
      const mesh = this.meshes[k]!;
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint16');
      pass.drawIndexed(mesh.indexCount, count, 0, 0, ranges[k * 2]!);
    }
  }

  isIdle(): boolean {
    return this.unbuilt === 0 && this.fading === 0 && !this.bodies.some((b) => b.loading);
  }

  /** The temporal sequences start again (frame-exact capture): chunks that were fading in are in. */
  resetTemporal(): void {
    for (const b of this.bodies) {
      b.rest = null;
      for (const tier of b.tiers) for (const c of tier.chunks.values()) if (c.built) c.born = -Infinity;
    }
  }

  stats(): { instances: number; chunks: number; triangles: number } {
    return { instances: this.instanceCount, chunks: this.bodies.reduce((a, b) => a + b.tiers.reduce((n, t) => n + t.chunks.size, 0), 0), triangles: Math.round(this.triangles) };
  }

  dispose(): void {
    this.recordBuffer.destroy();
    this.chunkBuffer.destroy();
    this.instanceBuffer.destroy();
    for (const m of this.meshes) {
      m.vertexBuffer.destroy();
      m.indexBuffer.destroy();
    }
  }
}
