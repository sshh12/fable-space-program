/**
 * WGSL of the terrain G-buffer pass: land (terrain / regolith materials with imagery-anchored detail and
 * orbital-scale detail, night lights, shore wetness), water written by terrain fragments the mask marks,
 * and the far sea-level sheet.
 *
 * Group 3 layout is mirrored by materials.ts (MATERIAL_UNIFORM_FLOATS) and feature.ts.
 */
import { MAX_SITES, MAX_SITE_SHAPES } from '../sitePlan';
import { TERRAIN_COMMON_WGSL } from './common';

/** Period of the orbital noise volume in lattice cells, and the range its stored gradient is scaled by. */
export const NOISE_PERIOD = 16;
export const NOISE_GRADIENT_RANGE = 4;

export const MAX_MATERIALS = 8;
export const MAX_CLASSES = 16;
/** Texture layers of a material: one per detail scale (near, mid, far, aerial), each with its own content. */
export const DETAIL_SCALES = 4;
/**
 * Period of the hexagon pattern that breaks the repetition of the detail layers, in tiling lengths: every
 * hexagon shows the layer at its own random offset and rotation, and the pattern itself repeats only after
 * this many tiles (128 m for the near layer, 58 km for the aerial one).
 */
export const HEX_PERIOD = 64;
/** Floats of the TerrainMaterial uniform. */
export const MATERIAL_UNIFORM_FLOATS = (MAX_CLASSES * 2 + MAX_CLASSES + 2 * MAX_MATERIALS * DETAIL_SCALES + 2 + 2 + 2 + 6 + 6 + 2 + 4 + MAX_MATERIALS + 2 * MAX_SITES + 2 * MAX_SITE_SHAPES) * 4;

const SURFACE_BINDINGS_WGSL = /* wgsl */ `
struct TerrainMaterial {
  classW: array<vec4f, ${MAX_CLASSES * 2}>,   // land-cover class c: weights of materials 0..3 in [2c], 4..7 in [2c + 1]
  classOrb: array<vec4f, ${MAX_CLASSES}>,     // per class: orbital albedo amplitude, orbital relief amplitude, macro tint amplitude, unused
  layer: array<vec4f, ${MAX_MATERIALS * DETAIL_SCALES}>, // [4 m + s]: rgb = mean linear albedo of material m's layer of scale s, a = relief of its height map (m)
  layerB: array<vec4f, ${MAX_MATERIALS * DETAIL_SCALES}>, // [4 m + s]: x = mean of the layer's height map (0..1), y = roughness factor of what stands above the mean (1 = none: crests of ropy lava are glassy), z = share of the material's colour variation kept where the ground takes its albedo (rock is grey, growth is not), w unused
  channelGain: array<vec4f, 2>,               // weight added per unit of the normal map's material channel (rockiness / freshness)
  slopeGain: array<vec4f, 2>,                 // weight added on steep ground
  noiseGain: array<vec4f, 2>,                 // weight added per unit of macro noise (-1..1)
  albedoGain: array<vec4f, 6>,                // weight added per unit of the imagery's darkness [0, 1], saturation [2, 3], greenness [4, 5]
  p0: vec4f,                                  // slope range lo, hi; apron material index (-1 = none); material count
  p1: vec4f,                                  // detail albedo strength, detail normal strength, height-blend contrast (per layer height range), macro noise wavelength (m)
  p2: vec4f,                                  // base roughness, Toksvig gain, apron edge width (m), lake depth (m)
  p3: vec4f,                                  // shore wetness height (m), brightening of fresh material, AO strength of the detail maps, chroma share of the detail ratio
  p4: vec4f,                                  // texel size on the ground of the near, mid, far and aerial layers (m)
  p5: vec4f,                                  // hexagon blend: weight (octaves) per unit of height above / below the layer's mean; share of the far and aerial relief the terrain's own normal map replaces; width of the gravel shoulder around a site's concrete (m)
  shoreGain: array<vec4f, 2>,                 // weight added on low, level ground at the water's edge
  p6: vec4f,                                  // imagery calibration: data level above which the imagery is calibrated (regional mosaics; below 0 = all of it), share of its saturation kept, its reference luminance, exponent of (luminance / reference)
  p7: vec4f,                                  // share of the material's own albedo in the ground colour where a pixel is finer than the imagery, and where it is coarser; joint spacing of concrete slabs (m); gravel material (-1 = none)
  p8: vec4f,                                  // rgb = albedo of site gravel, a = strength of the shadows the detail relief casts along the sun (0 = off)
  p9: vec4f,                                  // height above sea level up to which shoreGain acts (m); wet band of the swash (m); unused
  anchor: array<vec4f, ${MAX_MATERIALS}>,     // rgb = albedo the ground takes where material m covers it (its own mean, or the set's choice for it)
  siteFrame: array<vec4f, ${2 * MAX_SITES}>,  // [2 s]: xyz = east at the site (body-fixed), w = first shape; [2 s + 1]: xyz = north, w = shape count
  siteShape: array<vec4f, ${2 * MAX_SITE_SHAPES}>, // [2 i]: centre east, north of the pad centre, half sizes x, z (m); [2 i + 1]: cos, sin of the heading, kind (0 slab, 1 gravel), corner radius (m)
}

@group(3) @binding(0) var normalTex: texture_2d_array<f32>;
@group(3) @binding(1) var albedoTex: texture_2d_array<f32>;
@group(3) @binding(2) var auxTex: texture_2d_array<f32>;
@group(3) @binding(3) var nightTex: texture_2d_array<f32>;
@group(3) @binding(4) var tileSampler: sampler;
@group(3) @binding(5) var detailA: texture_2d_array<f32>;       // near layers (layer = material): albedo, height
@group(3) @binding(6) var detailB: texture_2d_array<f32>;       // near layers: normal xy, roughness, AO
@group(3) @binding(7) var detailWideA: texture_2d_array<f32>;   // mid, far and aerial layers (layer = 3 x material + scale - 1)
@group(3) @binding(8) var detailWideB: texture_2d_array<f32>;
@group(3) @binding(9) var noiseTex: texture_3d<f32>;
@group(3) @binding(10) var<uniform> mat: TerrainMaterial;
`;

const VARYINGS_WGSL = /* wgsl */ `
struct TerrainVaryings {
  @builtin(position) position: vec4f,
  @location(0) uvk: vec3f,                     // tile uv, morph factor
  @location(1) local: vec3f,                   // body-fixed offset from the tile origin
  @location(2) pos: vec3f,                     // camera-relative position
  @location(3) currClip: vec4f,
  @location(4) prevClip: vec4f,
  @location(5) @interpolate(flat) rec: u32,
  @location(6) height: f32,                    // terrain height above the reference radius (m)
}

fn terrainVaryings(v: TerrainVertex) -> TerrainVaryings {
  var o: TerrainVaryings;
  o.position = frame.viewProj * vec4f(v.pos, 1.0);
  o.uvk = vec3f(v.uv, v.k);
  o.local = v.local;
  o.pos = v.pos;
  o.currClip = frame.viewProjUnjittered * vec4f(v.pos, 1.0);
  o.prevClip = frame.prevViewProj * vec4f(body.prevRot * v.local + tileFrames[v.rec].prevOriginRelCam.xyz, 1.0);
  o.rec = v.rec;
  o.height = v.h;
  return o;
}
`;

const SURFACE_FUNCTIONS_WGSL = /* wgsl */ `
const NOISE_PERIOD = ${NOISE_PERIOD}.0;
const NOISE_GRADIENT_RANGE = ${NOISE_GRADIENT_RANGE}.0;

/// Periodic gradient noise at lattice position p: rgb = gradient per cell, a = value in -1..1.
fn noiseAt(p: vec3f) -> vec4f {
  let n = textureSampleLevel(noiseTex, linearRepeat, p / NOISE_PERIOD, 0.0) * 2.0 - 1.0;
  return vec4f(n.rgb * NOISE_GRADIENT_RANGE, n.a);
}

fn decodeSlope(v: vec2f, scale: f32) -> vec2f {
  let x = clamp(v * 2.0 - 1.0, vec2f(-0.996), vec2f(0.996));
  return scale * 0.5 * log((1.0 + x) / (1.0 - x));
}

struct TileSample {
  slope: vec2f,        // dh/dU, dh/dV along the unit tile tangents (m/m)
  ao: f32,
  channel: f32,        // material weight of the bake (rockiness / crater freshness)
  albedo: vec3f,       // linear imagery colour
  mask: f32,           // water mask 0 land .. 1 water
  maskWide: f32,       // the same averaged over about 32 texels (is there any water nearby)
  imageLevel: f32,     // data level of the imagery that was sampled (fractional through the morph)
  uvImage: vec2f,
  imageLayer: i32,
}

/// The water mask of an image at lod 0, reconstructed with a cubic B-spline (four bilinear taps): the
/// outline of a lake or an island drawn from a magnified mask is then a smooth curve, not the diamonds and
/// steps of bilinear texels.
fn maskCubic(uv: vec2f, layer: i32) -> f32 {
  let size = f32(textureDimensions(auxTex).x);
  let st = uv * size - 0.5;
  let i = floor(st);
  let f = st - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let w2 = 1.0 - w0 - w1 - w3;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  return (textureSampleLevel(auxTex, tileSampler, vec2f(h0.x, h0.y), layer, 0.0).r * g0.x + textureSampleLevel(auxTex, tileSampler, vec2f(h1.x, h0.y), layer, 0.0).r * g1.x) * g0.y +
    (textureSampleLevel(auxTex, tileSampler, vec2f(h0.x, h1.y), layer, 0.0).r * g0.x + textureSampleLevel(auxTex, tileSampler, vec2f(h1.x, h1.y), layer, 0.0).r * g1.x) * g1.y;
}

/// The water mask of an image: filtered as usual while minified, cubic once a texel spans more than a pixel.
fn maskSample(uv: vec2f, layer: i32, dx: vec2f, dy: vec2f) -> f32 {
  let texels = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)) * 65536.0, 1e-12));
  let plain = textureSampleGrad(auxTex, tileSampler, uv, layer, dx, dy).r;
  if (texels >= 0.0) { return plain; }
  return mix(plain, maskCubic(uv, layer), saturate(-texels));
}

/// Normal/material map, imagery and water mask of the tile, each blended with the parent's by the morph
/// factor. 'warp' displaces the imagery lookup (tile uv; see imageryWarp); it is dropped near water, where
/// the colour must stay under the mask.
fn sampleTile(t: TileRecord, uv: vec2f, k: f32, dx: vec2f, dy: vec2f, warp: vec2f) -> TileSample {
  var s: TileSample;
  let nm = textureSampleGrad(normalTex, tileSampler, uv, t.layers.z, dx, dy);
  var slope = decodeSlope(nm.rg, t.parentUv.z);
  var rest = nm.ba;
  let uvI = t.imageUv.xy + uv * t.imageUv.z;
  let idx = dx * t.imageUv.z;
  let idy = dy * t.imageUv.z;
  var wide = textureSampleLevel(auxTex, tileSampler, uvI, t.images.x, 5.0).r;
  let shift = warp * (1.0 - smoothstep(0.0, 0.03, wide));
  var albedo = textureSampleGrad(albedoTex, tileSampler, uvI + shift * t.imageUv.z, t.images.x, idx, idy).rgb;
  var mask = maskSample(uvI, t.images.x, idx, idy);
  s.imageLevel = t.imageUv.w;
  if (k > 0.0) {
    let uvP = t.parentUv.xy + uv * 0.5;
    let pm = textureSampleGrad(normalTex, tileSampler, uvP, t.layers.w, dx * 0.5, dy * 0.5);
    slope = mix(slope, decodeSlope(pm.rg, t.parentUv.w), k);
    rest = mix(rest, pm.ba, k);
    if ((t.flags.x & 1) != 0) {
      let uvPI = t.parentImageUv.xy + uv * t.parentImageUv.z;
      let pdx = dx * t.parentImageUv.z;
      let pdy = dy * t.parentImageUv.z;
      albedo = mix(albedo, textureSampleGrad(albedoTex, tileSampler, uvPI + shift * t.parentImageUv.z, t.images.y, pdx, pdy).rgb, k);
      mask = mix(mask, maskSample(uvPI, t.images.y, pdx, pdy), k);
      wide = mix(wide, textureSampleLevel(auxTex, tileSampler, uvPI, t.images.y, 5.0).r, k);
      s.imageLevel = mix(t.imageUv.w, t.parentImageUv.w, k);
    }
  }
  s.slope = slope;
  s.ao = rest.x;
  s.channel = rest.y;
  s.albedo = albedo;
  s.mask = mask;
  s.maskWide = wide;
  s.uvImage = uvI;
  s.imageLayer = t.images.x;
  return s;
}

/// Magnified imagery is a blur: every boundary between two colours becomes a ramp one texel wide. The lookup
/// is displaced by band-limited noise of about that width (octaves of 0.5 to 3 texels that the pixel
/// resolves), so the ramp becomes a ragged edge: patches of vegetation, soil and rock have such edges, and
/// photographs of them have no ramps. Returns the displacement in metres along the tile's u and v.
fn imageryWarp(t: TileRecord, local: vec3f, imageTexel: f32, footprint: f32) -> vec2f {
  let magnified = smoothstep(1.5, 4.0, imageTexel / footprint);
  if (magnified <= 0.0) { return vec2f(0.0); }
  var q = t.noise.xyz + local / body.orbital.x;
  var lambda = body.orbital.x;
  var w = vec2f(0.0);
  for (var i = 0; i < 9; i++) {
    let r = lambda / imageTexel;
    let wo = smoothstep(0.4, 0.8, r) * (1.0 - smoothstep(2.0, 4.0, r)) * smoothstep(1.5, 3.0, lambda / footprint);
    if (wo > 0.0) {
      var p = q;
      if ((i & 1) == 1) { p = q.zxy; }
      let n = noiseAt(p + vec3f(41.7, 13.1, 27.9));
      w += (wo * lambda * 0.22) * vec2f(n.a, clamp(0.5 * n.r, -1.0, 1.0));
    }
    q *= 2.0;
    lambda *= 0.5;
  }
  return w * magnified;
}

struct TileNormal {
  sphere: vec3f,       // unit normal of the reference sphere (body-fixed)
  n: vec3f,            // unit terrain normal (body-fixed)
  slopeMag: f32,
}

/// Terrain normal from the encoded slopes. The tile tangents are not orthogonal on the gnomonic cube, so
/// the gradient is rebuilt with the dual basis (terrain-core hand-off, normal/material map).
fn tileNormal(t: TileRecord, uv: vec2f, slope: vec2f) -> TileNormal {
  var o: TileNormal;
  let ns = normalize(t.cHat.xyz + tileDelta(uv, t));
  let tu = normalize(t.a.xyz - ns * dot(ns, t.a.xyz));
  let tv = normalize(t.b.xyz - ns * dot(ns, t.b.xyz));
  let c = dot(tu, tv);
  let g = ((slope.x - c * slope.y) * tu + (slope.y - c * slope.x) * tv) / max(1.0 - c * c, 1e-4);
  o.sphere = ns;
  o.n = normalize(ns - g);
  o.slopeMag = length(g);
  return o;
}

/// How much the water mask decides the coastline: 1 while the render quads are larger than the mask's
/// texels, 0 once they are half a texel (from there the geometry against sea level decides).
fn maskInfluence(t: TileRecord, k: f32, imageLevel: f32) -> f32 {
  return saturate(imageLevel + 3.0 - (t.b.w - k));
}

/// How much a colour of the imagery is the flat fill the body-wide mosaic paints the open sea with, or the
/// ramp towards it (0 .. 1). The fill is dark AND strongly blue; fresh lava, forest in shadow and swamp
/// water are as dark but not blue, so darkness alone never makes water of them.
fn fillness(c: vec3f) -> f32 {
  let fillLum = 4.0 * luminance(body.deepWater.rgb) + 0.002;
  let dark = 1.0 - smoothstep(0.6 * fillLum, 1.2 * fillLum, luminance(c));
  return dark * smoothstep(1.6, 2.6, c.b / max(c.r, 1e-5)) * smoothstep(1.0, 1.4, c.b / max(c.g, 1e-5));
}

/// Colour of water as the imagery shows it. The body-wide imagery paints the open ocean one flat colour and
/// keeps measured colour only in a band of a few kilometres around land (regional imagery adds its own
/// band): over shelves and reefs that colour is the sea floor showing through, over deep water it is only
/// the outline of the band. With depth the colour therefore goes to the open-ocean colour. Where the imagery
/// holds the fill or its ramp right up to the shore (a dark outline around every coast, if it were kept),
/// shallow water takes the colour of the bottom seen through it instead: lighter and greener than the deep
/// sea, the more the shallower.
fn waterAlbedo(imagery: vec3f, depth: f32) -> vec3f {
  if (body.deepWater.w <= 0.0) { return imagery; }
  let s = exp(-depth / (0.1 * body.deepWater.w));
  let shallow = body.deepWater.rgb * (1.0 + 2.2 * s) + vec3f(0.0, 0.011, 0.007) * s;
  let base = mix(imagery, shallow, fillness(imagery));
  return mix(base, body.deepWater.rgb, smoothstep(0.08 * body.deepWater.w, body.deepWater.w, depth));
}

/// The night image of a tile at lod (0 = one texel per pixel, negative = magnified). Magnified, a bilinear
/// tap draws the texel grid as crosses and diamonds in the glow of a town: a cubic B-spline (four bilinear
/// taps) takes over within one level. Minified, the image is sampled with the footprint's own shape ('dx',
/// 'dy' = screen derivatives of the tile uv of the night image): towards the limb a pixel is many times
/// longer than wide, and a level chosen by its long axis alone smears every town into a streak.
fn nightSample(tileUv: vec2f, layer: i32, lod: f32, dx: vec2f, dy: vec2f) -> f32 {
  // The texture holds the tile's image inside a border of one texel from the tiles around it.
  let size = f32(textureDimensions(nightTex).x);
  let uv = (tileUv * (size - 2.0) + 1.0) / size;
  if (lod >= 0.0) {
    let k = (size - 2.0) / size;
    return textureSampleGrad(nightTex, tileSampler, uv, layer, dx * k, dy * k).r;
  }
  let st = uv * size - 0.5;
  let i = floor(st);
  let f = st - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let w2 = 1.0 - w0 - w1 - w3;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  let cubic =
    (textureSampleLevel(nightTex, tileSampler, vec2f(h0.x, h0.y), layer, 0.0).r * g0.x + textureSampleLevel(nightTex, tileSampler, vec2f(h1.x, h0.y), layer, 0.0).r * g1.x) * g0.y +
    (textureSampleLevel(nightTex, tileSampler, vec2f(h0.x, h1.y), layer, 0.0).r * g0.x + textureSampleLevel(nightTex, tileSampler, vec2f(h1.x, h1.y), layer, 0.0).r * g1.x) * g1.y;
  return mix(textureSampleLevel(nightTex, tileSampler, uv, layer, 0.0).r, cubic, saturate(-lod));
}

/// Night lights (pre-exposed). The layer is display-referred and saturates over city centres: a shoulder
/// gives the centres more luminance than the suburbs. Below the resolution of the layer the light of a town
/// is broken up into clusters by band-limited noise (octaves a pixel resolves, fixed to the ground), so a
/// close view from orbit shows grains of light, not evenly glowing cells. sphere = body-fixed direction.
fn nightEmission(t: TileRecord, uv: vec2f, k: f32, dx: vec2f, dy: vec2f, sphere: vec3f, sphereRoot: vec3f, footprint: f32) -> vec3f {
  if (body.night.w < 0.5 || t.images.z < 0) { return vec3f(0.0); }
  let bi = u32(body.p0.w);
  let muS = dot(sphereRoot, frame.bodies[bi].sunDir.xyz);
  let on = 1.0 - smoothstep(body.night.y, body.night.z, muS);
  if (on <= 0.0) { return vec3f(0.0); }
  // One channel, sRGB-encoded (the red of the night image).
  let texels = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)) * 65536.0, 1e-12));
  let uvN = t.nightUv.xy + uv * t.nightUv.z;
  var c = pow(nightSample(uvN, t.images.z, texels + log2(t.nightUv.z), dx * t.nightUv.z, dy * t.nightUv.z), 2.2);
  if (k > 0.0 && (t.flags.x & 2) != 0) {
    var p = 0.0;
    if (t.images.w >= 0) {
      let uvP = t.parentNightUv.xy + uv * t.parentNightUv.z;
      p = pow(nightSample(uvP, t.images.w, texels + log2(t.parentNightUv.z), dx * t.parentNightUv.z, dy * t.parentNightUv.z), 2.2);
    }
    c = mix(c, p, k);
  }
  if (c <= 0.0) { return vec3f(0.0); }
  // The centre of a city is one sheet of light, its outskirts and the villages are grains.
  let grain = body.nightTint.a * (1.0 - 0.7 * smoothstep(0.2, 0.85, c));
  c = c / (1.0 - 0.85 * min(c, 1.0));
  if (body.misc.w > 0.0) {
    // The direction on the body times radius / wavelength: at 2.4 km the lattice coordinate is about 2,700,
    // where 32-bit floats still resolve a thousandth of a cell.
    var q = sphere * (body.p0.x / body.misc.w);
    var lambda = body.misc.w;
    var m = 0.0;
    for (var i = 0; i < 4; i++) {
      m += noiseAt(q + vec3f(3.7, 11.3, 7.1)).a * smoothstep(1.5, 3.0, lambda / footprint);
      q = q.zxy * 2.0 + vec3f(5.3, 1.7, 9.1);
      lambda *= 0.5;
    }
    c *= exp2(grain * m);
  }
  return body.nightTint.rgb * (c * body.night.x * on * frame.exposure.x);
}
`;

const DETAIL_WGSL = /* wgsl */ `
struct ClassBlend {
  w0: vec4f,           // weights of materials 0..3
  w1: vec4f,           // weights of materials 4..7
  orb: vec4f,          // orbital amplitudes of the blended classes
}

/// Land-cover classes around a point of an image tile, blended as weight vectors (class ids themselves
/// cannot be filtered). Where a class texel spans many pixels the bilinear weights are sharpened with a
/// smoothstep ('sharp' = 1: between two classes the change takes the middle third of a texel, not all of
/// it), and the caller displaces the lookup by band-limited noise, so the line between two classes is
/// ragged like the edge of a thicket, never the straight side of a raster cell. Where a texel spans a few
/// pixels only ('sharp' = 0) the weights stay bilinear: sharpened there, the raster's cells drew a staircase.
fn classBlendAt(uvI: vec2f, layer: i32, sharp: f32) -> ClassBlend {
  let st = uvI * 256.0 - 0.5;
  let i0 = floor(st);
  let fl = st - i0;
  let f = mix(fl, smoothstep(vec2f(0.3), vec2f(0.7), fl), sharp);
  var o: ClassBlend;
  o.w0 = vec4f(0.0);
  o.w1 = vec4f(0.0);
  o.orb = vec4f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let p = clamp(vec2i(i0) + vec2i(i, j), vec2i(0), vec2i(255));
      let c = min(u32(textureLoad(auxTex, p, layer, 0).g * 255.0 + 0.5), ${MAX_CLASSES - 1}u);
      let w = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1);
      o.w0 += w * mat.classW[2u * c];
      o.w1 += w * mat.classW[2u * c + 1u];
      o.orb += w * mat.classOrb[c];
    }
  }
  return o;
}

fn classBlend(t: TileRecord, uv: vec2f, k: f32, warp: vec2f, sharp: f32) -> ClassBlend {
  var o = classBlendAt(t.imageUv.xy + (uv + warp) * t.imageUv.z, t.images.x, sharp);
  if (k > 0.0 && (t.flags.x & 1) != 0) {
    let p = classBlendAt(t.parentImageUv.xy + (uv + warp) * t.parentImageUv.z, t.images.y, sharp);
    o.w0 = mix(o.w0, p.w0, k);
    o.w1 = mix(o.w1, p.w1, k);
    o.orb = mix(o.orb, p.orb, k);
  }
  return o;
}

fn pick8(a: vec4f, b: vec4f, i: i32) -> f32 {
  if (i < 4) { return a[i]; }
  return b[i - 4];
}

struct DetailPlane {
  ratio: vec3f,        // albedo / mean albedo (of the layer, or of the part of it one imagery texel covers)
  height: f32,
  slope: vec2f,        // height gradient along the plane's two axes
  rough: f32,
  ao: f32,
  shadow: f32,         // share of the sun the layer's own relief keeps off the point (0 .. 1)
}

const HEX_PERIOD = ${HEX_PERIOD};

/// Random numbers of a vertex of the hexagon lattice: xy = texture offset, z = rotation in turns. The lattice
/// has a period of HEX_PERIOD tiling lengths along both plane axes (tile origins are kept modulo that), so a
/// vertex has the same numbers in every tile.
fn hexHash(v: vec2i) -> vec3f {
  let n = 2 * HEX_PERIOD;
  let j = i32(floor(f32(v.y) / f32(n)));
  let y = v.y - n * j;
  var x = (v.x + HEX_PERIOD * j) % n;
  if (x < 0) { x += n; }
  var h = u32(x) * 0x9E3779B1u + u32(y) * 0x85EBCA77u + 0x165667B1u;
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return vec3f(f32(h & 0x3ffu), f32((h >> 10u) & 0x3ffu), f32((h >> 20u) & 0x3ffu)) / 1024.0;
}

/// One layer on one projection plane, without visible repetition: the plane is covered by a triangle lattice
/// (triangles of half a tiling length); around every lattice vertex the layer is shown at a random offset
/// and rotation (about that vertex: the picture then does not depend on where the plane's origin lies, and
/// tiles whose origins differ by whole periods of the lattice agree along their common edge), and a pixel
/// blends the three vertices of its triangle with sharpened barycentric weights, the surface that stands out
/// from the layer's mean height winning (mat.p5: stones and, where the set says so, pits stay whole).
/// 'st' = plane position in tiling lengths. 'meanLod' >= 0: the albedo is divided by the layer's own average
/// over one imagery texel (that mip level) instead of its overall mean: what the imagery already shows of a
/// large layer is not added twice. 'meanH' = mean of the layer's height map, 'gloss' = roughness factor of
/// what stands above it. 'sun': xy = unit direction towards the sun along the plane's axes, z = rise of the
/// sun's rays per tiling length in units of the layer's height range (0 = no shadows wanted): the height map
/// of the copy that dominates the pixel is marched towards the sun, and what stands above the ray shadows
/// the point (a clod, a pebble, the rim of a craterlet cast a shadow on their neighbours, which a normal
/// map alone cannot).
fn detailPlane(scale: i32, layer: i32, mean: vec3f, meanH: f32, gloss: f32, meanLod: f32, st: vec2f, dx: vec2f, dy: vec2f, sun: vec3f) -> DetailPlane {
  var o: DetailPlane;
  o.ratio = vec3f(0.0);
  o.height = 0.0;
  o.slope = vec2f(0.0);
  o.rough = 0.0;
  o.ao = 0.0;
  o.shadow = 0.0;
  var domW = 0.0;
  var domUv = vec2f(0.0);
  var domRot = vec2f(1.0, 0.0);
  let sk = vec2f(2.0 * st.x - st.y, 2.0 * st.y);
  let base = floor(sk);
  let f = sk - base;
  let tz = 1.0 - f.x - f.y;
  let up = step(0.0, -tz);
  let s2 = 2.0 * up - 1.0;
  var w = vec3f(-tz * s2, up - f.y * s2, up - f.x * s2);
  w = w * w * w;
  w = w * w;
  w /= w.x + w.y + w.z;
  // A copy with a small share is not sampled; its share goes to zero continuously on the way there.
  w = max(w - vec3f(0.04), vec3f(0.0));
  w /= w.x + w.y + w.z;
  let b = vec2i(base);
  let iu = i32(up);
  var wsum = 0.0;
  for (var i = 0; i < 3; i++) {
    var wi = w[i];
    if (wi <= 0.0) { continue; }
    var v = b + vec2i(iu, iu);
    if (i == 1) { v = b + vec2i(iu, 1 - iu); }
    if (i == 2) { v = b + vec2i(1 - iu, iu); }
    let h = hexHash(v);
    let ang = h.z * 6.2831853;
    let c = cos(ang);
    let sn = sin(ang);
    // The vertex in plane coordinates (the inverse of the skew above).
    let q = st - vec2f(0.5 * f32(v.x) + 0.25 * f32(v.y), 0.5 * f32(v.y));
    let uv = vec2f(c * q.x - sn * q.y, sn * q.x + c * q.y) + h.xy;
    let ddx = vec2f(c * dx.x - sn * dx.y, sn * dx.x + c * dx.y);
    let ddy = vec2f(c * dy.x - sn * dy.y, sn * dy.x + c * dy.y);
    var a: vec4f;
    var n: vec4f;
    var local = mean;
    if (scale == 0) {
      a = textureSampleGrad(detailA, anisoRepeat, uv, layer, ddx, ddy);
      n = textureSampleGrad(detailB, anisoRepeat, uv, layer, ddx, ddy);
    } else {
      let wide = ${DETAIL_SCALES - 1} * layer + scale - 1;
      a = textureSampleGrad(detailWideA, anisoRepeat, uv, wide, ddx, ddy);
      n = textureSampleGrad(detailWideB, anisoRepeat, uv, wide, ddx, ddy);
      if (meanLod >= 0.0) { local = textureSampleLevel(detailWideA, anisoRepeat, uv, wide, meanLod).rgb; }
    }
    let dh = a.a - meanH;
    wi *= exp2(mat.p5.x * max(dh, 0.0) + mat.p5.y * max(-dh, 0.0));
    if (wi > domW) { domW = wi; domUv = uv; domRot = vec2f(c, sn); }
    let nxy = n.rg * 2.0 - 1.0;
    let nz = sqrt(max(1.0 - dot(nxy, nxy), 0.04));
    let g = -nxy / nz;
    o.ratio += wi * a.rgb / max(local, vec3f(1e-3));
    o.height += wi * a.a;
    // The gradient in the layer's own (rotated) axes, turned back into the plane's.
    o.slope += wi * vec2f(c * g.x + sn * g.y, -sn * g.x + c * g.y);
    o.rough += wi * n.b * mix(1.0, gloss, smoothstep(0.0, 0.2, dh));
    o.ao += wi * n.a;
    wsum += wi;
  }
  let inv = 1.0 / max(wsum, 1e-6);
  o.ratio *= inv;
  o.height *= inv;
  o.slope *= inv;
  o.rough *= inv;
  o.ao *= inv;
  if (sun.z > 0.0 && domW > 0.0) {
    // Six taps towards the sun in the dominant copy, 1.5 to 37 texels away, each from the mip level that
    // averages what lies between it and the last (a cone: far taps are wide, so the shadow of a far stone
    // has a soft edge and a near one a hard edge).
    let dir = vec2f(domRot.x * sun.x - domRot.y * sun.y, domRot.y * sun.x + domRot.x * sun.y);
    var size = f32(textureDimensions(detailA).x);
    var wide = 0;
    if (scale != 0) {
      size = f32(textureDimensions(detailWideA).x);
      wide = ${DETAIL_SCALES - 1} * layer + scale - 1;
    }
    let lod0 = max(0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)) * size * size, 1e-12)), 0.0);
    var d = 1.5 * exp2(lod0) / size;
    var h0: f32;
    if (scale == 0) { h0 = textureSampleLevel(detailA, linearRepeat, domUv, layer, lod0).a; }
    else { h0 = textureSampleLevel(detailWideA, linearRepeat, domUv, wide, lod0).a; }
    var occ = 0.0;
    for (var i = 0; i < 6; i++) {
      var h: f32;
      let lod = lod0 + 0.6 * f32(i);
      if (scale == 0) { h = textureSampleLevel(detailA, linearRepeat, domUv + dir * d, layer, lod).a; }
      else { h = textureSampleLevel(detailWideA, linearRepeat, domUv + dir * d, wide, lod).a; }
      occ = max(occ, h - h0 - d * sun.z);
      d *= 1.9;
    }
    o.shadow = smoothstep(0.0, 0.05, occ);
  }
  return o;
}

struct DetailLayer {
  ratio: vec3f,        // albedo / mean albedo of the layer
  height: f32,         // height above the layer's mean, in units of the layer's height range
  grad: vec3f,         // height gradient in body-fixed axes (surface-gradient form of the detail normal)
  rough: f32,
  ao: f32,
  shadow: f32,         // share of the sun the layer's relief keeps off the point
}

/// One material at one scale, triplanar in body-fixed axes. 'p' = planet-fixed position in tiling lengths,
/// 'dpx' / 'dpy' its screen derivatives, 'w' the projection weights, 'meanLod' as in detailPlane. 'sun': xyz
/// = unit direction towards the sun (body-fixed), w = tangent of its elevation above the terrain times the
/// layer's tiling length (m); 0 = no shadows of the relief wanted (they are marched on the plane that carries
/// most of the pixel).
fn detailSample(scale: i32, material: i32, meanLod: f32, p: vec3f, dpx: vec3f, dpy: vec3f, w: vec3f, sun: vec4f) -> DetailLayer {
  var o: DetailLayer;
  o.ratio = vec3f(0.0);
  o.height = 0.0;
  o.grad = vec3f(0.0);
  o.rough = 0.0;
  o.ao = 0.0;
  o.shadow = 0.0;
  let info = mat.layer[material * ${DETAIL_SCALES} + scale];
  let infoB = mat.layerB[material * ${DETAIL_SCALES} + scale];
  let meanH = infoB.x;
  let wTop = max(w.x, max(w.y, w.z));
  for (var axis = 0; axis < 3; axis++) {
    let wa = w[axis];
    if (wa <= 0.0) { continue; }
    var st: vec2f;
    var dx: vec2f;
    var dy: vec2f;
    var au: vec3f;
    var av: vec3f;
    if (axis == 0) { st = p.yz; dx = dpx.yz; dy = dpy.yz; au = vec3f(0.0, 1.0, 0.0); av = vec3f(0.0, 0.0, 1.0); }
    else if (axis == 1) { st = p.zx; dx = dpx.zx; dy = dpy.zx; au = vec3f(0.0, 0.0, 1.0); av = vec3f(1.0, 0.0, 0.0); }
    else { st = p.xy; dx = dpx.xy; dy = dpy.xy; au = vec3f(1.0, 0.0, 0.0); av = vec3f(0.0, 1.0, 0.0); }
    // Ground seen at a shallow angle has a footprint many times longer than wide. Past the sampler's 16
    // taps the filter would pick its level by the long axis, a mip level coarser for every doubling: the
    // ground 50 m ahead of a standing eye loses its grain. The long axis is shortened by up to a quarter, so
    // the level stays the short axis's up to a ratio of 21 (less than half a level of undersampling along
    // the line of sight; a half, as it was, combed the middle distance into streaks).
    let lx = dot(dx, dx);
    let ly = dot(dy, dy);
    let shorten = clamp(16.0 * sqrt(max(min(lx, ly), 1e-24) / max(max(lx, ly), 1e-24)), 0.75, 1.0);
    if (lx > ly) { dx *= shorten; } else { dy *= shorten; }
    var sunP = vec3f(0.0);
    if (sun.w > 0.0 && wa >= wTop) {
      let s2 = vec2f(dot(sun.xyz, au), dot(sun.xyz, av));
      let l2 = length(s2);
      if (l2 > 0.05) { sunP = vec3f(s2 / l2, sun.w / max(info.a, 1e-4)); }
    }
    // (Gloss is of the crests of lobes and ropes, the near and mid layers' sizes: on the far layer's metre-high
    // swells it made glossy patches tens of metres wide that mirrored the sky like salt pans.)
    let d = detailPlane(scale, material, info.rgb, meanH, select(1.0, infoB.y, scale < 2), meanLod, st, dx, dy, sunP);
    o.shadow = max(o.shadow, d.shadow);
    o.ratio += wa * d.ratio;
    o.height += wa * (d.height - meanH);
    o.grad += wa * (d.slope.x * au + d.slope.y * av);
    o.rough += wa * d.rough;
    o.ao += wa * d.ao;
  }
  return o;
}

struct SiteGround {
  concrete: f32,       // signed distance to the concrete of the site, m (negative inside)
  gravel: f32,         // signed distance to its gravel (lane beds and the shoulder around the concrete), m
  q: vec2f,            // position in the frame of the nearest slab, m
}

/// The ground plan of launch site 'site' at 'rel' (body-fixed offset from the pad centre): the twin of
/// siteGround in sitePlan.ts.
fn siteGround(rel: vec3f, site: i32) -> SiteGround {
  let fe = mat.siteFrame[2 * site];
  let fn_ = mat.siteFrame[2 * site + 1];
  let en = vec2f(dot(rel, fe.xyz), dot(rel, fn_.xyz));
  var o: SiteGround;
  o.concrete = 1e6;
  o.gravel = 1e6;
  o.q = en;
  let first = i32(fe.w);
  let count = i32(fn_.w);
  for (var i = first; i < first + count; i++) {
    let a = mat.siteShape[2 * i];
    let b = mat.siteShape[2 * i + 1];
    let d = en - a.xy;
    // Shape axes: x = east turned clockwise by the heading, z = minus the heading direction.
    let p = vec2f(d.x * b.x - d.y * b.y, -(d.x * b.y + d.y * b.x));
    let k = abs(p) - (a.zw - vec2f(b.w));
    let sd = length(max(k, vec2f(0.0))) + min(max(k.x, k.y), 0.0) - b.w;
    if (b.z < 0.5) {
      if (sd < o.concrete) { o.concrete = sd; o.q = p; }
    } else {
      o.gravel = min(o.gravel, sd);
    }
  }
  o.gravel = min(o.gravel, o.concrete - mat.p5.w);
  return o;
}

struct Detail {
  albedoRatio: vec3f,  // albedo / mean albedo of the blended materials
  ratioFirst: vec3f,   // the same of the first material alone, and of the second (1 where the detail has faded)
  ratioSecond: vec3f,
  matAlbedo: vec3f,    // mean albedo of the blended materials: what the ground is made of
  chroma: f32,         // share of their colour variation the blended materials keep on that albedo
  first: i32,
  second: i32,
  grad: vec3f,
  rough: f32,
  roughMix: f32,
  ao: f32,
  aerial: f32,         // how much of the aerial layer shows (the orbital noise gives way to it)
  shadow: f32,         // share of the sun the detail relief keeps off the pixel (0 .. 1)
}

/// Imagery-anchored detail: four scales, each a layer with content of its own size (near: grains, pebbles and
/// blades; mid: stones, tufts and cracks; far: patches, bushes and small craters; aerial: thickets, gullies,
/// flow fronts and craters), the two heaviest materials height-blended, every scale faded by its size on
/// screen (never by tile level). 'normalTexel' / 'imageTexel' = ground size of a texel of the tile's normal
/// map / of the imagery: the far and aerial layers are of sizes the terrain and the imagery carry themselves
/// once they are fine enough; their relief gives way as the tile's normal map resolves it (by the share
/// mat.p5.z: all of it where the layers hold what the height function also holds, craters; little where
/// they hold what it does not, bushes and tussocks), and their albedo keeps only what is finer than the
/// imagery. 'site' = share of the pixel under a site's concrete and under its gravel; 'shore' = how much the
/// ground is low, level and at the water's edge; 'sun' = direction towards the sun (body-fixed) and the
/// tangent of its elevation above the terrain (0 = the relief casts no shadows).
fn terrainDetail(t: TileRecord, local: vec3f, dlx: vec3f, dly: vec3f, facing: vec3f, cb: ClassBlend, channel: f32, slopeMag: f32,
                 dist: f32, footprint: f32, site: vec2f, shore: f32, normalTexel: f32, imageTexel: f32, imagery: vec3f, sun: vec4f) -> Detail {
  var o: Detail;
  o.albedoRatio = vec3f(1.0);
  o.ratioFirst = vec3f(1.0);
  o.ratioSecond = vec3f(1.0);
  o.grad = vec3f(0.0);
  o.rough = mat.p2.x;
  o.roughMix = 0.0;
  o.ao = 1.0;
  o.aerial = 0.0;
  o.shadow = 0.0;

  // Material weights: land cover, the bake's material channel, slope, macro noise, the colour of the
  // imagery (darkness, saturation, greenness: the measured colour corrects a land-cover class that lumps
  // different ground), the water's edge, and the ground plan of a launch site.
  let steep = smoothstep(mat.p0.x, mat.p0.y, slopeMag);
  let macroNoise = noiseAt((t.noise.xyz + local / body.orbital.x) * (body.orbital.x / mat.p1.w)).a;
  let top = max(imagery.r, max(imagery.g, imagery.b));
  let dark = 1.0 - saturate(luminance(imagery) / 0.12);
  let sat = smoothstep(0.25, 0.6, (top - min(imagery.r, min(imagery.g, imagery.b))) / max(top, 1e-4));
  let green = clamp((imagery.g - max(imagery.r, imagery.b)) / max(top, 1e-4), -0.5, 0.5);
  let w0 = max(cb.w0 + channel * mat.channelGain[0] + steep * mat.slopeGain[0] + macroNoise * mat.noiseGain[0] +
               dark * mat.albedoGain[0] + sat * mat.albedoGain[2] + green * mat.albedoGain[4] + shore * mat.shoreGain[0], vec4f(0.0));
  let w1 = max(cb.w1 + channel * mat.channelGain[1] + steep * mat.slopeGain[1] + macroNoise * mat.noiseGain[1] +
               dark * mat.albedoGain[1] + sat * mat.albedoGain[3] + green * mat.albedoGain[5] + shore * mat.shoreGain[1], vec4f(0.0));
  let count = i32(mat.p0.w);
  var first = 0;
  var second = 0;
  var wf = -1.0;
  var ws = -1.0;
  for (var m = 0; m < count; m++) {
    let w = pick8(w0, w1, m);
    if (w > wf) { second = first; ws = wf; first = m; wf = w; }
    else if (w > ws) { second = m; ws = w; }
  }
  // The second material shows (and is sampled) only where it has more than a quarter of the two weights:
  // patches of one material with bands of mixture between them, not a mixture everywhere.
  var blend = 0.0;
  if (ws > 0.0) { blend = 0.5 * saturate(4.0 * ws / (wf + ws) - 1.0); }
  let apronM = i32(mat.p0.z);
  let gravelM = i32(mat.p7.w);
  var slab = false;
  if (site.x > 0.0 && apronM >= 0) {
    // Concrete replaces whatever lies under it: its gravel shoulder, or the ground.
    if (site.y > 0.5 && gravelM >= 0) { second = gravelM; } else { second = first; }
    first = apronM;
    blend = 1.0 - site.x;
    slab = true;
  } else if (site.y > 0.0 && gravelM >= 0) {
    if (first != gravelM) { second = first; first = gravelM; blend = 1.0 - site.y; }
    else { blend *= 1.0 - site.y; }
  }
  o.first = first;
  o.second = second;
  var meanA = mat.anchor[first].rgb;
  var meanB = mat.anchor[second].rgb;
  if (first == gravelM && !slab) { meanA = mat.p8.rgb; }
  if (second == gravelM && slab) { meanB = mat.p8.rgb; }
  o.matAlbedo = mix(meanA, meanB, blend);
  let chromaA = mat.layerB[first * ${DETAIL_SCALES}].z;
  let chromaB = mat.layerB[second * ${DETAIL_SCALES}].z;
  o.chroma = mix(chromaA, chromaB, blend);

  let fadeEnd = body.morph.z;
  if (dist >= fadeEnd) { return o; }
  let distFade = 1.0 - smoothstep(0.6 * fadeEnd, fadeEnd, dist);

  // Triplanar weights from the terrain's own normal (the tile's normal map, without the detail it is about
  // to receive): on a slope the plane that faces it takes over, and nothing is stretched down a hillside.
  var tw = pow(abs(facing), vec3f(8.0));
  tw /= tw.x + tw.y + tw.z;
  // A plane with a small share is not sampled; its share goes to zero continuously on the way there.
  tw = max(tw - vec3f(0.12), vec3f(0.0));
  tw /= tw.x + tw.y + tw.z;

  var ratioA = vec3f(1.0);
  var ratioB = vec3f(1.0);
  var gradA = vec3f(0.0);
  var gradB = vec3f(0.0);
  var hA = 0.0;
  var hB = 0.0;
  var roughA = 0.0;
  var roughB = 0.0;
  var aoA = 1.0;
  var aoB = 1.0;
  var litA = 1.0;
  var wsum = 0.0;
  for (var s = 0; s < ${DETAIL_SCALES}; s++) {
    let inv = body.detailInv[s];
    let period = 1.0 / inv;
    let texel = mat.p4[s];
    // A scale shows while one repeat spans more than 8 pixels, fully from 24; and it has gone again where
    // one of its texels spans some tens of pixels (the ground at one's feet shows nothing of the aerial layer).
    let f = smoothstep(8.0, 24.0, period / footprint) * distFade * (1.0 - smoothstep(16.0, 64.0, texel / footprint));
    if (s == ${DETAIL_SCALES - 1}) { o.aerial = f; }
    if (f <= 0.0) { continue; }
    var relief = f;
    var meanLod = -1.0;
    if (s >= 2) {
      relief *= mix(1.0, smoothstep(1.0, 3.0, normalTexel / texel), mat.p5.z);
      meanLod = log2(max(2.0 * imageTexel / texel, 1.0));
    }
    var origin = t.detail0.xyz;
    if (s == 1) { origin = t.detail1.xyz; }
    if (s == 2) { origin = t.detail2.xyz; }
    if (s == 3) { origin = t.detail3.xyz; }
    let p = (origin + local) * inv;
    let dpx = dlx * inv;
    let dpy = dly * inv;
    // Shadows of the relief: only of relief that shows, and only while the sun stands low over the ground.
    var sunS = vec4f(0.0);
    if (sun.w > 0.0 && relief > 0.05) { sunS = vec4f(sun.xyz, sun.w * period); }
    let a = detailSample(s, first, meanLod, p, dpx, dpy, tw, sunS);
    ratioA *= mix(vec3f(1.0), a.ratio, f * mat.p1.x);
    gradA += a.grad * relief;
    hA += a.height * f;
    roughA += a.rough * f;
    aoA *= mix(1.0, a.ao, f * mat.p3.z);
    litA *= 1.0 - a.shadow * relief;
    if (blend > 0.002) {
      let b = detailSample(s, second, meanLod, p, dpx, dpy, tw, vec4f(0.0));
      ratioB *= mix(vec3f(1.0), b.ratio, f * mat.p1.x);
      gradB += b.grad * relief;
      hB += b.height * f;
      roughB += b.rough * f;
      aoB *= mix(1.0, b.ao, f * mat.p3.z);
    }
    wsum += f;
  }
  if (wsum <= 0.0) { return o; }
  // Height blend: the second material shows first where it stands higher (rock through sand, grass over
  // soil), over a share of the ground that follows its weight. Heights are sums over the scales, each in
  // units of its layer's own range. The edge of a slab is a kerb: no blend there.
  var bl = blend;
  if (blend > 0.002 && blend < 0.998 && !slab) {
    bl = saturate((hB - hA) * mat.p1.z + (blend - 0.5) * 3.5 + 0.5) * smoothstep(0.0, 0.06, blend);
    bl = mix(blend, bl, saturate(wsum));
  }
  o.albedoRatio = mix(ratioA, ratioB, bl);
  o.ratioFirst = ratioA;
  o.ratioSecond = ratioB;
  o.matAlbedo = mix(meanA, meanB, bl);
  o.chroma = mix(chromaA, chromaB, bl);
  o.grad = mix(gradA, gradB, bl) * mat.p1.y;
  o.roughMix = saturate(wsum);
  o.rough = mix(roughA, roughB, bl) / wsum;
  o.ao = mix(aoA, aoB, bl);
  o.shadow = (1.0 - litA) * (1.0 - bl);
  return o;
}

struct Orbital {
  albedo: f32,         // multiplicative albedo modulation
  grad: vec3f,         // extra height gradient (body-fixed)
}

/// Orbital-scale detail (ARCHITECTURE 7.1): octaves of band-limited noise between the pixel footprint and
/// what the imagery (albedo) and the tile's normal map (relief) resolve.
fn orbitalDetail(t: TileRecord, local: vec3f, cb: ClassBlend, footprint: f32, imageTexel: f32, normalTexel: f32, steep: f32) -> Orbital {
  var o: Orbital;
  o.albedo = 1.0;
  o.grad = vec3f(0.0);
  let ampA = cb.orb.x * body.orbital.y * (1.0 + steep);
  let ampN = cb.orb.y * body.orbital.z;
  if (ampA <= 0.0 && ampN <= 0.0) { return o; }
  let octaves = i32(body.orbital.w);
  var q = t.noise.xyz + local / body.orbital.x;
  var lambda = body.orbital.x;
  var gain = 1.0;
  var sumA = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    // Resolvable by the pixel (2 px per wavelength at least, full at 4) ...
    let wPix = smoothstep(2.0, 4.0, lambda / footprint);
    // ... and absent from the data: shorter than about 3 imagery texels / 4 normal-map texels.
    let wImg = 1.0 - smoothstep(2.0, 4.0, lambda / imageTexel);
    let wNrm = 1.0 - smoothstep(4.0, 8.0, lambda / normalTexel);
    if (wPix * (wImg + wNrm) > 0.0) {
      // Decorrelate the octaves by permuting the axes.
      var p = q;
      if ((i & 1) == 1) { p = q.zxy + vec3f(17.3, 5.1, 9.7); }
      let n = noiseAt(p);
      sumA += n.a * gain * wPix * wImg;
      var g = n.rgb;
      if ((i & 1) == 1) { g = n.gbr; }
      // Gradient of a unit-amplitude octave is 1 / lambda per metre: relief amplitude is ampN x lambda.
      o.grad += g * (gain * wPix * wNrm * ampN);
    }
    norm += gain;
    q *= 2.0;
    lambda *= 0.5;
    gain *= 0.75;
  }
  o.albedo = max(1.0 + ampA * sumA * (2.0 / max(norm, 1e-3)), 0.2);
  return o;
}
`;

export const TERRAIN_GBUFFER_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"
${TERRAIN_COMMON_WGSL}
${SURFACE_BINDINGS_WGSL}
OCEAN_NEAR_FIELD_BINDINGS
${VARYINGS_WGSL}
${SURFACE_FUNCTIONS_WGSL}
${DETAIL_WGSL}

@vertex fn vs(@location(0) grid: vec4u, @builtin(instance_index) instance: u32) -> TerrainVaryings {
  return terrainVaryings(terrainVertex(grid, instance, false));
}

@fragment fn fs(in: TerrainVaryings) -> GBufferOut {
  let t = tiles[in.rec];
  let uv = in.uvk.xy;
  let k = in.uvk.z;
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  let dlx = dpdx(in.local);
  let dly = dpdy(in.local);
  let dist = length(in.pos);
  let pixelAngle = 2.0 * frame.cameraUp.w * frame.renderSize.w;
  let footprint = max(dist * pixelAngle, 1e-4);
  // The long axis of the pixel's footprint on the ground: towards the limb and at a shallow angle it is many
  // times the distance-based size. Noise read without filtering (orbital detail, the lights' grain) must
  // leave out every octave shorter than it, or those octaves alias into streaks along the line of sight.
  let footLong = max(footprint, max(length(dlx), length(dly)));
  // Imagery resolution at the fragment: the level of the image, capped by the effective level of the
  // imagery there (regional imagery is feathered to its parent over the edge of its coverage).
  let lv = mix(mix(t.detail0.w, t.detail1.w, uv.x), mix(t.detail2.w, t.noise.w, uv.x), uv.y);
  let levelSize = body.misc.z;
  let tileSize = levelSize * exp2(-t.b.w);
  let warp = imageryWarp(t, in.local, levelSize * exp2(-min(t.imageUv.w, lv)) / 256.0, footprint) / tileSize;
  var s = sampleTile(t, uv, k, dx, dy, warp);
  let tn = tileNormal(t, uv, s.slope);
  let velocity = velocityFromClip(in.currClip, in.prevClip);
  let sphereRoot = body.rot * tn.sphere;
  // (The grain of the lights fades by the long axis of the pixel's footprint on the ground.)
  let emissive = nightEmission(t, uv, k, dx, dy, tn.sphere, sphereRoot, footLong);
  let sea = body.p0.y;
  let above = in.height - sea;
  let hasOcean = body.misc.y > 0.5;

  // ---- water written by the terrain: lakes and rivers at any distance; near sea level only while the
  // mask still decides the coastline (the threshold slides to "never" as the geometry takes over), and
  // never inside the ocean's near field, where the sea bed and the shore are ordinary terrain under the
  // forward water surface. (No fragment returns early: the land is shaded for every one of them, so that the
  // screen derivatives of its final normal further down are taken in uniform control flow. Terrain
  // fragments that end as water are few.)
  var water = false;
  var waterColour = vec3f(0.0);
  var waterDepth = 0.0;
  var inNearField = false;
  if (hasOcean) {
    var influence = maskInfluence(t, k, s.imageLevel);
    if (oceanNearField.bodyIndex == i32(body.p0.w)) {
      // What the near field replaces is the sea SURFACE on this pixel's ray. Below sea level that point is
      // nearer than the fragment (a sea bed 5 km down is beyond fadeStart under a surface that is not).
      let eyeAbove = dot(-in.pos, sphereRoot);
      var surfaceDist = dist;
      if (above < 0.0 && eyeAbove > -above) { surfaceDist = dist * (eyeAbove + above) / eyeAbove; }
      if (surfaceDist < oceanNearField.fadeStart) {
        influence = 0.0;
        inNearField = true;
      }
    }
    // The mask decides the coastline only where the ground is at sea level within what coarse quads can be
    // wrong by (a pool the mask shows a few metres above the sea would be water from afar and dry lava from
    // near, where the geometry decides).
    let coastal = 1.0 - smoothstep(0.75, 2.0, above);
    // Away from sea level the mask alone says "lake", and it is believed only where the ground is level: a
    // pond lies flat, and the land-cover source behind the mask also calls dark lava and shadowed slopes water.
    let levelGround = 1.0 - smoothstep(0.03, 0.07, tn.slopeMag);
    let threshold = mix(mix(1.01, 0.5, levelGround), mix(1.01, 0.5, influence), coastal);
    if (s.mask > threshold) {
      water = true;
      waterColour = waterAlbedo(s.albedo, max(-above, 0.0));
      let offshore = saturate((s.mask - 0.5) * 2.0);
      waterDepth = max(-above, 0.0) + mat.p2.w * offshore;
      // A pond above sea level: the imagery there is the colour of its banks, not of water. Dark, wet margins,
      // and the colour of deep water towards its middle.
      if (body.deepWater.w > 0.0) { waterColour = mix(waterColour, mix(0.35 * waterColour, body.deepWater.rgb, offshore), 1.0 - coastal); }
    }
  }

  // ---- land the mask and the imagery disagree about. The body-wide imagery paints the sea one fill colour
  // (body.deepWater) from a coarser coastline than the mask's: islets and a rim of the coast are land in the
  // mask and fill in the image, and the texels next to them are ramps towards it. Fill at sea level is water
  // (the sheet's colour; never inside the ocean's near field, which holds no terrain-written water); a ramp
  // gives way to the brightest of the texels around it by as much as it is a ramp (a continuous weight: no
  // texel-shaped patches); fill that stands above the sea is land of unknown colour and takes its material's.
  var fillLand = 0.0;
  if (!water && hasOcean && body.deepWater.w > 0.0 && s.maskWide > 0.004) {
    let texel = 1.25 / 256.0;
    var best = s.albedo;
    let f0 = fillness(s.albedo);
    var nearFill = f0;
    var allFill = f0;
    for (var i = 0; i < 4; i++) {
      let o = vec2f(select(-texel, texel, (i & 1) == 1), 0.0);
      let tap = textureSampleLevel(albedoTex, tileSampler, s.uvImage + select(o, o.yx, i >= 2), s.imageLayer, 0.0).rgb;
      let ft = fillness(tap);
      nearFill = max(nearFill, ft);
      allFill = min(allFill, ft);
      if (luminance(tap) > luminance(best)) { best = tap; }
    }
    if (allFill > 0.5 && above < 3.0 && !inNearField) {
      water = true;
      waterColour = waterAlbedo(s.albedo, body.deepWater.w);
      waterDepth = max(-above, 0.0) + mat.p2.w;
    } else if (nearFill > 0.0) {
      s.albedo = mix(s.albedo, best, nearFill * (1.0 - smoothstep(0.3, 0.8, luminance(s.albedo) / max(luminance(best), 1e-5))));
      fillLand = smoothstep(0.5, 1.0, allFill);
    }
  }

  // ---- land
  // The class raster is looked up where the imagery is, and displaced further by noise of 45 m, 14 m and
  // 5 m (as far as half a class cell for the shorter ones, never more than 0.4 wavelengths): a cell's
  // straight sides become the ragged edge of a thicket or a flow, and a row of cells of one class a
  // meandering band, not a staircase.
  let classTexel = levelSize * exp2(-min(s.imageLevel, lv)) / 256.0;
  let classLattice = t.noise.xyz + in.local / body.orbital.x;
  let c0 = max(round(body.orbital.x / 45.0), 1.0);
  let c1 = max(round(body.orbital.x / 14.0), 1.0);
  // (Each octave only where the pixel resolves it: read unfiltered, a shorter one is per-pixel noise. An
  // octave that does not show is not read: from orbit none is.)
  var classWarp = vec2f(0.0);
  let wc0 = min(0.8 * classTexel, 12.0) * smoothstep(1.5, 3.0, 45.0 / footLong);
  if (wc0 > 0.0) {
    let cn0 = noiseAt(classLattice.zxy * c0 + vec3f(3.9, 5.2, 0.7));
    classWarp += wc0 * vec2f(cn0.a, clamp(0.5 * cn0.r, -1.0, 1.0));
    let wc1 = min(0.55 * classTexel, 5.6) * smoothstep(1.5, 3.0, 14.0 / footLong);
    if (wc1 > 0.0) {
      let cn1 = noiseAt(classLattice * c1 + vec3f(7.3, 1.9, 4.4));
      classWarp += wc1 * vec2f(cn1.a, clamp(0.5 * cn1.r, -1.0, 1.0));
      let wc2 = min(0.3 * classTexel, 1.9) * smoothstep(1.5, 3.0, 4.7 / footLong);
      if (wc2 > 0.0) {
        let cn2 = noiseAt(classLattice.yzx * (3.0 * c1) + vec3f(2.1, 8.7, 6.3));
        classWarp += wc2 * vec2f(cn2.a, clamp(0.5 * cn2.r, -1.0, 1.0));
      }
    }
  }
  classWarp /= tileSize;
  let cb = classBlend(t, uv, k, warp + classWarp, smoothstep(3.0, 8.0, classTexel / footLong));
  let steep = smoothstep(mat.p0.x, mat.p0.y, tn.slopeMag);

  let imageTexel = levelSize * exp2(-min(s.imageLevel, lv)) / 256.0;
  let normalTexel = levelSize * exp2(-(t.b.w - k)) / 256.0;

  // ---- the ground plan of a launch site: concrete slabs with a clean kerb (one pixel wide at any
  // distance), gravel beds and a compacted shoulder whose outer edge is ragged (band-limited noise fixed to
  // the ground).
  var apron = 0.0;
  var gravel = 0.0;
  var slabQ = vec2f(0.0);
  var kerb = 0.0;
  var siteNoise = vec2f(0.0);
  if (t.pad.w > 0.0) {
    let rel = in.local - t.pad.xyz;
    if (dot(rel, rel) < t.pad.w * t.pad.w) {
      let sg = siteGround(rel, i32(t.detail3.w));
      let lattice = t.noise.xyz + in.local / body.orbital.x;
      let r1 = max(round(body.orbital.x / 7.0), 1.0);
      let n1 = noiseAt(lattice * r1).a;
      let n2 = noiseAt(lattice.zxy * (5.0 * r1) + vec3f(3.1, 7.7, 5.3)).a;
      siteNoise = vec2f(n1, n2);
      let w = max(0.02, 0.75 * footprint);
      apron = 1.0 - smoothstep(-w, w, sg.concrete);
      let ragged = sg.gravel + mat.p5.w * (0.5 * n1 + 0.2 * n2);
      let wg = max(0.35, 0.75 * footprint);
      gravel = (1.0 - smoothstep(-wg, wg, ragged)) * (1.0 - apron);
      slabQ = sg.q;
      kerb = sg.concrete;
    }
  }
  // Size of the pixel along the slab's axes (taken here, in uniform control flow).
  let slabPixel = fwidth(slabQ);
  var shore = 0.0;
  if (hasOcean) {
    shore = (1.0 - smoothstep(0.4 * mat.p9.x, mat.p9.x, above)) * smoothstep(0.0, 0.02, s.maskWide) * (1.0 - steep);
  }
  // The sun over the terrain (its own normal, without the detail): direction in body-fixed axes and the
  // tangent of its elevation; the detail relief casts shadows while that is below about 40 degrees.
  let sunRoot = frame.bodies[u32(body.p0.w)].sunDir.xyz;
  let sunFixed = sunRoot * body.rot;
  let muTerrain = dot(tn.n, sunFixed);
  var sun = vec4f(0.0);
  if (mat.p8.a > 0.0 && muTerrain > 0.01 && muTerrain < 0.66) {
    sun = vec4f(sunFixed, muTerrain / sqrt(1.0 - muTerrain * muTerrain));
  }
  let detail = terrainDetail(t, in.local, dlx, dly, tn.n, cb, s.channel, tn.slopeMag, dist, footprint, vec2f(apron, gravel), shore, normalTexel, imageTexel, s.albedo, sun);
  let orb = orbitalDetail(t, in.local, cb, footLong, imageTexel, normalTexel, steep);

  // ---- colour. The imagery is a picture, not an albedo map: a regional mosaic is graded dark and
  // saturated. Where it is calibrated (mat.p6) it keeps a share of its saturation, and the ground takes the
  // albedo of the material it is made of, times the imagery's brightness relative to its usual one (bounded):
  // mostly so where a pixel is finer than the imagery (the materials are what one sees), less from afar.
  let calibrated = select(smoothstep(mat.p6.x, mat.p6.x + 1.0, min(s.imageLevel, lv)), 1.0, mat.p6.x < 0.0);
  let lumI = luminance(s.albedo);
  let image = mix(vec3f(lumI), s.albedo, mix(1.0, mat.p6.y, calibrated));
  let finer = smoothstep(1.0, 4.0, imageTexel / footprint);
  let anchor = max(calibrated * mix(mat.p7.y, mat.p7.x, finer), fillLand);
  let rel = clamp(pow(max(lumI, 1e-4) / mat.p6.z, mat.p6.w), 0.6, 1.3);
  // Where the body anchors its ground to materials, the share the imagery keeps is bounded in brightness too
  // (to 1.6 times the material's): a strip the mosaic paints cream along this coast (sRGB 211, 180, 125) is
  // dry grass and weathered rock, about as bright as the sea beside it, not three times brighter.
  let lumM = luminance(detail.matAlbedo);
  let bounded = image * min(1.0, 1.6 * lumM / max(lumI, 1e-4));
  let ground = mix(select(image, mix(image, bounded, calibrated), mat.p7.x > 0.0), detail.matAlbedo * mix(rel, 1.0, fillLand), anchor);
  // The detail mostly modulates brightness on imagery colour; on the material's own colour it is the material.
  let lumR = max(luminance(detail.albedoRatio), 1e-3);
  // The orbital noise stands in for structure nobody has data for; where the aerial layer shows, it has it.
  var albedo = ground * mix(vec3f(lumR), detail.albedoRatio, mix(mat.p3.w, detail.chroma, anchor)) * mix(orb.albedo, 1.0, 0.75 * detail.aerial);
  // Fresh material (crater ejecta, exposed rock) is brighter than the mature surface around it.
  albedo *= 1.0 + mat.p3.y * smoothstep(0.25, 0.9, s.channel);
  var roughScale = 1.0;
  var siteAo = 1.0;
  if (gravel > 0.0 && mat.p7.w >= 0.0) {
    // Compacted gravel: its own colour; wheel-worn and paler towards the concrete, dirtier at its ragged edge.
    var gr = detail.ratioFirst;
    if (detail.first != i32(mat.p7.w)) { gr = detail.ratioSecond; }
    let worn = 1.0 + 0.18 * siteNoise.x + 0.1 * (1.0 - smoothstep(0.0, mat.p5.w, kerb));
    albedo = mix(albedo, mat.p8.rgb * mix(vec3f(luminance(gr)), gr, 0.6) * worn, gravel);
    // The foot of the kerb is in the slab's shade.
    siteAo = mix(1.0, 0.55, (1.0 - smoothstep(0.0, 0.5, kerb)) * gravel);
  }
  if (apron > 0.0 && mat.p0.z >= 0.0) {
    // Concrete is not in the imagery: it has the albedo of its own material at every distance. Slabs are
    // poured in bays: joints (a dark line, box-filtered to the pixel), a tone per bay, a few bays replaced
    // later and paler; stains that run with the fall of the slab, soot and scorch towards the middle of the
    // pad, a paler chamfer along the kerb.
    let bay = mat.p7.z;
    let cell = floor(slabQ / bay);
    let f = slabQ - cell * bay;
    let j = min(f, vec2f(bay) - f);
    let fp = max(slabPixel, vec2f(1e-4));
    let cover = saturate((min(j + 0.5 * fp, vec2f(0.014)) - max(j - 0.5 * fp, vec2f(-0.014))) / fp);
    let joint = max(cover.x, cover.y);
    let hb = hexHash(vec2i(cell));
    var tone = 0.86 + 0.28 * hb.x + 0.18 * smoothstep(0.88, 0.91, hb.y);
    // Dirt gathers along the joints.
    tone *= 1.0 - 0.14 * (1.0 - smoothstep(0.02, 0.25, min(j.x, j.y)));
    let stain = noiseAt(vec3f(slabQ.x / 13.0, slabQ.y / 2.1, 3.3)).a;
    let blotch = noiseAt(vec3f(slabQ.x / 5.3, slabQ.y / 4.7, 9.1)).a;
    tone *= 1.0 - 0.26 * smoothstep(0.1, 0.7, stain) - 0.18 * smoothstep(0.15, 0.8, blotch);
    let scorch = (1.0 - smoothstep(10.0, 46.0, length(slabQ))) * (0.75 + 0.25 * siteNoise.y);
    tone *= 1.0 - 0.5 * scorch;
    tone *= 1.0 + 0.1 * (1.0 - smoothstep(0.0, 0.3, -kerb));
    var concrete = mat.layer[i32(mat.p0.z) * ${DETAIL_SCALES}].rgb * detail.ratioFirst * tone;
    // Rust from the joints and soot are warm and dark.
    concrete = mix(concrete, concrete * vec3f(0.95, 0.8, 0.62), 0.6 * smoothstep(0.3, 0.8, stain) + 0.35 * scorch);
    concrete *= 1.0 - 0.8 * joint;
    albedo = mix(albedo, concrete, apron);
    roughScale = mix(1.0, 0.94 + 0.12 * hb.z, apron);
  }
  albedo = clamp(albedo, vec3f(0.0), vec3f(1.0));

  // Detail and orbital relief as surface gradients on top of the tile normal.
  var g = detail.grad + orb.grad;
  let materialId = u32(body.misc.x);
  var unresolved = 0.0;
  if (materialId == MATERIAL_REGOLITH) {
    // Without a sky nothing lights a slope the sun has set on: relief that exists only as a normal map
    // would still turn single pixels of it towards the sun (lit dots on a slope that is in the shadow of
    // itself). The detail gives way as the terrain's own normal reaches the terminator, and the slopes it
    // took out go into the spread of the facets the regolith BRDF integrates (below): a hillside near the
    // terminator is a grey of lit and shaded grains that darkens smoothly, not ink blots and black specks.
    let keep = smoothstep(-0.02, 0.1, muTerrain);
    let gt = g - tn.n * dot(g, tn.n);
    unresolved = (1.0 - keep * keep) * dot(gt, gt);
    g *= keep;
  }
  g -= tn.n * dot(g, tn.n);
  let nFixed = normalize(tn.n - g);
  let n = body.rot * nFixed;
  // Slope variance between neighbouring pixels, of the normal that is written (control flow is uniform up to here).
  let ddn = dpdx(nFixed);
  let ddm = dpdy(nFixed);
  let pixelVariance = 0.25 * (dot(ddn, ddn) + dot(ddm, ddm));

  // Roughness: material roughness, widened by the slope variance the pixel cannot resolve (Toksvig):
  // the variance between neighbouring pixels plus the part of the tile's slope spectrum below the footprint.
  var rough = mix(mat.p2.x, detail.rough, detail.roughMix) * roughScale;
  let lod = max(0.5 * log2(max(dot(dx, dx), dot(dy, dy)) * 65536.0), 0.0);
  let sigma = 0.5 * t.parentUv.z;
  let variance = pixelVariance + sigma * sigma * saturate(lod / 7.0);
  rough = sqrt(saturate(rough * rough + min(variance * mat.p2.y, 0.5)));

  var param = s.channel;
  var metallic = 0.0;
  if (materialId == MATERIAL_TERRAIN) {
    // Wet ground along the shore: within the swash's reach above sea level, where water is near.
    param = 0.0;
    if (hasOcean) {
      // (Patchy: spray and pools wet the rock here and there, not as a ribbon.)
      let patchy = 0.55 + 0.45 * noiseAt((t.noise.xyz + in.local / body.orbital.x) * max(round(body.orbital.x / 9.0), 1.0)).a;
      param = (1.0 - smoothstep(0.25 * mat.p9.y, mat.p9.y, above)) * smoothstep(0.0, 0.02, s.maskWide) * saturate(patchy);
    }
  } else {
    // Regolith has no metal: the channel carries the RMS slope of what neighbouring pixels disagree about
    // (x 2), which the regolith BRDF of this package (shaders/lighting.ts) reads as the spread of the facets
    // within the pixel. Under a low sun a normal map that flips between lit and unlit from pixel to pixel
    // is then a grey of the right mean, not a pattern of black dots.
    // (Regolith is rough at every size a pixel holds: a floor of 3 degrees keeps a slope that the sun grazes
    // a grey of lit and shaded grains, not a blot.)
    metallic = saturate(2.0 * sqrt(pixelVariance + 0.0027 + unresolved));
  }
  if (water) {
    return gbufferPack(waterColour, 1.0, sphereRoot, 0.0, 0.0, MATERIAL_WATER, encodeWaterDepth(waterDepth), velocity, emissive);
  }
  var packed = gbufferPack(albedo, s.ao * detail.ao * siteAo, n, rough, metallic, materialId, param, velocity, emissive);
  // RT4.b of the terrain materials: the share of the sun that relief below the mesh keeps off the pixel
  // (read by this package's brdf_terrain and brdf_regolith; every other writer of these materials leaves 0).
  packed.extra.b = saturate(detail.shadow * mat.p8.a);
  // RT4.a: the smallest filter of the sun-shadow lookup, in metres on the ground (request terrain-render-4).
  // The terrain casts from its own tiles, so the shadow of a crater rim on its floor is drawn by a mesh of
  // quads of this tile's level: filtered over one such quad its edge is the smooth curve of the rim, not the
  // polygon (no gear teeth from orbit). Near the eye it is left to the lookup's own filter: a vessel's or a
  // tower's shadow there stays as sharp as the sun makes it.
  packed.extra.a = encodeShadowSoftness(4.0 * normalTexel * smoothstep(40.0, 160.0, dist));
  return packed;
}
`;

export const TERRAIN_WATER_WGSL = /* wgsl */ `
#include "frame"
#include "gbuffer"
${TERRAIN_COMMON_WGSL}
${SURFACE_BINDINGS_WGSL}
OCEAN_NEAR_FIELD_BINDINGS
${VARYINGS_WGSL}
${SURFACE_FUNCTIONS_WGSL}

@vertex fn vs(@location(0) grid: vec4u, @builtin(instance_index) instance: u32) -> TerrainVaryings {
  return terrainVaryings(terrainVertex(grid, instance, true));
}

@fragment fn fs(in: TerrainVaryings) -> GBufferOut {
  let t = tiles[in.rec];
  let uv = in.uvk.xy;
  let k = in.uvk.z;
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  let footLong = max(length(dpdx(in.local)), length(dpdy(in.local)));
  let s = sampleTile(t, uv, k, dx, dy, vec2f(0.0));
  // Inside the ocean's near field the forward pass draws the surface; depth and colour keep the seabed.
  if (oceanNearField.bodyIndex == i32(body.p0.w) && length(in.pos) < oceanNearField.fadeStart) { discard; }
  // Coastline per pixel from the mask while it is finer than the geometry; dry land with no water near it
  // (enclosed depressions) never gets a sheet.
  let influence = maskInfluence(t, k, s.imageLevel);
  if (s.mask < mix(-0.01, 0.5, influence) || s.maskWide < 0.004) { discard; }
  let sphere = normalize(t.cHat.xyz + tileDelta(uv, t));
  let sphereRoot = body.rot * sphere;
  let depth = max(body.p0.y - in.height, 0.0);
  let footprint = max(max(length(in.pos) * 2.0 * frame.cameraUp.w * frame.renderSize.w, 1e-4), footLong);
  let emissive = nightEmission(t, uv, k, dx, dy, sphere, sphereRoot, footprint);
  return gbufferPack(waterAlbedo(s.albedo, depth), 1.0, sphereRoot, 0.0, 0.0, MATERIAL_WATER, encodeWaterDepth(depth), velocityFromClip(in.currClip, in.prevClip), emissive);
}
`;
