# Hand-off: cockpit (capsule interior, MFDs, crew view)

Package `cockpit`: the Kestrel capsule's interior as scene geometry in the deferred renderer, its three MFDs,
the physical attitude indicator, the window glass, the cabin light and the crew-view effects.

Owned paths: `src/render/cockpit/**`, `data/defs/visuals/cockpits/**`, `labs/cockpit/**`,
`tests/browser/cockpit/**`, `tests/unit/cockpit/**`, this file. (`public/assets/cockpit/**` and
`tools/cockpit/**` are unused: every texture is procedural or painted at run time, so no generated assets,
no API keys and no spend.)

## 1. API

```ts
import { createCockpitFeature } from '@/render/cockpit';

const { feature, controls } = createCockpitFeature(renderer.context, {
  navball,                        // NavballRenderer (src/ui): the app renders it every frame into 'ui.navball'
  mfdPainter: createMfdPainter(), // MfdPainter (src/ui)
  // id?: string (default 'cockpit'), order?: number (default 100: after plumes and plasma in drawTransparent)
});
await renderer.addFeature(feature);
// Input layer: action 'mfdCycle:i' -> controls.cyclePage(i). The feature never reads the keyboard.
```

- `CockpitControls` (contract in `src/core/contracts/ui.ts`): `displayCount` (3), `page(i)`, `setPage(i, page)`
  (RangeError on an unknown display or page), `cyclePage(i)` (walks `MFD_PAGES` in order and wraps). The
  implementation adds `onChange(listener)`.
- Which vessel: the camera's `insideVesselId`, else the active vessel, else any vessel whose vehicle has a
  `cockpit` layout and a command part. The layout is `VehicleDef.cockpit` (`kestrel`), found through
  `listSections(defs, 'visuals/cockpits/')`; it names the shared mould line it is built against.
- Shared resources: publishes `'ui.mfd'` (rgba8unorm-srgb 2D array, 1024 x 768 x 3, full mip chain); reads
  `'ui.navball'` (publishes the navball renderer's view itself if nobody did).
- Feature extras (tests, labs): `model(layoutId)`, `stats()` (`CockpitFrameStats`: active, lod, inside,
  triangles, cabin polygons, tunnel, vibration, display brightness, prepare ms), `displays` (`MfdDisplays`:
  stats, painted pages), `controlStates()`.
- Pure helpers (run in vitest): `buildCockpitModel(defs, id)`, `loadCockpitLayout`, `validateLayout`,
  `bindingState`, `controlStates`, `readoutText`, `digitMask`, `cabinSources`, `castCabinRay`,
  `insideDistance`, `openingsOf`, `seatFrames`.

## 2. What is there

Interior (`src/render/cockpit/cabin/*`, all dimensions from `data/defs/visuals/cockpits/kestrel.json` and the
shared mould line `visuals/shared/kestrel-mouldline.json`):

- Pressure shell: the cone offset inward by the wall thickness with exact openings for the five windows, the
  side hatch and its window; tunnel to the docking hatch; floor; five ring frames (T sections), 24 stringers,
  quilted blankets in the bays, close-out panels with fasteners, tie-down rails.
- Windows: bezel (tunnel, chamfer, face, outer ring), two panes each (5 mm and 22 mm in from the cabin-side face of the bezel) with gaskets,
  fasteners, placards, roller shades (cassette on the apex edge, rails, pull bar, fabric when drawn).
- Side hatch: seal ring, door with rib grid, window, gearbox and handle, ten latches with linkage, hinges,
  pressure-equalisation valve, counterbalance strut, placards. Docking hatch with hub, crank and six dogs.
- Three couches at the shared seat points: head rest with wings, back and hip cushions with bolsters, thigh
  and shin pans, heel cups, toe straps, frame rails and struts to floor pallets, arm rests, five-point
  harness; rotation hand controller (right) and translation controller + throttle (left) on the commander's
  and pilot's couches.
- Console: five sections (main band, upper and lower tilted), three MFD bezels with soft keys, the FDAI
  (housing, roll scale, the navball texture on a real ball, cover glass), 18-lamp caution and warning panel,
  master alarms, guarded and plain toggle rows, rotary selectors, seven-segment readouts (MET, event timer, g,
  delta-v), status lamps, mounting struts. Wall panels with breakers, flood lights, hand holds, lockers,
  ducts and diffusers, cable runs with clamps, extinguisher, flight-data-file pouch, velcro patches.
- Three detail levels in one buffer: lod0 105,736 triangles (inside, or closer than 6 m with hysteresis to
  7 m), lod1 20,542, lod2 6,580 (beyond `farLodPixels` = 140 px). 87 animated controls, 147 placards in a
  2048^2 label atlas painted at init, 39 materials. Build time about 170 ms.

Instruments (`instruments.ts`): switches, guards, lamps, selectors and readouts mirror the snapshot (SAS,
RCS, fine control, gear, lights, engine armed/firing, chute armed / drogue / main, master alarm on overheat,
g limit, mission failure; staging lock, abort armed while the tower is on, lift vector, plasma, warp,
terrain loading, heat-shield and RCS low, landed; navball and SAS mode selectors). Hand controllers follow
`appliedControls` in each seat's axes. The MET readout shows the HUD's seconds (`formatMet` fields).

MFDs (`displays.ts`): the shared `MfdPainter` paints each display into its own OffscreenCanvas at 15 Hz,
staggered (at most one display per frame, page changes on the next frame), copied into one layer of the
array, mips by render passes. The screen material is `MATERIAL_ID.display` with an RGB stripe structure when
one display pixel covers several screen pixels, brightness following the cabin's light (ambient sensor,
never below 6 %), and an anti-reflection coated cover glass. MFD rows use the HUD's display models
(`describeFlight`, `describeOrbit`, ...), so the strings are identical.

Light (`lighting.ts`, `shaders.ts`):

- Sun: the core's deferred sun light with the vessel-anchored every-frame cascade; the interior is a moving
  shadow caster (lod0 when the cascade texel is under 3 cm).
- Everything else is computed by the cockpit and written as emission, so nothing of it reaches outside the
  hull: up to 24 cabin polygons evaluated per pixel as Lambertian area lights (vector form factor) with a
  representative-point GGX term for windows and floods: the window openings (radiance of the environment
  probe about each window's axis plus the entry plasma), the sun patches (the window outlines projected along
  the sun onto the cabin by an analytic ray cast, reflectance x illuminance / pi), the six flood lights
  (tied to `lightsOn`) and the three displays (their mean luminance). Inter-reflection is an integrating
  sphere term rho / (S (1 - rho)) x flux. Interior pixels write ao = 0 to the G-buffer, which removes the
  core's environment ambient (the probe is the outside sky and would light the cabin through the hull).
- A compute pass per frame (`cockpit.ambient`, one 24-invocation workgroup) evaluates the probe, display
  means and sun transmittance once and stores them for every pixel.
- Glass (`drawTransparent`): per pane a multiplicative draw (tint, Fresnel transmittance) and an additive one
  (from inside: the cabin reflected, with exact hits on displays, floods and sun patches; from outside: the
  probe), dust, smudges and scratches that light up in grazing sun, `applyAtmosphere` in both.

Crew view: in the interior camera only, tunnel vision above 6 g (low-passed, tau 2.5 s, full at 11 g) as an
overlay, and structure-borne vibration of the cabin relative to the head from thrust acceleration and
dynamic pressure (transonic buffet bump), at most 4 mm.

## 3. Verification

| Acceptance item | Result | Where |
|---|---|---|
| No interior vertex outside the mould line minus the wall thickness | all three LODs, worst vertex >= 0 (0.1 mm float tolerance) | `tests/unit/cockpit/geometry.test.ts` |
| Window frames and hatch within 2 mm of the shared openings | every point of each shared inner outline (48 points, recomputed from the file with plain trigonometry) lies within 2 mm of the bezel / hatch seal surface; no frame vertex inside an opening | same |
| Couches at the shared seat points | back cushion faces the look direction, centred on the seat, 4-16 cm behind the eye; head rest within 12 cm | same |
| Commander's line of sight | unobstructed (ray vs every lod0 triangle) to the fwd-left window through the whole wall and to the centre and four corners of all three displays | same |
| Display quads planar, texture density | frames orthonormal; >= 1.5 texels per screen pixel from the commander's eye at 70 deg / 1440p (the image is never magnified) | same |
| cyclePage walks every page and wraps; setPage validation | unit and browser | `instruments.test.ts`, `cockpit.spec.ts` |
| setPage reflected in 'ui.mfd' within 100 ms | measured in the page from setPage to the frame after the copy; the active tab's accent underline read back from the texture | `cockpit.spec.ts` |
| Lab forwards real key presses 9 / 0 / minus | `page.keyboard.press`, pages and the texture follow | `cockpit.spec.ts` |
| MFD content matches the HUD strings | flight, orbit, landing rows equal the HUD's `describe*` strings in three scenes | `instruments.test.ts` |
| Tunnel vision / vibration | tunnel > 0.2 after 6 s at 9.5 g in the interior view, 0 in the chase view; vibration 0 at rest, > 0.1 mm under full thrust, <= 4 mm | `cockpit.spec.ts` |
| Perf at 1440p (ARCHITECTURE 17.1: 1.2 ms) | see below: 0.44 ms | `cockpit.perf.spec.ts` |
| expectNoErrors | every browser spec | all |

Perf, `scene=leo` from the commander's seat, 2560 x 1440 internal, attribution mode, GPU kept busy by a 7 ms
ballast (`labs/cockpit/ballast.ts`, as RENDER_API section 14 asks), RTX 5090:

| | p50 | p99 | budget |
|---|---|---|---|
| `cockpit.gbuffer` (depth pre-pass + shading, displays, ball) | 0.321 | 0.329 | |
| `cockpit.shadow` (every-frame cascade) | 0.004 | 0.005 | |
| `cockpit.ambient` | 0.047 | 0.082 | |
| interior total | | **0.416** | 0.8 |
| `cockpit.transparent` (glass) | 0.009 | **0.009** | 0.2 |
| `cockpit.mfdUpload` (mips), mean per frame | | **0.011** | 0.2 |
| display paint + copy + mip encode, CPU mean per frame | | **0.29 ms** | 0.4 |
| prepare (CPU) | | 0.32 ms | |
| cockpit total | | **0.44 ms** | 1.2 |

Idle-GPU numbers (logged): G-buffer 0.58 ms p99 (clock-down, see render-core 4.1). The G-buffer was 1.65 ms
before the depth pre-pass (the interior is drawn twice in the same pass: depth with all write masks 0, then
shaded with depth test 'equal' and an `@invariant` position) and before the per-frame ambient pass.

Commands:

```
npm run typecheck:paths -- src/render/cockpit labs/cockpit tests/browser/cockpit tests/unit/cockpit
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/cockpit tests/unit/cockpit src/core/defs
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/cockpit.perf.spec.ts --project=perf
```

Lab: `/labs/cockpit/?scene=pad|leo|night|reentry|moon`, `look=<yaw>,<pitch>`, `aim=mfd0|fdai|switches|...`,
`view=chase&window=fwd-left&distance=2.2`, `g=`, `throttle=`, `lights=1`, keys 9 / 0 / minus.
Screenshots (reviewed): `out/screens/cockpit/` pad-noon-forward-window, leo-earth-side-window,
leo-sun-patch-console, night-displays-floods, reentry-plasma, moon-horizon, look-back-couches-hatch,
closeup-mfd, closeup-fdai, closeup-switches, chase-window, perf-1440p-leo-seat.

## 4. Deviations from the brief (and why)

1. **Flood lights and display glow are not `FrameContext.lights`.** Core local lights are isotropic and
   unshadowed: a cabin flood would light the hull's outside and the scene around the vessel, and the cabin
   behind every fixture. They are area lights evaluated by the cockpit's own shader and written as emission
   (cabin pixels only). Exterior lights of the vessel remain the vessel visuals' business.
2. **Fabric uses the standard BRDF**, not `MATERIAL_ID.cloth`: the cloth model's wrap term lights back faces
   through occluders (request cockpit-1).
3. **Interior pixels write ao = 0** to kill the core's environment ambient, which is outside light; and
   planetshine is added unshadowed by the core (request cockpit-2), so a little of it reaches the cabin.
4. **Triangle count**: lod0 is 106 k triangles, not about 400 k: every part listed in the brief is modelled,
   and the budget is left to other packages; density is set where the camera is (console, couches, hatch).
5. **Texel density** is read as "at least 1.5 display texels per screen pixel from the seat" (the display
   texture is never magnified; from the commander's eye it is 2.4 texels per pixel across MFD 1, 3.6 across
   MFD 2 and 5.1 across MFD 3, more along their foreshortened height).
6. **Opening outlines**: the shared rounded rectangles are measured on the outer surface with u = arc length
   along the circle of constant y and v = distance along the generator; the inner outline is the outer one
   moved along the local normal by the wall thickness. The geometry test checks this against the file.
7. **LOD switch** is a hard switch with hysteresis (no dithered cross-fade: a dither would disable early
   depth testing and the switch happens outside, beyond 6 m, where the interior is mostly hidden by glass).
8. **Exposure**: the brief's "cabin readable when the windows blow out" needs interior metering on a robust
   statistic; asked for in cockpit-3 (open, blocking). Until then the lab's sunlit shots are metered on the
   sun patch.
9. **Lab stand-ins**: the lab has its own sky composite and probe (`labs/cockpit/sky.ts`), a hull stand-in
   (`hull.ts`) and a shock-layer glow for entry; the integrated app uses the real sky, vessel visuals and vfx.

## 5. Requests

- cockpit-1 (open, non-blocking): cloth wrap lighting leaks through occluders (`chunksLighting.ts`).
- cockpit-2 (open, non-blocking): planetshine reaches pixels with ao = 0 (`deferred.ts`).
- cockpit-3 (open, blocking for the readability item): interior metering on the log-average / a percentile
  band (`exposure.ts`).
- cockpit-4 (open, non-blocking): coarse static speckle along sun-patch edges from the 12-tap rotated PCSS at
  the minimum kernel in the interior cascade (`chunksLighting.ts`).

## 6. Known weaknesses (honest)

- **Not photoreal yet.** The interior reads as clean CGI: flat-shaded panel faces without wear maps, a
  regular quilt pattern, uniform fabric colours, simple hand controllers, no crew, no loose cables, straps
  or stowage. Detail is procedural (paint, brushed metal, quilt, weave, webbing, velcro, knurl, rubber,
  cast); there are no baked textures or photogrammetry.
- Sunlit views are metered on the sun patch (cockpit-3), so the cabin is too dark in `leo` and the close-ups
  of the FDAI and switches look underexposed; night and entry views are right.
- Sun-patch edges show the core's shadow-filter speckle in close-ups (cockpit-4).
- The window's light on cabin surfaces uses one radiance per window (the probe about the window axis over
  about 1.5 sr), not the per-pixel view through the window; the glass reflection keeps the exact per-ray
  lookup.
- In the lab the Earth seen through the windows is the lab planet under a single-scattering sky stand-in;
  the photographic look of Earth and the entry plasma depends on the sky, terrain and vfx packages.
- The lab hull is a stand-in for the vessel visuals, so the chase view through a window is only a check that
  the interior shows through glass from outside.
- The look-around shot from the commander's eye (`look-back-couches-hatch`) shows the other couches, their
  hand controllers and the side window, but not the side hatch: from that eye the hatch is hidden behind the
  couches (aiming at the hatch window shows couch backs). The lab has no free camera inside the cabin, so no
  reviewed screenshot shows the hatch mechanism; its geometry is covered by the alignment test only.
- Toggle levers read small from the seat and the couch fabric still shows some weave moire at grazing angles.
