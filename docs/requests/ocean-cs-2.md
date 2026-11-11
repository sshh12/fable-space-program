Status: open
From: core-support (follow-up of `atmosphere-clouds-6`, item 3)
Owner path: src/render/ocean/shaders/surfaceWgsl.ts (the forward surface's own copy of the cloud lookup, lines 160-188)
Blocking: no        (the far and near sea agree within 2 % at the place the integration check looks at, which is clear of cloud; under cloud they are lit by different rules)

## Problem
Since commit 926373f (`atmosphere-clouds-6`) the clouds split the sun into two parts. `'clouds.shadowMap'.r`
is the optical depth as the ground sees it (beam and diffuse transmission together), `.a` the beam's
optical depth as a multiple of it, and the deferred lighting multiplies the sun by the beam share and adds
the rest as white ambient light from the cloud base, with a third of the clear sky. The far sheet (deferred)
is lit that way. The forward surface inside `fadeStart` has its own copy of the old lookup: it reads `.r`
alone, so under a cloud it takes ALL the light that arrives as a directional sun (a sun glint and sharp
vessel shadows under an overcast) and gets no cloud-base light in its reflection. The copy is also not
depth-resolved (it never was: harmless at sea level, the sea is below every cloud).

## Evidence
- `src/render/ocean/shaders/surfaceWgsl.ts:183`: `let tau = textureSampleLevel(cloudShadowMapTex, ...).r * frame.cloudNear2.w; return mix(far, exp(-tau / muS), ...)`.
- What the core does with the same map, measured in `tests/browser/render-core/lighting.spec.ts`
  ("lighting inputs"), optical depth 0.5 with a = 4 and the sun 60 degrees up: beam share 0.099, total
  0.561; the ground in a cast shadow receives 0.452 of its clear sunlit value from the cloud base, where a
  shader with one factor gives 0.561 in the sun and 0 in the shadow.
- `tests/browser/atmosphere/shadows.spec.ts` on the same commit: lit quad under the deck 0.163 of clear.

## Requested change
Replace the copy by the core's chunk and light with its two shares (RENDER_API sections 7 and 17.6):

```wgsl
#include "cloud_shadow"
let cl = cloudLight(pos, i32(bi), up, r, sunDir);   // x = beam share, y = total share
// sun term (glint, vessel shadows): * cl.x
// sky reflection and sky irradiance: * mix(0.35, 1.0, cl.x), plus the cloud base as a uniform white sky:
//   irradiance  E_sun (after the atmosphere) * max(muS, 0) * (cl.y - cl.x) * (0.5 + 0.5 * dot(n, up))
//   luminance   that / PI * (0.5 + 0.5 * dot(reflection, up)) in the mirror direction
```

That is what `src/render/core/lighting/deferred.ts` does for the far sheet (search `cloudBase`). Must not
change: the agreement of forward and deferred water at `fadeStart` in clear air
(`tests/browser/integration/water.spec.ts`, "at fadeStart the forward water equals the deferred sheet").
