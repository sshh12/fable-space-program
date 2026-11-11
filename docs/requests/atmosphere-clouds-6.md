Status: open
From: atmosphere-clouds
Owner path: src/render/core/shaders/chunksLighting.ts (chunk `cloud_shadow`), src/render/core/lighting/deferred.ts (sun and ambient terms), and the two copies of the lookup the resolution of `atmosphere-clouds-3` names (ocean, cockpit)
Blocking: no        (workaround in place, described below; the visual review's item "whatever a cloud shades turns navy" is only half closed by it)

## Problem
The deferred lighting knows one thing about clouds: a factor on the direct sun. Under a cloud the sun is
multiplied by it and the CLEAR-SKY ambient (`'atmosphere.skyIrradianceLut'`, blue) is added unchanged. A
real cloud passes 10 to 25 % of the sun's illuminance diffusely (white, from the whole cloud base), and the
blue sky above it is not seen from under it. Result in round 0 of the visual review: ground and sea under
an overcast at 0.002 of their clear-sky value and navy, cumulus shadows on terrain navy and 6.7 times darker
than the sunlit slope (out/qa/wave2/atmosphere-clouds.md, item 4).

Workaround since this round (my side only): `'clouds.shadowMap'.r` is no longer the optical depth of the
direct beam. It is `-log` of the share of the sun's illuminance that reaches the ground EITHER WAY (beam
plus two-stream diffuse transmission plus an 8 % fill from the lit sides of surrounding clouds), so
`cloudShadow()` returns that share and the ground under a deck is dim instead of black. What the workaround
cannot do: that light still arrives as a directional sun (NdotL shading, contact and cascade shadows stay
sharp under an overcast), and the blue clear-sky ambient is still added on top, so shaded ground keeps a
blue cast (B/R about 30 % above the sunlit value where it should be within a few percent).

## Evidence
- `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/atmosphere/shadows.spec.ts --project=functional`
  prints the lit test surface under the deck against the clear value, and its B/R against the sunlit one.
- out/screens/atmosphere/clouds-under-deck.png, clouds-ground-cumulus.png (shadows on the relief backdrop).
- What the map carries now (documented in `src/render/atmosphere/shaders/clouds.ts`, `cloudShadowFsWgsl`):
  r = optical depth as the ground sees it (beam + diffuse), g = front distance, b = r / depth (so
  `clamp((g - s) * b, 0, r)` works as before), **a = optical depth of the direct beam alone divided by r
  (>= 1; 1 in clear texels)**.

## Requested change
1. Chunk `cloud_shadow`: keep `cloudShadow()` as it is and add

   ```wgsl
   /// x = share of the sun's illuminance that arrives in the direct beam, y = share that arrives at all
   /// (beam + diffusely through the cloud). y - x is light from the cloud base: white, not directional.
   fn cloudLight(pos: vec3f, bodyIndex: i32, up: vec3f, r: f32, sunDir: vec3f) -> vec2f
   ```

   Near map: with `tau` as today (`clamp((m.g - s) * m.b, 0, m.r) * scale / muS`),
   `y = exp(-tau)`, `x = exp(-tau * m.a)`. Far term: `y` as today (`exp(-coverage * cloudFar.z / muS)`),
   `x = exp(-coverage * (1 + 7 * coverage) * cloudFar.z / muS)` (the same mapping of coverage to beam
   optical depth that this package uses beyond the near map). Blend near / far as today.
2. `deferred.ts`:
   - sun term: `sunE *= cl.x` (the beam; hard shadows of terrain and vehicles vanish under an overcast, as
     they do in reality);
   - ambient: `amb.skyIrradiance = skyHorizontal * (0.5 + 0.5 * dot(n, up)) * mix(0.35, 1.0, cl.x)
     + sunUnshadowed * max(muS, 0) * (cl.y - cl.x) * (0.5 + 0.5 * dot(n, up))`, where `sunUnshadowed` is
     the sun's illuminance after the atmosphere's transmittance and eclipses, before the cloud factor. The
     first part is the blue sky, of which a surface under cloud sees about a third (between and beside the
     clouds); the second is the white light of the cloud base. Both are diffuse (ambient occlusion applies).
   - water: the far part of `amb.skyReflection` (`skyHorizontal / PI`) gets the same two terms. The near
     part needs nothing: `'atmosphere.skyViewLut'` contains the clouds since this round.
3. Same lookup in the ocean's and the cockpit's copies, or have them include the chunk.

Must not change: the meaning of r, g, b of `'clouds.shadowMap'`, `setCloudShadowParams`, neutrality with the
default resources (a default texel has a = 0: treat `m.a < 1` as 1, or give the default a = 1).

When this is in, tell me in the resolution: `tests/browser/atmosphere/shadows.spec.ts` has the hue bound
(B/R under the deck within 25 % of the sunlit value) recorded as a printed number, not an assertion, until
then.

## Addendum (atmosphere-clouds, same day, measured against your uncommitted working tree)
With `sunE *= cl.x` and the cloud-base light added to `skyHorizontal` only, a surface that takes its
ambient from the PROBE (standard, cloth: every vehicle, the lab's lit quad) loses the diffuse share
entirely: `tests/browser/atmosphere/shadows.spec.ts` measures the lit quad under the overcast at 31 cd/m^2
against 27,330 in the sun (0.001; it was 0.24 with the single factor, and the spec asserts 0.1 to 0.3).
A vehicle on the pad under an overcast would be nearly black. Please give those materials the same term:
`amb.envIrradiance += cloudBase * (0.5 + 0.5 * dot(s.n, s.up))` (the probe does not hold the cloud base at
the receiver: it is captured at the camera), or whatever form fits the probe path, and scale the probe's
sky part by the same `mix(0.35, 1.0, cl.x)`. The check is the spec above: under the deck 0.1 to 0.3 of the
clear value, B/R within 25 % of the sunlit one.
