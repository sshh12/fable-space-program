/**
 * Reactive mask of the temporal resolve ('post.reactive', request ocean-4) for the near-field water.
 *
 * The motion vectors of the water describe the motion of the surface itself (particle orbits, swell, the
 * body's rotation, the camera), but the wind-wave PATTERN evolves on top of that: dispersive components in
 * many directions, each at its own phase speed, with no single motion vector. Where the shortest wave a
 * pixel resolves changes its phase quickly from frame to frame, the history holds a blur of earlier patterns;
 * this pass tells the resolve to trust the current frame more there.
 *
 * Per pixel where the forward water drew ('scene.depth' nearer than 'scene.depthOpaque'):
 *  - footprint of the pixel on the sea (m): distance x pixel angle, longer by 1 / sin(grazing) along the view
 *    (the surface is filtered with 4x anisotropy, so at most a factor 4 of it counts);
 *  - shortest resolved wavelength = 2 x footprint, its deep-water angular frequency (gravity from the ripple
 *    dispersion of this body, with the capillary term), its phase change over this frame's sim dt;
 *  - value = taaReactive x (1 - exp(-phase / 0.1 rad)) x the wave-detail fade towards fadeStart.
 * Inside the sun's glitter path the image is sparkles that are new every few frames (brdf_water draws them per
 * sea-anchored cell about 14 times a second): there the value rises to glintReactive, by how far the facet that
 * would mirror the sun into the pixel lies inside the Cox-Munk slope distribution.
 * With time frozen (dt = 0) the value is 0, so a still sea keeps the full history.
 */
export const REACTIVE_WGSL = (sceneBindings: string): string => /* wgsl */ `
${sceneBindings}
@group(2) @binding(0) var<uniform> oceanU: OceanUniforms;
// Declared for the shared chunk; this pass does not read them.
@group(2) @binding(1) var oceanDisp: texture_2d_array<f32>;
@group(2) @binding(2) var oceanDispPrev: texture_2d_array<f32>;
#include "ocean_waves"

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let pix = vec2i(in.position.xy);
  let dWater = textureLoad(sceneDepthTex, pix, 0);
  let dOpaque = textureLoad(sceneDepthOpaqueTex, pix, 0);
  // Reversed Z: the forward water is nearer than the opaque scene where it drew; elsewhere the copies are equal.
  if (dWater <= dOpaque || dWater <= 0.0) { discard; }
  let uv = in.position.xy * frame.renderSize.zw;
  let p = positionFromDepth(uv, dWater);
  let dist = length(p);
  let detail = oceanDetail(dist);
  if (detail <= 0.0) { discard; }
  let up = normalize(oceanRot(oceanU.cHat.xyz));
  let sinGrazing = abs(dot(p, up)) / max(dist, 1e-6);
  let pixelAngle = 2.0 * frame.cameraUp.w * frame.renderSize.w;
  let footprint = dist * pixelAngle * max(1.0, 0.25 / max(sinGrazing, 1e-3));
  let k = 3.14159265 / max(footprint, 0.005);
  // Gravity of this body from the ripple dispersion (omega^2 = g k at the ripple wavelength), surface tension of water.
  let g = oceanU.rippleParams.w * oceanU.rippleParams.w / max(oceanU.rippleParams.x, 1e-6);
  let omega = sqrt(g * k + 7.4e-5 * k * k * k);
  let phase = omega * oceanU.time.w;
  var r = oceanU.misc.w * detail * (1.0 - exp(-phase / 0.1));
  if (oceanU.time.w > 0.0) {
    // Slope of the facet that mirrors the sun into this pixel, against the sea's slope distribution.
    let hv = normalize(frame.bodies[i32(oceanU.refRel.w)].sunDir.xyz - p / max(dist, 1e-6));
    let ch = max(dot(hv, up), 1e-3);
    r = max(r, oceanU.glint.x * exp(-(1.0 - ch * ch) / (ch * ch) / (3.0 * oceanU.wind.y)));
  }
  if (r <= 0.0) { discard; }
  return vec4f(r);
}
`;
