/**
 * WGSL shared by every terrain pipeline: the per-body uniform, the per-tile record, the stable tile vertex
 * formula (rendering-design 2.3) and the CDLOD vertex stage (geomorph towards the parent tile).
 *
 * Layouts are mirrored by records.ts (RECORD_FLOATS, BODY_UNIFORM_FLOATS); change both together.
 */

/** Bytes of one TileRecord (17 rows of 16 bytes): the constants of a resident tile, written once. */
export const RECORD_BYTES = 272;
export const RECORD_FLOATS = RECORD_BYTES / 4;
/** Bytes of one TileFrame (2 rows): what changes with the camera, written every frame for the tiles in use. */
export const TILE_FRAME_BYTES = 32;
export const TILE_FRAME_FLOATS = TILE_FRAME_BYTES / 4;
/** Bytes of the TerrainBody uniform. */
export const BODY_UNIFORM_BYTES = 288;
export const MAX_OBSERVERS = 4;

export const TERRAIN_COMMON_WGSL = /* wgsl */ `
struct TerrainBody {
  rot: mat3x3f,                  // body-fixed -> ROOT axes
  prevRot: mat3x3f,              // the same one frame ago
  observers: array<vec4f, ${MAX_OBSERVERS}>,   // xyz = LOD observer relative to the camera (ROOT axes, m), w = radius bias (m)
  p0: vec4f,                     // reference radius (m), sea level above it (m), observer count, frame body index
  morph: vec4f,                  // m0, 1 / (m1 - m0), detail fade distance (m), unused
  detailInv: vec4f,              // 1 / tiling length of the four detail scales (1/m)
  orbital: vec4f,                // base wavelength (m), albedo strength, relief strength, octave count
  night: vec4f,                  // luminance of a white texel (cd/m^2), cos(sun zenith) where lights are fully on, where they are off, 1 = has night layer
  misc: vec4f,                   // land material id, 1 = has ocean, mean tile size of level 0 (m), longest wavelength of the night-light clusters (m; 0 = none)
  nightTint: vec4f,              // rgb = colour of the night lights (linear), a = strength of the clusters (octaves of brightness)
  deepWater: vec4f,              // rgb = colour the imagery gives the open ocean (linear), w = depth (m) from which water has it (0 = off)
}

struct TileFrame {
  originRelCam: vec4f,           // xyz = tile origin relative to the camera (ROOT axes), w = forced morph floor (fade-in, warp cap)
  prevOriginRelCam: vec4f,       // xyz = the same relative to the previous eye, w = 1 / range(level) (0 for level 0)
}

struct TileRecord {
  cHat: vec4f,                   // xyz = unit direction of the tile centre (body-fixed), w = h0: height of the origin above the radius
  a: vec4f,                      // xyz = cube tangent step along u / |Pc|, w = skirt depth (m)
  b: vec4f,                      // xyz = cube tangent step along v / |Pc|, w = render level
  layers: vec4i,                 // height, parent height, normal, parent normal
  images: vec4i,                 // albedo/aux, parent's albedo/aux, night, parent's night (-1 = none)
  parentUv: vec4f,               // xy = offset of this tile in its parent (0 or 0.5), z = slope scale, w = parent's slope scale
  imageUv: vec4f,                // xy = offset, z = scale into the image tile, w = data level of that image
  parentImageUv: vec4f,          // the same for the image the parent uses
  nightUv: vec4f,                // xy = offset, z = scale into the night tile, w = unused
  parentNightUv: vec4f,
  detail0: vec4f,                // xyz = tile origin modulo HEX_PERIOD tiling lengths of detail scale 0 (m), w = imagery level at corner (0, 0)
  detail1: vec4f,                // scale 1, w = imagery level at corner (1, 0)
  detail2: vec4f,                // scale 2, w = imagery level at corner (0, 1)
  noise: vec4f,                  // xyz = tile origin / orbital base wavelength, modulo the noise period, w = imagery level at corner (1, 1)
  pad: vec4f,                    // xyz = nearest launch-pad centre relative to the tile origin (body-fixed, m), w = reach of the site's ground plan (0 = none)
  flags: vec4i,                  // x = flags: 1 = parent uses another image, 2 = parent uses another night image, 4 / 8 = odd vertices slide up along u / v
  detail3: vec4f,                // xyz = tile origin modulo HEX_PERIOD tiling lengths of detail scale 3 (m), w = index of the site of 'pad'
}

// Both arrays are indexed by the tile's layer in the height pool (one slot per resident tile).
@group(2) @binding(0) var<uniform> body: TerrainBody;
@group(2) @binding(1) var<storage, read> tiles: array<TileRecord>;
@group(2) @binding(2) var<storage, read> instances: array<u32>;
@group(2) @binding(3) var heightTex: texture_2d_array<f32>;
@group(2) @binding(4) var<storage, read> tileFrames: array<TileFrame>;

const GRID_QUADS = 64.0;

/// Cube-space offset of tile-local uv from the tile centre, divided by |Pc| (small).
fn tileDelta(uv: vec2f, t: TileRecord) -> vec3f { return (uv.x - 0.5) * t.a.xyz + (uv.y - 0.5) * t.b.xyz; }

/// normalize(cHat + delta) - cHat without cancellation.
fn tileDn(delta: vec3f, cHat: vec3f) -> vec3f {
  let e = 2.0 * dot(cHat, delta) + dot(delta, delta);
  let s = sqrt(1.0 + e);
  let inv = -e / (s * (1.0 + s));
  return delta * (1.0 + inv) + cHat * inv;
}

/// Body-fixed offset of the surface point (uv, height h) from the tile origin (R + h0) cHat.
fn tileLocal(uv: vec2f, h: f32, t: TileRecord) -> vec3f {
  let dn = tileDn(tileDelta(uv, t), t.cHat.xyz);
  return (body.p0.x + h) * dn + (h - t.cHat.w) * t.cHat.xyz;
}

struct TerrainVertex {
  local: vec3f,      // body-fixed offset from the tile origin (m)
  pos: vec3f,        // camera-relative position (ROOT axes, m)
  uv: vec2f,         // tile uv after the morph
  k: f32,            // morph factor 0 (own level) .. 1 (the parent's geometry)
  h: f32,            // terrain height above the reference radius at the vertex (m), morphed
  rec: u32,
}

/// CDLOD vertex. 'grid' = (i, j, skirt flag, 0) of the shared grid mesh; 'sheet' places the vertex on the
/// sea-level sphere instead of the terrain (far water sheet), with the same lateral morph.
fn terrainVertex(grid: vec4u, instance: u32, sheet: bool) -> TerrainVertex {
  let word = instances[instance];
  let ri = word & 0xfffffu;
  let quad = (word >> 20u) & 7u;
  let t = tiles[ri];
  let tf = tileFrames[ri];
  var g = vec2f(grid.xy);
  if (quad != 0u) { g += vec2f(f32((quad - 1u) & 1u), f32((quad - 1u) >> 1u)) * (GRID_QUADS * 0.5); }
  let hc = textureLoad(heightTex, vec2i(g), t.layers.x, 0).r;
  // Odd vertices slide to an even neighbour, which is a vertex of the parent tile; the direction is the
  // same on both sides of every cube edge (tileMath.ts, snapDirection).
  let slide = vec2f(select(-1.0, 1.0, (t.flags.x & 4) != 0), select(-1.0, 1.0, (t.flags.x & 8) != 0));
  let snapped = g + fract(g * 0.5) * 2.0 * slide;
  let parentBase = vec2i(t.parentUv.xy * GRID_QUADS);
  let hp = textureLoad(heightTex, parentBase + vec2i(snapped) / 2, t.layers.y, 0).r;

  let sea = body.p0.y;
  // The morph factor comes from the distance to the TERRAIN vertex, for the sheet too: the tiles were
  // selected by their distance to the terrain, and over deep water the sea surface is kilometres nearer
  // (a sheet morphing by its own distance would stay unmorphed next to coarser tiles and tear along
  // tile edges).
  let pos0 = body.rot * tileLocal(g / GRID_QUADS, hc, t) + tf.originRelCam.xyz;
  var d = 3.0e38;
  let count = u32(body.p0.z);
  for (var i = 0u; i < count; i++) {
    d = min(d, max(length(pos0 - body.observers[i].xyz) - body.observers[i].w, 0.0));
  }
  let k = max(saturate((d * tf.prevOriginRelCam.w - body.morph.x) * body.morph.y), tf.originRelCam.w);

  var o: TerrainVertex;
  o.k = k;
  o.h = mix(hc, hp, k);
  o.uv = mix(g, snapped, k) / GRID_QUADS;
  var hs = select(o.h, sea, sheet);
  // Skirts cover the height slack between a tile and its parent. The sheet keeps the same tall skirt: where
  // the mask calls a coast land while the coarse mesh there still lies below sea level, the sea horizon
  // would show a notch of sky; the skirt of the sheet tile behind closes it with water.
  if (grid.z != 0u) { hs -= t.a.w; }
  o.local = tileLocal(o.uv, hs, t);
  o.pos = body.rot * o.local + tf.originRelCam.xyz;
  o.rec = ri;
  return o;
}
`;

export const TERRAIN_SHADOW_WGSL = /* wgsl */ `
#include "frame"
#include "shadow_pass"
${TERRAIN_COMMON_WGSL}
@vertex fn vs(@location(0) grid: vec4u, @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
  let v = terrainVertex(grid, instance, false);
  return shadowPass.viewProj * vec4f(v.pos, 1.0);
}
`;
