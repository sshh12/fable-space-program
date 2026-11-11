/**
 * WGSL shared by every terrain pipeline: the per-body uniform, the per-tile record, the stable tile vertex
 * formula (rendering-design 2.3) and the CDLOD vertex stage (geomorph towards the parent tile).
 *
 * Layouts are mirrored by records.ts (RECORD_FLOATS, BODY_UNIFORM_FLOATS); change both together.
 */

/** Bytes of one TileRecord (20 rows of 16 bytes). */
export const RECORD_BYTES = 320;
export const RECORD_FLOATS = RECORD_BYTES / 4;
/** Bytes of the TerrainBody uniform. */
export const BODY_UNIFORM_BYTES = 272;
export const MAX_OBSERVERS = 4;

export const TERRAIN_COMMON_WGSL = /* wgsl */ `
struct TerrainBody {
  rot: mat3x3f,                  // body-fixed -> ROOT axes
  prevRot: mat3x3f,              // the same one frame ago
  observers: array<vec4f, ${MAX_OBSERVERS}>,   // xyz = LOD observer relative to the camera (ROOT axes, m), w = radius bias (m)
  p0: vec4f,                     // reference radius (m), sea level above it (m), observer count, frame body index
  morph: vec4f,                  // m0, 1 / (m1 - m0), unused, unused
  detailInv: vec4f,              // 1 / tiling length of the three detail scales (1/m), detail fade distance (m)
  orbital: vec4f,                // base wavelength (m), albedo strength, relief strength, octave count
  night: vec4f,                  // luminance of a white texel (cd/m^2), cos(sun zenith) where lights are fully on, where they are off, 1 = has night layer
  misc: vec4f,                   // land material id, 1 = has ocean, mean tile size of level 0 (m), unused
  nightTint: vec4f,              // rgb = colour of the night lights (linear), a unused
}

struct TileRecord {
  originRelCam: vec4f,           // xyz = tile origin relative to the camera (ROOT axes), w = forced morph floor (fade-in, warp cap)
  prevOriginRelCam: vec4f,       // xyz = the same relative to the previous eye, w = 1 / range(level) (0 for level 0)
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
  detail0: vec4f,                // xyz = tile origin modulo the tiling length of detail scale 0 (m), w = imagery level at corner (0, 0)
  detail1: vec4f,                // scale 1, w = imagery level at corner (1, 0)
  detail2: vec4f,                // scale 2, w = imagery level at corner (0, 1)
  noise: vec4f,                  // xyz = tile origin / orbital base wavelength, modulo the noise period, w = imagery level at corner (1, 1)
  pad: vec4f,                    // xyz = nearest launch-pad centre relative to the tile origin (body-fixed, m), w = apron radius (0 = none)
  flags: vec4i,                  // x = flags (1 = parent uses another image, 2 = parent uses another night image), yzw unused
  spare0: vec4f,
  spare1: vec4f,
}

@group(2) @binding(0) var<uniform> body: TerrainBody;
@group(2) @binding(1) var<storage, read> tiles: array<TileRecord>;
@group(2) @binding(2) var<storage, read> instances: array<u32>;
@group(2) @binding(3) var heightTex: texture_2d_array<f32>;

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
  var g = vec2f(grid.xy);
  if (quad != 0u) { g += vec2f(f32((quad - 1u) & 1u), f32((quad - 1u) >> 1u)) * (GRID_QUADS * 0.5); }
  let hc = textureLoad(heightTex, vec2i(g), t.layers.x, 0).r;
  // Odd vertices slide to their even neighbour, which is a vertex of the parent tile.
  let snapped = g - fract(g * 0.5) * 2.0;
  let parentBase = vec2i(t.parentUv.xy * GRID_QUADS);
  let hp = textureLoad(heightTex, parentBase + vec2i(snapped) / 2, t.layers.y, 0).r;

  let sea = body.p0.y;
  let pos0 = body.rot * tileLocal(g / GRID_QUADS, select(hc, sea, sheet), t) + t.originRelCam.xyz;
  var d = 3.0e38;
  let count = u32(body.p0.z);
  for (var i = 0u; i < count; i++) {
    d = min(d, max(length(pos0 - body.observers[i].xyz) - body.observers[i].w, 0.0));
  }
  let k = max(saturate((d * t.prevOriginRelCam.w - body.morph.x) * body.morph.y), t.originRelCam.w);

  var o: TerrainVertex;
  o.k = k;
  o.h = mix(hc, hp, k);
  o.uv = mix(g, snapped, k) / GRID_QUADS;
  var hs = select(o.h, sea, sheet);
  if (grid.z != 0u) { hs -= t.a.w; }
  o.local = tileLocal(o.uv, hs, t);
  o.pos = body.rot * o.local + t.originRelCam.xyz;
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
