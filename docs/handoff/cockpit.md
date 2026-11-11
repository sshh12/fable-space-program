# Hand-off: cockpit (capsule interior, MFDs, crew view)

Package `cockpit`: the Kestrel capsule's interior as scene geometry in the deferred renderer, its three MFDs,
the physical attitude indicator, the window glass, the cabin light and the crew-view effects.

Owned paths: `src/render/cockpit/**`, `data/defs/visuals/cockpits/**`, `labs/cockpit/**`,
`tests/browser/cockpit/**`, `tests/unit/cockpit/**`, `tools/cockpit/**`, `public/assets/cockpit/**`, this file.

## 1. API

```ts
import { createCockpitFeature } from '@/render/cockpit';

const { feature, controls } = createCockpitFeature(renderer.context, {
  navball,                        // NavballRenderer (src/ui): the app renders it every frame into 'ui.navball'
  mfdPainter: createMfdPainter(), // MfdPainter (src/ui)
  // id?: string (default 'cockpit'), order?: number (default 100: after plumes and plasma in drawTransparent)
});
await renderer.addFeature(feature);   // init is async: it loads public/assets/cockpit/detail*.{json,png}
// Input layer: action 'mfdCycle:i' -> controls.cyclePage(i). The feature never reads the keyboard.
```

- `CockpitControls` (contract in `src/core/contracts/ui.ts`): `displayCount` (3), `page(i)`, `setPage(i, page)`
  (RangeError on an unknown display or page), `cyclePage(i)` (walks `MFD_PAGES` in order and wraps). The
  implementation adds `onChange(listener)`.
- Which vessel: the camera's `insideVesselId`, else the active vessel, else any vessel whose vehicle has a
  `cockpit` layout and a command part. The layout is `VehicleDef.cockpit` (`kestrel`), found through
  `listSections(defs, 'visuals/cockpits/')`; it names the shared mould line it is built against.
- **The instruments describe that same vessel** (`InstrumentSource`): engines, parachutes, escape tower,
  plasma, situation, its own g load, part temperatures and heat shield come from its snapshot; the facts only
  the snapshot's readouts carry (SAS, RCS, gear, lights, the HUD's numbers, applied controls) describe the
  active vessel, so for any other vessel those lamps are dark, those switches at rest, those readouts blank,
  the hand controllers neutral and the floods off. Tunnel vision follows the vessel's own g.
- Shared resources: publishes `'ui.mfd'` (rgba8unorm-srgb 2D array, 1024 x 768 x 3, full mip chain); reads
  `'ui.navball'` (publishes the navball renderer's view itself if nobody did).
- Feature extras (tests, labs): `model(layoutId)`, `occlusion(layoutId)` (the baked occlusion stream),
  `stats()` (`CockpitFrameStats`: active, layout, vesselId, vesselActive, lod, inside, triangles, cabin
  polygons, sunLit, tunnel, vibration, prepare ms), `displays` (`MfdDisplays`: stats, painted pages),
  `controlStates()`.
- Pure helpers (run in vitest): `buildCockpitModel(defs, id)`, `displayVertices`, `meshBvh`, `buildBvh` /
  `bvhRay`, `occlusionAt` / `occlusionSources` / `unpackOcclusion` / `bakeVertex`, `sunMapTransform`,
  `loadCockpitLayout`, `validateLayout`, `bindingState` / `controlStates` / `readoutText` / `instrumentSource`,
  `digitMask`, `cabinSources`, `castCabinRay`, `insideDistance`, `openingsOf`, `seatFrames`.

## 2. What is there

Interior (`src/render/cockpit/cabin/*`, dimensions from `data/defs/visuals/cockpits/kestrel.json` and the
shared mould line `visuals/shared/kestrel-mouldline.json`):

- Pressure shell with exact openings for the four windows, the side hatch and its window; tunnel to the
  docking hatch; floor; ring frames, stringers, quilted blankets, close-out panels with fasteners, tie-down
  rails. Windows: bezel, two panes, gaskets, fasteners, placards, roller-shade hardware.
- Side hatch: seal ring, door with rib grid, window, gearbox and handle, ten latches with linkage, hinges,
  pressure-equalisation valve, counterbalance strut, placards. Docking hatch with hub, crank and dogs.
- Three couches at the shared seat points: upholstered pads (squircle outline, foam roll edge, piping cord
  in the seam) for back, hip, thigh, shin and head rest with wings, padded arm-rest rolls, pans, rails, struts, pallets, five-point harness. Commander and pilot: a sculpted rotation
  controller (finger grooves, palm swell, pinky flange, trigger, four-way hat, thumb button, rubber bellows
  boot), a translation controller with a barrel grip and a bellows boot, a throttle.
- Console: five sections with wearable chamfered edges and quarter-turn corner fasteners, three MFD bezels
  with soft keys, the FDAI, 18-lamp caution and warning panel, master alarms, toggle switches (keyed lock
  washer with tab, hex nut, threaded bushing, chrome bat-handle lever) with guards, rotary selectors,
  seven-segment readouts, lamps. Wall panels with breakers, flood lights, hand holds, lockers, ducts, cable
  runs, extinguisher, flight-data-file pouch, velcro.
- Labels (147 placards, 2048^2 atlas painted at init) are decals: drawn after the interior with their ink as
  coverage into RT0 and RT5 only, so the face under them shows unchanged; every label is right-reading from
  the side it faces (`labelQuad` mirrors the reading direction on left-handed frames, unit-tested).
- Detail levels: lod0 **265,296** triangles (inside, or closer than 6 m, hysteresis to 7 m), lod1 23,902,
  lod2 6,580; 236,153 vertices; 87 animated controls; 39 materials. Large flat faces are subdivided to
  `transport.maxEdge` (3.5 cm) at lod0 so the per-vertex occlusion bake resolves them. Model build (with the
  lod0 BVH) about 0.7 s.

Materials: every `detail` kind samples a baked tileable detail layer (`public/assets/cockpit/detail-n.png`,
`detail-m.png`, `detail.json`: paint, brushed aluminium, couch twill, blanket cloth, webbing, velcro, rubber,
powder coat / anodising; 8 layers of 512^2, 5 MB) for normal, cavity, tone, gloss, an edge-wear mask and a
grime mask, made by `tools/cockpit/bake-textures.ts` (procedural, deterministic, no API key, no spend).
Per material in the layout file: `wear` (the share of chamfered edges worn through and what shows there),
`grime` (dirt in occluded corners and cavities) and `variation` (tone and gloss from part to part: every
primitive is a part with its own seed, so no two panels, blankets or cushions are identical). Quilting is
procedural per bay (cell size, angle, phase, seam wander, per-cell fill).

Instruments (`instruments.ts`): switches, guards, lamps, selectors and readouts (thresholds in
`kestrel.json` `alarms`). The MET readout shows the HUD's seconds.

MFDs (`displays.ts`): the shared `MfdPainter` paints each display into an OffscreenCanvas at 15 Hz,
staggered; the canvas becomes a VideoFrame imported as an external texture and is drawn into mip 0 of its
layer by a timed render pass, then the mips (all 'cockpit.mfdUpload'). Screen material `MATERIAL_ID.display`
with the RGB stripe structure (thresholds `displays.pixelStructure`), brightness following the cabin light,
and anti-reflection, anti-glare cover glass (`windows.coverGlass`: reflectance 0.12 of bare glass, etched
roughness 0.32: a reflected flood is a soft glow, the data stays readable).

### Light (`lighting.ts`, `occlusion.ts`, `sunmap.ts`, `shaders.ts`)

Every interior pixel is lit by the cockpit's shader and written as emission; the G-buffer gets ambient
occlusion 0 (the core's probe ambient and planetshine are outside light). In the core's every-frame
cascades the interior is a moving caster drawn as a closed shell (lod2 plus the window openings plugged at
the inner wall, range 'plugs'), so the core's sun never reaches the cabin.

- **Sun.** `brdfStandardDirect` / `brdfClothDirect` (the core's BRDFs) x sun illuminance at the vessel
  (eclipses, atmosphere transmittance, cloud transmittance at the vessel from the frame's cloud placement)
  x the glazing's transmittance (tint, Fresnel at the incidence on each surface) x visibility:
  - through the windows, analytically: each window is a prism of the shared rounded rectangle along its
    inward normal from the outer mould line to the bezel's inner edge (`WindowMeta.aperture`); both ends clip
    the solar disc (footprint radius = distance x tan of the angular radius, stretched by 1 / cos of the
    incidence), visible fraction = the share of a disc past a straight edge. The patch outline therefore has
    the physical penumbra of the real window edge and no noise.
  - past the interior's own occluders: the cabin's own sun map (`sunmap.ts`, 2048^2, 2 mm texels,
    vessel-fixed, re-rendered every frame the sun reaches the cabin from the drawn detail level minus the
    enclosure, i.e. wall, floor, tunnel and bezels), blocker search plus a fixed 8 x 8 grid of bilinear
    comparisons no more than a texel apart, penumbra up to 8 mm.
- **Everything else**: up to 24 cabin polygons per pixel as Lambertian area lights (vector form factor) plus
  a representative-point GGX lobe: the windows (probe radiance about the window axis plus the entry plasma),
  the sun patches (window outlines projected along the sun onto the surface a BVH ray hits; radiance from
  that surface's material albedo), six floods (`lightsOn`), three displays. Each is multiplied by the
  vertex's **baked visibility of that source**; inter-reflection (integrating sphere) and sun-patch bounce by
  the baked ambient occlusion.
- **Occlusion bake** (`occlusion.ts`): at init, on the GPU, one invocation per vertex of every detail level,
  rays against that level's BVH (`bvh.ts`, binned SAH, built on the CPU): ambient occlusion (48
  cosine-weighted rays within 0.45 m), and per window, per display and for the floods (lumen-weighted) the
  unblocked share of the form-factor kernel over 8 sample points each. 16 bytes per vertex (second vertex
  stream). Thin overlays lying on other surfaces (harness webbing, velcro; FLAG_OVERLAY) are drawn but do not
  occlude in the bake, where the vertices under them would bake as buried. `occlusionAt` is the same computation on the CPU; the browser spec compares them.
- Glass: per pane a multiplicative and an additive draw; window glass reflects the cabin exactly
  (displays, floods, sun patches), cover glass through its anti-glare lobe; dust specks (jittered, sized,
  clumped in two scales), wiped smudges and curved scratches light up in grazing sun (sun visibility through
  the window aperture); `applyAtmosphere` in both draws.

Crew view: in the interior camera only, tunnel vision above 6 g (low-passed, tau 2.5 s, full at 11 g) and
structure-borne vibration from thrust and dynamic pressure with a transonic buffet (`experience.vibration
.buffet`), at most 4 mm.

## 3. Verification

| Acceptance item | Result | Where |
|---|---|---|
| No interior vertex outside the mould line minus the wall thickness | all three LODs | `tests/unit/cockpit/geometry.test.ts` |
| Window frames and hatch within 2 mm of the shared openings | 48 points per opening, recomputed from the file | same |
| Couches at the shared seat points | back cushion faces the look direction, 4-16 cm behind the eye; head rest within 12 cm | same |
| Commander's line of sight | unobstructed through the fwd-left window (whole wall) and to all display centres and corners | same |
| Display quads planar, texel density | the vertices the display pipeline draws (`displayVertices`) coplanar within 1 um, covering width x height; >= 1.5 texels per screen pixel at the cockpit rig's default FOV (70 deg, taken from `createCockpitRig`) at 1440p | same |
| Labels right-reading | every label triangle's text frame right-handed with its face normal | same |
| cyclePage / setPage validation; setPage reflected in 'ui.mfd' within 100 ms; keys 9 / 0 / minus | pass | `instruments.test.ts`, `cockpit.spec.ts` |
| MFD content equals the HUD strings | unit: rows equal `describe*`; browser: what the cockpit's own canvas drew (fillText captured in the lab) contains every HUD string of the same snapshot (altitude, vertical speed, pitch, heading, roll, throttle, g, MET) | `instruments.test.ts`, `cockpit.spec.ts` |
| Instruments of a non-active vessel | readout-only lamps dark, readouts blank, own g drives the g readout and G LIMIT, controllers neutral, floods off | `instruments.test.ts` |
| Light transport | BVH = brute force on 40 rays; floor under the couches hidden from the floods, floor-wall corner occluded; eye sees the window, console interior does not; sun-map transform covers the interior; plugs on the inner wall; sun-map casters = lod0 minus the enclosure; patch albedo from the material | `light.test.ts` |
| GPU occlusion bake = CPU reference | 300 vertices, every channel: mean abs difference < 0.01, max < 0.2 | `cockpit.spec.ts` |
| Tunnel vision / vibration | waits on state (no sleeps) | `cockpit.spec.ts` |
| expectNoErrors | every browser spec | all |

Perf, `scene=leo` from the commander's seat, 2560 x 1440, attribution mode, 7 ms GPU ballast, RTX 5090
(last of five runs; the gate showed no other GPU job when it started, other agents were busy on the CPU):

| | p50 | p99 | budget |
|---|---|---|---|
| `cockpit.gbuffer` (depth pre-pass, shading, label decals, displays, ball) | 0.386 | 0.714 | |
| `cockpit.shadow` (closed shell in every-frame cascades) | 0.002 | 0.002 | |
| `cockpit.ambient` | 0.071 | 0.106 | |
| `cockpit.sunMap` (cabin sun map) | 0.032 | 0.035 | |
| interior total | **0.49** | **0.86** | 0.8 (**p99 not met**) |
| `cockpit.transparent` (glass) | 0.027 | 0.031 | 0.2 |
| `cockpit.mfdUpload` (canvas into mip 0 + mips), mean per frame | | **0.015** | 0.2 |
| display paint + upload + mip encode, CPU mean per frame | | **0.29-0.39 ms** (varied with load) | 0.4 |
| cockpit total (p99 sum) | | **0.90** | 1.2 (met) |

The G-buffer pass's p99 sits about 0.3 ms above its p50 under the ballast in every run (0.68-0.75 ms against
0.39-0.43 ms); without the ballast p99 and p50 are close. The brief's interior line is met at p50, not at
p99; the spec asserts p99 and fails on that line. See section 6.

Commands:

```
npm run typecheck:paths -- src/render/cockpit labs/cockpit tests/browser/cockpit tests/unit/cockpit tools/cockpit
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/cockpit tests/unit/cockpit src/core/defs
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/cockpit.perf.spec.ts --project=perf
node tools/dev/heavy.mjs --class=bake -- npx tsx tools/cockpit/bake-textures.ts     # only to rebake the detail maps
```

Lab: `/labs/cockpit/?scene=pad|leo|leo-earth|night|reentry|moon`, `look=<yaw>,<pitch>`, `seat=cdr|plt|ms`,
`eye=<right>,<headUp>,<forward>` (offset in the seat's axes), `at=<x>,<y>,<z>` (eye anywhere, part frame),
`aim=mfd0|fdai|switches|annunciator|hatch|hatchDoor|windowL|sideL|sideR|couches|horizonL|horizonFL`,
`nadir=<window>,<offNadirDeg>`, `view=chase&window=<id>&distance=<m>&target=<point>`, `ec=<EV>`, `g=`,
`throttle=`, `lights=1`, keys 9 / 0 / minus. Screenshots (reviewed, `out/screens/cockpit/`):
pad-noon-forward-window, leo-earth-side-window, leo-sun-patch-console, night-displays-floods,
reentry-plasma, moon-horizon, look-back-couches-hatch, hatch-mechanism, closeup-mfd, closeup-fdai,
closeup-switches, chase-window-night, chase-window-sun, perf-1440p-leo-seat.

## 4. Deviations from the brief (and why)

1. **The cabin's sun is the cockpit's own**, not the core's cascade 0: analytic window apertures for the
   patch outline plus a cabin sun map for interior occluders (section 2, Light). The core's general filter
   leaves grain at the patch edges seen from 0.4-1 m (request cockpit-4; the 6 m interior cascade halved the
   band but kept the grain). The interior is still a moving caster in the every-frame cascades (closed shell).
2. **Flood lights and display glow are not `FrameContext.lights`**: core local lights are isotropic and
   unshadowed, they would light the hull's outside and the cabin behind every fixture. They are area lights
   in the cockpit's shader with baked visibility.
3. **Interior pixels write ao = 0** (the core's ambient and planetshine are outside light); the cabin's own
   ambient uses the baked occlusion. The core's SSAO does not reach the cabin; the bake replaces it.
4. **Triangle count**: lod0 265 k of the ~400 k allowed.
5. **Texel density** read as "at least 1.5 display texels per screen pixel from the seat" at the rig's
   default 70 deg (2.4 texels per pixel across MFD 1). Zoomed to the rig's 25 deg minimum the image is
   magnified (about 0.85 texels per pixel), as any real display seen through binoculars.
6. **LOD switch** is hard with hysteresis (outside, beyond 6 m).
7. **Lab stand-ins**: sky, probe, planets (low-resolution albedo, no clouds) and hull are the lab's; the
   Earth and Moon screenshots use exposure compensation (`ec=-3` / `-2`) because the cabin metering exposes
   for the cabin; the night chase shot `ec=-2`.

## 5. Requests

- cockpit-1, cockpit-2, cockpit-3 (resolved, 113438e) and cockpit-4 (resolved, 03242a3: 6 m interior
  cascade). After the review the cabin no longer takes its sun from the core cascade (deviation 1), so
  cockpit-4's change is not relied on. No open requests against cockpit paths; none filed in this round.

## 6. Known weaknesses (honest)

- **Not film-grade photoreal yet.** It now reads as a used, built cabin (worn edges, grime, varied panels,
  upholstered couches, real switch and controller hardware, crisp sun patches, occlusion), but hard panel
  geometry is still simple boxes with chamfers, the blankets read as clean CG cloth, there is no crew, no
  loose stowage, no cable slack or tape; detail textures are procedural (no photographed or AI-generated
  material); fabrics have no thread-level sheen variation.
- **Perf p99 not met**: interior p99 0.86 ms against 0.8 (p50 0.49 ms). Under the GPU ballast the G-buffer
  pass has a tail of slow frames it did not have before this round (its work grew: 265 k triangles, textured
  detail, the sun term, decals). The cockpit total stays under the 1.2 ms ARCHITECTURE line. Cuts not yet
  made: the cabin-light loop (up to 24 polygons per pixel; sources with zero baked visibility are already
  skipped), lod0 density away from the seat, the four occlusion varyings.
- **Daylight chase**: from outside by day the cabin is about ten times darker than the sunlit hull, so the
  interior shows dark through the glass (physically right; `chase-window-sun`). The night shot shows it lit.
- **Moon horizon**: the capsule stands upright and its side windows look out above the horizon through a
  15 cm deep well; from the seat the horizon is hidden, it shows with the head at window height
  (`moon-horizon` uses that eye point). The lab Moon is a low-resolution albedo sphere.
- Interior-occluder shadows (not the window outlines) cap their penumbra at 8 mm; the true penumbra of a
  blocker beyond 0.9 m is wider.
- Window light on surfaces uses one radiance per window; baked visibility is per vertex at the controls'
  rest pose (a moved switch keeps its rest occlusion).
- Toggle levers and the lower console sit in the console's own shadow in `leo` (correct, but dark).
- Init cost: model build about 0.7 s on the CPU plus the GPU bake (well under a frame).
