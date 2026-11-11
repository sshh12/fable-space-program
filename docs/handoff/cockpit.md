# Hand-off: cockpit (capsule interior, MFDs, crew view)

Package `cockpit`: the Kestrel capsule's interior as scene geometry in the deferred renderer, its three MFDs,
the physical attitude indicator, the window glass, the cabin light and the crew-view effects.

Owned paths: `src/render/cockpit/**`, `data/defs/visuals/cockpits/**`, `labs/cockpit/**`,
`tests/browser/cockpit/**`, `tests/unit/cockpit/**`, `tools/cockpit/**`, `public/assets/cockpit/**`, this file.

State: built, reviewed, fixed, reworked in visual rounds 1 and 2 (sections 7 and 8: what the critics listed and
what was done about each item, what is still open). Sections 1-6 describe the package as it is now.

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

- **Whoever composes the features** must create the vehicle's vessel feature with `{ exteriorGlass: false }`
  when the cockpit is loaded (RENDER_API 17.7, request cockpit-8): otherwise the vehicle closes every capsule
  window with an opaque pane and the chase camera cannot look in.
- `CockpitControls` (contract in `src/core/contracts/ui.ts`): `displayCount` (3), `page(i)`, `setPage(i, page)`
  (RangeError on an unknown display or page), `cyclePage(i)` (walks `MFD_PAGES` in order and wraps). The
  implementation adds `onChange(listener)`.
- Which vessel: the camera's `insideVesselId`, else the active vessel, else any vessel whose vehicle has a
  `cockpit` layout and a command part. The layout is `VehicleDef.cockpit` (`kestrel`), found through
  `listSections(defs, 'visuals/cockpits/')`; it names the shared mould line it is built against.
- **The instruments describe that same vessel** (`InstrumentSource`): engines, parachutes, escape tower,
  plasma, situation, its own g load, its body rates (the attitude indicator's rate needles), part
  temperatures and heat shield come from its snapshot; the facts only the snapshot's readouts carry (SAS,
  RCS, gear, lights, the HUD's numbers, applied controls) describe the active vessel, so for any other vessel
  those lamps are dark, those switches at rest, those readouts blank, the hand controllers neutral and the
  floods off. Tunnel vision follows the vessel's own g.
- Shared resources: publishes `'ui.mfd'` (rgba8unorm-srgb 2D array, 1024 x 768 x 3, full mip chain); reads
  `'ui.navball'` (publishes the navball renderer's view itself if nobody did).
- `FrameContext.lights`: when the camera is outside the cabin and the cabin lights are on, one point light
  per window, in its well (the lit cabin's spill onto the well and the hull around it; at most the 16 the
  core takes).
- Feature extras (tests, labs): `model(layoutId)`, `occlusion(layoutId)` (the baked occlusion stream),
  `stats()` (`CockpitFrameStats`: active, layout, vesselId, vesselActive, lod, inside, triangles, cabin
  polygons, sunLit, tunnel, vibration, prepare ms), `displays` (`MfdDisplays`: stats, painted pages),
  `controlStates()`.
- Pure helpers (run in vitest): `buildCockpitModel(defs, id)`, `displayVertices`, `meshBvh`, `buildBvh` /
  `bvhRay`, `occlusionAt` / `occlusionSources` / `unpackOcclusion` / `bakeVertex`, `sunMapLayout` /
  `sunTileUniform` / `sunEnters`, `probeFaceMatrix` / `probeDirection` / `PROBE_FACES`, `loadCockpitLayout`,
  `validateLayout`, `bindingState` / `controlStates` / `readoutText` / `instrumentSource`, `digitMask`,
  `cabinSources`, `castCabinRay`, `insideDistance`, `openingsOf`, `seatFrames`.

## 2. What is there

Interior (`src/render/cockpit/cabin/*`, dimensions from `data/defs/visuals/cockpits/kestrel.json` and the
shared mould line `visuals/shared/kestrel-mouldline.json`):

- Pressure shell with exact openings for the four windows, the side hatch and its window; tunnel to the
  docking hatch; floor; ring frames, stringers, close-out panels with fasteners, tie-down rails.
- **Insulation blankets** (`cabin/shell.ts` `blanket`, `cabin/quilt.ts`): soft goods, modelled as such. Each
  bay's blanket bulges between the frames, its rim rolls over and tucks to the wall under the frame flanges,
  press studs pin and pinch it, the fill sags unevenly. Most bays are quilted: diamond cells, each a pillow
  pinched at its stitched seams; the mesh (1.6 cm grid) is displaced by `quiltHeight` and the shader shades
  the same relief per pixel as a surface gradient (crease, thread dashes, puckers along the seams), with
  the crease softened by the pixel footprint. Every bay turns, shifts, scales and bends its quilting
  differently; one bay in five is a plain liner panel carrying a grid of hook-and-loop squares.
- Windows: bezel (its face and outer side cast into the cabin's sun map), two panes, gaskets, fasteners,
  placards, roller-shade hardware. Outlines are sampled by curvature (`mould.ts` `roundedRectOutline`:
  half of the points on the corner arcs, 16 chords per corner at full detail).
- Side hatch: seal land, a plug door with its own seal bulb closing the seam to the frame (every detail
  level), rib grid, window, gearbox with a pump handle (hub, arm, grip), a latch drive rod running round the
  door inside the rim in guide blocks with a crank link to the gearbox, ten latches on the rim (housing,
  bellcrank link to the rod, a hook over the door's edge onto a striker post with a roller; hook drop and
  post height follow how far the flat door stands proud of the conical wall), hinges, a flanged
  pressure-equalisation valve with a T handle, counterbalance strut, placards. Docking hatch with hub, crank
  and dogs.
- Three couches at the shared seat points: upholstered pads meshed on a grid of their unfolded cover
  (surface coordinates metric and planar on the top panel, by arc length over the roll and the side: one
  thread pitch everywhere), back, thigh and shin pads stitched down in channels (`UPHOLSTERY`), piping cord,
  head rest with wings, arm rests, pans ending at their pads, side rails, hinge tubes at hip, knee and foot,
  struts, pallets, five-point harness in natural webbing with a rotary buckle. Commander and pilot: a
  sculpted rotation controller, a translation controller, a throttle.
- Console: five sections whose faces are meshed on a regular 1.4 cm grid with lines along the outline of
  every large mounted part (so the baked contact shadow of a bezel is an even band), close-out beads along
  the hinge lines of the tilted sections, cover strips with fasteners over the butt joints, three MFD bezels
  with six page keys above the screen's page tabs, the attitude indicator (retaining ring, domed cover
  glass, slotted recessed fasteners, three rate needles on outer scales), 18-lamp caution and warning panel,
  master alarms, 31 toggle switches in five groups (keyed washer, hex nut, bushing, bright bat-handle lever;
  wicket guards between them; name above, position legends above and below the lever's throw; group lines),
  rotary selectors, seven-segment readouts, lamps. Wall panels with breakers, flood lights, hand holds,
  lockers, ducts, cable bundles (slack between clamps, grommet and backshell at both ends), extinguisher,
  flight-data-file pouch.
- Labels (174 placards, 2048^2 atlas painted at init, sampled anisotropically) are decals drawn after the
  interior with their ink as coverage into RT0 and RT5 only; every label is right-reading from the side it
  faces. Lamp-lens legends share one cap height.
- Detail levels: lod0 **266,692** triangles (inside, or closer than 6 m, hysteresis to 7 m), lod1 23,936,
  lod2 6,750; 258,128 vertices; 106 animated controls; 43 materials. Model build (with the lod0 BVH) under
  a second.

Materials: every `detail` kind samples a baked tileable detail layer (`public/assets/cockpit/detail-n.png`,
`detail-m.png`, `detail.json`; 8 layers of 512^2, 5 MB; `tools/cockpit/bake-textures.ts`, procedural, no API
key, no spend). Per material in the layout file: `wear` (the share of a chamfered edge's length worn through,
along the middle of the chamfer in runs with frayed ends, and what shows there: dull grey under dark
finishes, primer and metal under light paint), `grime` (the texture's mask in modelled cavities) and
`variation` (tone and gloss from part to part).

Instruments (`instruments.ts`): switches, guards, lamps, selectors, readouts (thresholds in `kestrel.json`
`alarms`), rate needles (`RATE_FULL_SCALE` 5 deg/s). Switches without a binding rest at their `fixed`
position.

MFDs (`displays.ts`): the shared `MfdPainter` paints each display into an OffscreenCanvas at 15 Hz,
staggered; uploaded into mip 0 of its layer, then the mips (all 'cockpit.mfdUpload'). Screen material
`MATERIAL_ID.display` with the RGB stripe structure, brightness following the cabin light, and anti-glare
cover glass.

### Light (`lighting.ts`, `occlusion.ts`, `sunmap.ts`, `probe.ts`, `shaders.ts`)

Every interior pixel is lit by the cockpit's shader and written as emission. The G-buffer record is a black,
rough, standard surface with ambient occlusion 0 (never the cloth path: its shadow lookup turns the normal
toward the sun and stepped out of the shell, which lit the blankets' rims), so the core's deferred pass adds
nothing even where its cascades cannot resolve the shell. In the core's every-frame cascades the interior is a
moving caster drawn as a closed shell (lod2 plus the window openings plugged at the inner wall, blown up 3 %
about the cabin's centre so that it holds every full-detail surface), so the core's sun never reaches the cabin.
Debug views: eature.setDebugView(n) / cockpit lab &dbg=n (1 material ids, 2 the sun through the
apertures, 3 that times the sun map, 4 probe reflection, 5 polygon sources, 6 bounce, 7 sunlight, 8 emission,
9 face normals, 10 baked AO, 11 albedo); &hull=0 drops the lab's exterior stand-in.

- **Sun.** The core's BRDFs x sun illuminance at the vessel (eclipses, atmosphere, the core's depth-resolved
  cloud shadow, chunk `cloud_shadow`) x the glazing's transmittance x visibility:
  - through the windows, analytically: each window is a prism of the shared rounded rectangle from the outer
    mould line to the bezel's inner edge; both ends clip the solar disc. Between the two ends only what
    stands in the opening itself is lit; a sun closer than about 2 degrees to a window's plane does not get
    through its well; the penumbra's radius is bounded (3 cm);
  - past the interior's occluders: the cabin's sun map (`sunmap.ts`), 2048^2, one **tile per window the sun
    enters**, fitted to the cross-section of that window's beam: 0.2-0.6 mm texels. Casters: the drawn detail
    level without the enclosure (wall, floor, tunnel, bezel tunnels, blankets), slope-scaled depth bias;
    receivers: analytic receiver plane, blocker search (penumbra from the NEAREST blocker), 6 x 6 to 16 x 16
    bilinear comparisons never more than 1.5 texels apart over a penumbra of at most 6 mm, at least four texels
    on a receiver the light grazes. Soft goods under a sun that only skims them are shaded by their own relief.
  - **covered windows**: a window another part of the vessel covers (a part whose visual params.windowPorts
    lists window ids: the launch escape system's boost cover) lets no sky, sun or glow in until that part is
    gone (coveredWindows, CockpitFrameStats.covered).
- **Sources as polygons**: up to 24 Lambertian area lights per pixel (vector form factor): the windows
  (probe radiance about the window axis, seen only within the cone the window's well leaves open, plus the
  window's flickering share of the entry plasma), six floods (`lightsOn`), three displays; each times the
  vertex's **baked visibility of that source**.
- **The cabin probe** (`probe.ts`): every frame the cabin is drawn into a 128^2 cube from its centre (part
  frame; the lod1 interior with diffuse light only, the displays, what comes in through the windows), six
  faces in one pass, then one compute pass: the cube's blurred mips and the bounce light's nine
  spherical-harmonic coefficients (from the reflecting surfaces only; emitters reach surfaces as polygons).
  It gives every glossy and metallic surface, the window panes, the cover glasses and the attitude
  indicator's glass an image of the cabin along the reflected ray (parallax-corrected against the cabin's
  cone, specular occlusion from the baked AO, brushed metal with a bent normal), and every surface
  inter-reflected light with a direction (irradiance about its normal x baked AO), fed back into the next
  frame's probe. There is no uniform ambient term any more. The sunlight a patch throws back into the cabin
  is part of this bounce.
- **Occlusion bake** (`occlusion.ts`): at init, on the GPU, per vertex of every detail level against that
  level's BVH: ambient occlusion (96 rays within 0.45 m), and per window, per display and **per flood** the
  unblocked share of the form-factor kernel (24 points each); one sample pattern for all vertices (smooth
  interpolation). 24 bytes per vertex. Thin overlays lying on other surfaces (harness webbing, hook-and-loop,
  press studs, switch mount hardware, fasteners) are drawn but do not occlude.
- Glass: per pane a multiplicative and an additive draw; window glass mirrors the cabin (the probe, with
  the displays and floods as exact images on top; the two panes' images lie apart); a thin, even film of
  dust with sparse specks and hairline scratches scatters the sun; `applyAtmosphere` in both draws.

Crew view: in the interior camera only, tunnel vision above 6 g and structure-borne vibration.

## 3. Verification

| Acceptance item | Result | Where |
|---|---|---|
| No interior vertex outside the mould line minus the wall thickness | all three LODs | `tests/unit/cockpit/geometry.test.ts` |
| Window frames and hatch within 2 mm of the shared openings | 48 points per opening, recomputed from the file | same |
| Couches at the shared seat points; commander's line of sight; display quads planar, texel density | pass | same |
| Labels right-reading | pass | same |
| cyclePage / setPage validation; setPage reflected in 'ui.mfd' within 100 ms; keys 9 / 0 / minus | pass | `instruments.test.ts`, `cockpit.spec.ts` |
| MFD content equals the HUD strings | pass (standing on the ground the orbit page shows a dash, flight-ui round 1) | `instruments.test.ts`, `cockpit.spec.ts` |
| Rate needles | each slides with the body rate about its axis, stops at full scale | `instruments.test.ts` |
| Light transport | BVH = brute force; occlusion plausibility; sun-map tiles hold each window's beam at < 1 mm texels; plugs; casters; **no ray leaves the cabin except through a window pane** (24,000 rays from four points); probe faces drawn with the axes they are read with | `light.test.ts` |
| GPU occlusion bake = CPU reference | 300 vertices, 4,800 values: mean abs difference 0.0008, 99.5th percentile 0.002, 2 values flip (a source seen edge-on) | `cockpit.spec.ts` |
| Reviewed screenshots over the real world | 8 views in the integration lab | `world.spec.ts` (`out/screens/cockpit/world-*.png`) |
| Reviewed screenshots in the cockpit lab (stand-ins outside the cabin) | 13 views | `views.spec.ts` |
| expectNoErrors | cockpit lab specs; world spec: cockpit loaded, active, no cockpit problem or error | all |

Perf, `scene=leo` from the commander's seat, 2560 x 1440, attribution mode, 7 ms GPU ballast, RTX 5090. Five
runs on 2026-11-11 while the other four GPU slots of the gate were taken by other agents' browser jobs
(provisional under rule 16):

| | p50 | p99 (runs) | budget |
|---|---|---|---|
| `cockpit.gbuffer` | 0.41 | 0.64, 0.64, 0.64, 0.66; one run 2.67 (see below) | |
| `cockpit.probe` + `cockpit.probeFilter` | 0.039 + 0.029 | 0.072 | |
| `cockpit.sunMap` (one tile) | 0.036 | 0.040 | |
| `cockpit.ambient`, `cockpit.shadow` | 0.006, 0.002 | 0.008, 0.002 | |
| interior total | **0.52** | **0.76, 0.76, 0.77** (met); 2.81 in the loaded run | 0.8 |
| `cockpit.transparent` (glass) | 0.019 | 0.020 | 0.2 |
| `cockpit.mfdUpload`, mean per frame | | 0.016 | 0.2 |
| display paint + upload + mips, CPU mean per frame | | **0.35, 0.40, 0.40, 0.43, 0.45** | 0.4 (**not met in three of five runs**) |
| cockpit total (p99 sum) | | **0.79, 0.80, 0.81** | 1.2 (met) |

The run with p99 2.67 ms had the same p50 (0.416) and a mean of 0.48: a handful of frames stretched by
other GPU work on the machine. The display CPU line moved with the machine's load and with the MFD painter,
which flight-ui made heavier in its own round; the cockpit's share (canvas to texture, mips) did not change.
The last run of this round is recorded in section 7.

Commands:

```
npm run typecheck:paths -- src/render/cockpit labs/cockpit tests/browser/cockpit tests/unit/cockpit tools/cockpit
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/cockpit tests/unit/cockpit src/core/defs
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/cockpit.perf.spec.ts --project=perf
node tools/dev/heavy.mjs --class=bake -- npx tsx tools/cockpit/bake-textures.ts     # only to rebake the detail maps
```

Labs. Cockpit lab: `/labs/cockpit/?scene=pad|leo|leo-earth|night|reentry|moon`, `look=`, `seat=`, `eye=`,
`at=`, `aim=`, `nadir=`, `view=chase&window=<id>&distance=<m>&target=<point>`, `ec=<EV>`, `g=`, `throttle=`,
`lights=1`, keys 9 / 0 / minus. Everything outside the cabin is a stand-in there. The acceptance views are
shot in `/labs/integration/` by `tests/browser/cockpit/world.spec.ts` (the camera and the sun placed through
`window.__integration` and a free camera computed in the page; no exposure compensation):
world-pad-noon-forward-window, world-leo-earth-side-window, world-leo-sun-patch-console,
world-night-displays-floods, world-reentry-plasma, world-moon-horizon, world-chase-window-sun,
world-chase-window-night.

## 4. Deviations from the brief (and why)

1. **The cabin's sun is the cockpit's own**, not the core's cascade 0: analytic window apertures plus the
   cabin's tiled sun map (section 2). The interior is still a moving caster in the every-frame cascades.
2. **Flood lights and display glow light the cabin as area lights in the cockpit's shader** with baked
   visibility, not as `FrameContext.lights` (isotropic and unshadowed: they would light the hull's outside
   and the cabin behind every fixture). `FrameContext.lights` carries only the cabin's spill out of the
   windows when the camera is outside.
3. **Interior pixels write ao = 0**; the cabin's ambient light is the probe's bounce x the baked occlusion.
4. **Triangle count**: lod0 267 k of the ~400 k allowed.
5. **Texel density** read as "at least 1.5 display texels per screen pixel from the seat" at the rig's
   default 70 deg.
6. **LOD switch** is hard with hysteresis (outside, beyond 6 m).
7. **`displays.tabSpan`** (0.66) in the layout file mirrors a constant of the MFD painter (the share of the
   screen width its page tabs span); the bezel's page keys sit above the tabs. If flight-ui moves its tabs
   this number must follow (a request for an exported constant was not filed).

## 5. Requests

- cockpit-1 .. cockpit-4: resolved earlier.
- **cockpit-5, cockpit-6** (core, resolved 0dbebd3, 9997263): interior metering with a night key (only out of
  the sun) and a bounded highlight term (1.25 EV).
- **cockpit-7** (core, resolved 703b7c3): interior metering weighs what fills the frame through the windows
  (from a tenth to four tenths of the frame): leaning to the window, the Earth is exposed as from outside.
- **cockpit-8** (integration lab, resolved cae38b8): the vehicle is created without its opaque outer panes
  when the cockpit is loaded.
- **cockpit-9** (vfx): the sheath is drawn for a camera inside the vessel since c3568bf (the request file was
  still marked open when this was written); the cockpit draws nothing of the outside itself.
- **cockpit-10** (core, resolved c417fb0): the cascade filter's grain on the window wells at arm's length.
- **cockpit-11** (vehicle-pad, resolved 9a5339a): boost cover ports over the hatch window and the commander's
  forward window, declared as `params.windowPorts`; dark lining. The cockpit reads the ports (covered windows).
- **cockpit-12** (core, OPEN): interior camera: a highlight bound that grows with the sunlit share and a
  longer shoulder, so sun patches and Earth-filled windows keep texture.
- **cockpit-13** (vfx + contract, OPEN): publish the sheath's window radiance as a shared GPU resource, so the
  cabin's entry light (today the layout's `plasmaLuminance` / `plasmaColor`) matches the panes by construction.
- cockpit-cs-1 (against the cockpit, resolved 77e2f72): the cabin's cloud shadow through the core's chunk.

## 6. Known weaknesses (honest)

- **Not film-grade.** The cabin now reads as a built, lit, soft-and-hard interior in the real-world frames,
  but: the detail layers are still the procedural bake (no photographed or generated PBR sets; none of the
  50 USD budget spent); there is no crew, no stowage bags, tape or loose items; hard parts are still boxes
  with chamfers; the console has no side cheeks or back cover.
- **Two artefacts whose cause was not found** (section 7, items 7 and 13): a bright broken line along the
  side hatch door's upper-right edge in the lab's hatch view, and thin ragged bright lines at the rims of
  the blankets nearest the forward windows.
- **Entry**: in the integrated scene the windows are black during entry (cockpit-9); the cabin's own part
  (flickering, per-window, hue-wandering window light mixing with the floods) is in.
- **No lamp casts a sharp shadow**: flood and window visibility is baked per vertex (each lamp its own
  channel now), so the console overhang, couches and frames shade softly, a hatch rod or a switch lever
  does not. Shadow maps for the floods were not built (cost against the 0.8 ms line).
- **A sun patch still clips** in a cabin that Earth light fills (it is 7 stops over the cabin; the meter
  stops down 1.25 EV at most); its edges are clean and the surface reads at its border.
- **Window wells**: the stipple of item 15 is the exterior's surface under the core's cascade filter
  (cockpit-10).
- Perf: the display CPU line sits at its limit (section 3).
- Baked visibility is at the controls' rest pose; the probe is the lod1 interior at 128^2 (reflections in
  flat glass are soft, about 0.7 degrees per texel).

## 7. Visual close-out, round 1 (2026-11-11)

Round 0 verdict: photo 3, artifact 3.5 (list: `out/qa/wave2/cockpit.md`, 24 items). What was done per item;
screenshots are in `out/screens/cockpit/` (`world-*` = integration lab, the others = cockpit lab).

| # | Item | Done | Screenshot |
|---|---|---|---|
| 1 | Clay render, nothing reflects (blocker) | The cabin probe: reflections for every glossy and metallic surface and every glass; the uniform ambient term is gone, bounce light has a direction (normals and detail shade); brushed metal, cloth sheen; edge wear as lines. NOT done: photographed / generated texture sets, clutter (bags, tape, slack beyond the cable runs). | world-pad-noon-forward-window, world-night-displays-floods, closeup-switches |
| 2 | Blankets are boxes with a net (blocker) | Rebuilt as displaced soft goods with real quilting relief in mesh and shader, stitched seams, rolled rims, studs, per-bay variation, liner panels (section 2). | world-pad-noon-forward-window, night-displays-floods, closeup-switches |
| 3 | Sun patch with comb edges (blocker) | Cause: resolution (2 mm texels stretched by the grazing light). Per-window tiles at 0.2-0.6 mm, slope-scaled caster bias, analytic receiver plane. Found and fixed on the way: the wall beside a window was lit inside the slab between the aperture's two ends. NOT added: the browser test with the sun at 8 / 15 / 30 degrees. | leo-sun-patch-console, closeup-mfd, world-leo-sun-patch-console |
| 4 | Window views were stand-ins (blocker) | `world.spec.ts`: eight views in the integration lab over the real Earth, Moon, sky, clouds and vehicle exterior, at the metered exposure (requests 5-8). | world-leo-earth-side-window, world-moon-horizon, world-pad-noon-forward-window |
| 5 | Night chase view black, spec failing (blocker) | Both labs: the camera on the line from the seat out through the window at 0.7 m; cabin light spills into the wells (local lights); request 8 removed the vehicle's opaque pane. Spec passes without a lower threshold. | world-chase-window-night, chase-window-night |
| 6 | No direction / falloff / shadow, night brighter than noon | Probe bounce instead of the uniform term; each flood its own baked visibility; floods dimmed (4 x 120 lm + 2 x 65 lm); night key in the core. NOT done: cast shadows of thin parts from the floods. | world-night-displays-floods, night-displays-floods |
| 7 | Light through the hatch seam | The door's seal bulb closes the annulus in every detail level; unit test: no ray leaves the cabin except through a pane; the cascades' shell holds the full-detail interior. A bright broken line along the door's upper-right edge is STILL in the lab's hatch view; three causes were tested and excluded (see below). | hatch-mechanism |
| 8 | Night panes flat grey | The panes mirror the probe's image of the cabin with the displays and floods on top; black space behind. | world-night-displays-floods, night-displays-floods |
| 9 | Reentry = pad view with a filter | Per-window plasma share flickering at 4-12 Hz, hue wandering orange to pink, 320 cd/m^2 at full intensity (within about four stops of the lit cabin, as the core's tone curve needs to keep a hue), floods on, window light only inside the cone the well leaves open. The lab frame shows glowing coloured windows and a gradient. In the integrated scene the panes are black (cockpit-9, open). | reentry-plasma; world-reentry-plasma (open) |
| 10 | Occlusion stains follow the mesh | One sample pattern for all vertices, 96 AO rays; console faces on a part-aware regular grid; mount hardware and fasteners as non-occluding overlays; grime no longer driven by baked AO. The hatch pocket floor is still a ring of radial quads. | night-displays-floods, closeup-switches, closeup-fdai |
| 11 | Console: slit, floating slabs, empty lower panel, black hardware, hidden legends | Close-out beads on the hinge lines (no slit), cover strips with fasteners, 16 more switches in three groups with wickets and group lines, legends above and below the lever's throw, bright levers through the probe. NOT done: side cheeks, back cover, visible mounts. | closeup-switches, world-night-displays-floods |
| 12 | Sun patch one flat white | Core metering stops down by up to 1.25 EV for cabin highlights (5, 6). In a dim cabin (lab) the bezel and the keys read inside the patch; in an Earth-lit cabin the patch still clips. | leo-sun-patch-console, world-leo-sun-patch-console |
| 13 | Dotted white hairlines at blanket rims | Rims tucked under the frame flanges; the unbounded representative-point specular is gone; bezels cast into the sun map; skim fade. The look-back view is clean of the 254-white dotted lines; thin ragged bright lines REMAIN at the rims of the blankets nearest the forward windows in the pad view. The magenta-clear test was not added. | look-back-couches-hatch, pad-noon-forward-window |
| 14 | Frost on the panes | An even thin veil, sparse specks (a fifth of a per cent of 1.2 mm cells), wipe arcs, scratches. | world-leo-earth-side-window, pad-noon-forward-window |
| 15 | Worm stipple on window wells | NOT fixed: the wells are the exterior's surface under the core's cascade filter; a cockpit liner through the wall breaks the brief's geometry criterion (tried, removed). Request cockpit-10. | hatch-mechanism |
| 16 | Polygonal corners | Outlines sampled by curvature: 16 chords per corner at full detail, wall hole, bezel, gaskets and panes from the same points. | world-moon-horizon, world-pad-noon-forward-window |
| 17 | Blank pale squares | Hook-and-loop only as grids of 24-30 mm pads on plain liner panels, seated on the cloth, square to the bay. | world-pad-noon-forward-window |
| 18 | Hatch mechanism | Perimeter drive rod, guides, crank link, hook latches on striker posts, real handle and valve, worn paint colours (section 2). | hatch-mechanism |
| 19 | Couches | Pads re-meshed with planar metric fabric coordinates, stitched channels, piping; pans end at their pads; hinge tubes; contrasting webbing; rotary buckle; paint colours toned down. NOT done: a rebuilt load path (side beams, struts to hard points), wrinkles. | look-back-couches-hatch, chase-window-night |
| 20 | Attitude indicator | Retaining ring, domed cover glass that mirrors the cabin, recessed slotted fasteners, three rate needles driven by the vessel's body rates. The ball's artwork is flight-ui's (revised in its round). NOT done: error needles. | closeup-fdai, world-leo-sun-patch-console |
| 21 | Edge wear as dots | Wear along the middle of the chamfer in runs with frayed ends; dull grey under dark finishes. | closeup-switches, hatch-mechanism |
| 22 | Caution and warning legends | One cap height; anisotropic atlas sampling; unlit legends a little lighter. | night-displays-floods |
| 23 | MFD keys, perf screenshot | Six page keys above the page tabs; `perf-1440p-leo-seat.png` regenerated. Page layout is flight-ui's. | closeup-mfd, perf-1440p-leo-seat |
| 24 | Cable bundle ends in mid-air | Grommet and connector backshell at both ends, slack between the clamps. | world-pad-noon-forward-window |

**The two artefacts left (7, 13).** Excluded by test: (a) the wall lit inside the aperture's slab (that was
real and is fixed: it showed as white discs round the windows in the first real-world frames); (b) the
core's sun leaking past the coarse cascade shell (the shell now holds the interior; no change); (c) a sun
that skims a window's plane turning the cabin half-lit through an unbounded penumbra (bounded now; no
change). Not yet tried: an id / albedo debug view at those pixels, as the QA list suggests.

**Other things this round found in the real-world frames** (none visible in the cockpit lab): an analytic
sun-patch polygon placed on whatever small part the window's centre ray hit first (removed: the probe
carries the patches' bounce); polished press studs blooming in Earth light (a satin stud material); the
vehicle's opaque panes (cockpit-8); the black windows during entry (cockpit-9).

**Measured perf, last run of the round** (all of the package's screenshots regenerated just before it; the
other four GPU slots busy): interior p99 **0.765 ms** (G-buffer 0.642, shadow 0.0025, ambient 0.008, sun map
0.039, probe and its filter 0.074; p50 sum 0.52) against 0.8; glass p99 0.026 against 0.2; display uploads
0.015 ms GPU mean against 0.2; cockpit total 0.806 against 1.2: the GPU lines are met. Display paint + upload
+ mips on the CPU: **0.45 ms** mean per frame against 0.4: NOT met in this run (0.35 to 0.45 over the five
runs of the day; the spec fails on that line). The painting is the shared MfdPainter's (flight-ui, heavier
since its round 1); the cockpit paints 0.75 pages per frame (three displays at 15 Hz), as the brief asks.

**Last functional run**: unit 36 / 36, cockpit lab specs 19 / 19, world views 8 / 8 (the pad view re-run on
its own: in the full run the lab had not loaded the cockpit for that one page, another package's shader
being mid-edit), `tools/dev/boundaries.test.ts` green.
