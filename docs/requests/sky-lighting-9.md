Status: resolved (atmosphere-clouds, visual round 1; commit with this resolution)
From: sky-lighting
Owner path: src/render/atmosphere/** (the atmosphere composite), data/defs/render/earth.atmosphere.json
Blocking: no   (major finding 3 of the round-1 photo critic of the sky, `out/qa/wave2/sky-lighting.r1.photo.json`: outside `src/render/sky`)

## Problem
At the dark-adapted exposure (EV -6, the floor since request sky-lighting-3) the night sky is rich, and the
Earth under it is a pure black cut-out with a knife-edge limb and stars at full brightness down to the last
pixel above it. Nothing in the source emits airglow (the word does not occur under `src` or `data/defs`).
At that exposure the night Earth's own light is inside the displayed range: in every orbital night photograph
the limb carries a thin green-yellow band that is BRIGHTER than the Milky Way, with a fainter red layer above,
and the stars thin out into the limb haze.

## Evidence
- Reference: `out/qa/ref/sun-stars-space/milkyway-airglow.jpg` (limb band (88, 90, 66) against the Milky Way
  (47, 54, 67) and a night face of (59, 57, 46)), `out/qa/ref/earth-orbit-clouds/limb-panorama.jpg` (sky Y
  0.008, airglow peak Y 0.16 rgb (91, 106, 75), back to Y 0.04 within 3 % of the frame height below the peak),
  `airglow-red-yellow.jpg` (yellow-green shell under a red one, 1-2 % of the frame height).
- `out/screens/sky/leo-night-dark-adapted.png`, `perf-1440p-leo-horizon-night.png` (sky lab, no atmosphere) and
  the integration lab's low-orbit night views: the Earth's night face is 0/255 up to the limb.

## Requested change
1. An airglow layer in the atmosphere composite, from the body's atmosphere definition (no body id in code):
   a thin emitting shell (OI 557.7 nm green with the Na / OH continuum: peak near 95 km, about 8-10 km thick)
   and a fainter red one (OI 630 nm, 200-300 km, broad), optically thin, so the radiance along a ray is the
   emission integrated over its path through the shell (analytic for a spherical shell; van Rhijn brightening
   towards the limb follows from the geometry). Literature level: 250 R of 557.7 nm at the zenith from the
   ground is about 2e-4 cd/m^2 in total night-sky terms; seen edge-on from orbit the path is 30-40 times the
   vertical one, about 1e-3 to 3e-3 cd/m^2, which at EV -6 is 1.5 to 3 stops under mid-grey: brighter than the
   Milky Way (5e-4 to 1e-3), as in the photographs. Night side and day side alike (by day it is far below the
   scattered sunlight). Fields in `earth.atmosphere.json`, e.g. `airglow: [{ altitude, thickness,
   zenithLuminance, color }]`.
2. Extinction of the background (stars, Milky Way, a far body's image) through the limb by the composite's own
   transmittance, if it does not happen yet: in the sky lab's frames a star is at full brightness one pixel
   above the limb.
Must not change: the sky package's background is drawn before the composite and expects to be attenuated by
it; nothing in `src/render/sky` needs the layer (its probe takes in-scatter from 'atmosphere.skyViewLut'; if
the airglow is added to that table at night the probe lights a vessel with it for free).
The sky package asserts on its integration view (`tests/browser/sky/integration.spec.ts`, LEO night at the
automatic exposure) that the limb band is at least as bright as the Milky Way once this lands.

## Resolution
1. **Airglow layer** - done. `AtmosphereRenderDef.airglow` (contract field added by core-support on request
   `atmosphere-clouds-9`, `AirglowLayerDef`: peak altitude, full width at half maximum, zenith luminance,
   linear sRGB colour). Earth (`data/defs/render/earth.atmosphere.json`): a yellow-green layer at 95 km,
   9 km FWHM, 8e-5 cd/m^2 at the zenith (the 557.7 nm line with the sodium and hydroxyl light under it),
   and a red one at 250 km, 80 km FWHM, 6e-6 cd/m^2. Validated in `src/render/atmosphere/airglow.ts`
   (malformed layers are reported and left out; unit test `tests/unit/atmosphere/airglow.test.ts`).
   The per-pixel march (half resolution and the full-resolution tile of a small shell) integrates each
   optically thin Gaussian layer along the eye ray over the stretches within three sigma of its peak (eight
   samples each), so the van Rhijn brightening towards the limb comes from the geometry. What lies in front
   of the ray's lowest point is added in front of everything; what lies beyond it is attenuated by the
   transmittance of the whole path and hidden by any cloud in front of it. Day and night alike (by day it is
   lost in the scattered light). The march's screen rectangle reaches up to the highest layer (peak + 3 sigma).
   Measured (`tests/browser/atmosphere/screens.spec.ts`, scene `leo-night-airglow`: 400 km, sun 40 deg under
   the horizon, EV -5): the band 3.6e-3 cd/m^2 on the limb, rgb 3.0e-3 / 4.0e-3 / 1.2e-3 (yellow-green),
   above space by more than ten times, the red layer a faint glow above it; from the ground at EV -6 the
   sky near the horizon 1.5e-4 cd/m^2 and 1.0e-4 higher up. Screenshot
   `out/screens/atmosphere/leo-night-airglow.png`.
   Not done: the layer is not in `'atmosphere.skyViewLut'` (the probe does not light a vessel with it).
2. **Extinction of the background through the limb** - already the case: the composite writes
   `add + mul x destination` in one blend, `mul` being the transmittance of the path (and of the clouds),
   so stars, the Milky Way and far bodies drawn before it are dimmed through the limb. The sky lab has no
   atmosphere feature, which is why a star stands at full brightness above the limb there.

