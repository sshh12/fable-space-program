# Hand-off: flight-ui

Browser-safe input bindings and the flight controller (`src/input`), camera rigs and the view manager
(`src/camera`), the HUD, the WebGPU navball and the cockpit MFD painters (`src/ui`), a lab
(`labs/flight-ui`) and its specs (`tests/browser/flight-ui`, `tests/unit/flight-ui`, unit tests next to the
code). Everything imports `src/core` only; nothing writes simulation state (only `ControlInputs` and
`PlayerCommands`).

## 1. Public API

### src/input (`@/input`)

```ts
// Binding table (data). Keys by KeyboardEvent.code.
type ModifierKey = 'Shift' | 'Control' | 'Alt' | 'Meta';
type UiAction = 'ui:keyHelp';                          // presentation-only (HUD)
interface AxisBinding   { kind: 'axis';   code: string; action: AxisAction; value: number; modifiers?: readonly ModifierKey[]; requiresKeyboardLock?: boolean }
interface ButtonBinding { kind: 'button'; code: string; action: ButtonAction | UiAction; modifiers?: readonly ModifierKey[]; requiresKeyboardLock?: boolean }
type Binding = AxisBinding | ButtonBinding;
const DEFAULT_BINDINGS: readonly Binding[];
const ALL_AXIS_ACTIONS, ALL_BUTTON_ACTIONS;            // compile-time checked against the contract unions
function validateBindings(table): string[];            // reserved keys/modifiers, chord conflicts, bad codes
function chordOf(b): string; function keyLabel(code: string): string;
function keyHelpEntries(table): KeyHelpEntry[];         // { group, text, keys[], lockedKeys[] } for the HUD overlay

// DOM input system.
function createInputSystem(canvas: HTMLElement, opts?: {
  bindings?: readonly Binding[];
  captureKeyboard?: boolean;                // default TRUE: first real gesture -> fullscreen + navigator.keyboard.lock()
  fullscreenElement?: () => Element;        // default document.documentElement (HUD stays visible)
  isInteractive?: (target: EventTarget | null) => boolean;   // default: ancestor with [data-hud-interactive]
}): InputSystem;
interface InputSystem {
  readonly bindings: readonly Binding[];
  readonly keyboardLocked: boolean;
  sample(): FlightInputFrame;               // InputFrame + `ui: ReadonlySet<UiAction>`; call once per frame
  trigger(action: ButtonAction | UiAction): void;     // on-screen controls -> next frame's `pressed`
  requestKeyboardCapture(): Promise<boolean>;         // call from a click handler; never rejects
  onKeyboardLockChange(listener: (locked: boolean) => void): () => void;
  heldCodes(): string[];
  dispose(): void;
}
const HUD_INTERACTIVE_ATTR = 'data-hud-interactive';  // same string as src/ui INTERACTIVE_ATTR

function createInputCore(bindings): InputCore;        // DOM-free core (used by the system; unit-tested)

// Controller (ActiveController).
function createFlightController(opts?: { notify?: (message: string) => void; throttleRate?: number }): FlightController;
interface FlightController extends ActiveController { readonly kind: 'flight'; readonly throttle: number; setThrottle(v: number): void }
const THROTTLE_RATE = 0.5;                  // lever travel per second
function isControllerAction(a: ButtonAction): boolean;

function installUnloadGuard(isFlightInProgress: () => boolean): () => void;   // returns the remover
```

Semantics: axes = sum of held bindings clamped to [-1, 1]; a tap shorter than a frame still counts for one
frame; buttons fire once per physical press (auto-repeat and duplicate keydowns ignored); `requiresKeyboardLock`
bindings are inert unless `keyboardLocked`; every bound code is `preventDefault`ed; keyboard events whose target
is an editable element are ignored and focusing one releases all keys; release-all on window blur, page hidden
and fullscreen exit; the wheel listener is non-passive, always cancelled, and steps are normalised to their
sign (+1 = away from the user). PointerState is complete (position, deltas incl. pointer lock, buttons, edges,
doubleClick, wheel, shift/ctrl/alt, overUi). Primary-button edges are queued so that every click yields exactly
one `pressed` and one `released` frame even when a fast double click falls into one frame (the `doubleClick`
flag arrives with the second press). Right-click context menus are suppressed except in text fields.

Controller: pitch/yaw/roll/translate pass through clamped; the lever integrates `throttleRate` x 0.5/s x realDt
(Z = 1, X = 0) and is seeded from `snapshot.appliedControls.throttle` on the first update; **while
`ctx.pointerCaptured` the throttleRate axis is ignored** (attitude still works). Button actions become
`PlayerCommands` (stage, abort, SAS on/off from the snapshot, `sas:<mode>` also switches SAS on and refuses a
mode not in `sasModesAvailable`, RCS, legs, lights, fine control, navball mode toggle, warp up/down/stop,
vessel cycling). Refusals go to `notify` (connect it to `Hud.notify`). It does not act on `toggleMap`,
`cycleCamera`, `toggleHud`, `pause`, `mfdCycle:*` - those are the app's / view manager's / cockpit's.

### Default bindings (ARCHITECTURE section 11)

| Action | Keys |
|---|---|
| Pitch down / up, yaw left / right, roll left / right | W / S, A / D, Q / E |
| Throttle up / down (0.5 per s), full, cut | Left Shift or Right Shift / F (Left Ctrl too, **only while keyboard-locked**), Z, X |
| Stage, abort | Space, Backspace |
| SAS on/off, RCS, gear, lights, fine control | T, R, G, U, Caps Lock |
| SAS stability, prograde, retrograde, normal, anti-normal, radial out, radial in, maneuver | 1 - 8 |
| Translate fwd/back, left/right, up/down | I / K, J / L, H / N |
| Warp faster / slower / stop | `.` `,` `/` |
| Map, camera cycle, navball mode, prev / next vessel, HUD | M, C, Tab, `[` / `]`, F2 |
| Cockpit displays left / centre / right (`mfdCycle:0..2`) | 9, 0, `-` |
| Camera orbit / look, zoom (the mouse does the same) | arrows, Page Up / Page Down, Num + / Num - |
| Pause | P |
| Key help (HUD only) | `` ` `` |

No default binding uses Control, Alt or Meta as a key or modifier except the flagged ControlLeft
(unit-tested). Every ButtonAction and both directions of every AxisAction are bound without keyboard lock;
most are also on-screen (SAS buttons, system toggles, stage tile, warp buttons, speed readout, abort).

### src/camera (`@/camera`)

```ts
function createCockpitRig(opts: { defs: DefLibrary; fovY?; fovRange?; lookLimits?: { yaw; up; down }; swayGain?; swayMax? })
  : FlightCameraRig & { readonly lookYaw: number; readonly lookPitch: number };      // mode 'cockpit', kind 'interior'
function createChaseRig(opts: { defs: DefLibrary; terrain?: TerrainProvider; fovY?; clearance?; elevation? })
  : FlightCameraRig & { setOrbit(az, el, dist): void; readonly distance: number };  // mode 'chase', kind 'external'
function createMapRig(opts: { defs: DefLibrary; fovY?; minEv100? })
  : FlightCameraRig & { readonly focus: MapFocus | null; readonly distance: number; setOrbit(az, el, dist): void }; // 'map'
interface FlightCameraRig extends CameraRig { readonly kind: ViewKind; isAvailable(s: SimSnapshot): boolean }

function createViewManager(rigs: readonly CameraRig[], opts: { defs: DefLibrary; initialMode?: ViewMode; blendSeconds?: number; terrain?: TerrainProvider }): ViewManager;
interface ViewManager {
  readonly mode: ViewMode; readonly modes: readonly ViewMode[]; readonly blending: boolean; readonly camera: CameraState | null;
  rig(mode): CameraRig | undefined;
  setMode(mode, snapshot): boolean;
  update(snapshot, input: CameraInput, realDt, pressed?: ReadonlySet<ButtonAction>): ViewFrame;   // handles toggleMap / cycleCamera
}
interface ViewFrame { camera: CameraState; target: CameraState; observers: LodObserver[]; listener: AudioListener }

function createCameraInputMapper(opts?): { map(frame: InputFrame, realDt, ctx: { pointerConsumed: boolean; focus?: { bodyId?; vesselId? } }): CameraInput; readonly dragging: boolean };
function buildAudioListener(defs, snapshot, camera): AudioListener;
function buildLodObservers(defs, snapshot, camera, terrain?): LodObserver[];
function resolveSeatPose(defs, vessel): { eyeVes: Vec3; qViewToVes: Quat } | null;
const VIEW_BLEND_SECONDS = 0.6, CHASE_FRAME_BLEND_SECONDS = 1.6, MAP_MIN_DISTANCE = 1e5, MAP_MAX_DISTANCE = 2e9, MAP_FILL_LIGHT = 0.005, MAP_MIN_EV100 = 9;
```

- **Cockpit**: eye = `VehicleDef.cameras.cockpit` {part instance, seat id} -> the part's `command` module seat,
  through `PartSnapshot.localPos/localRot` and the vessel pose (follows the capsule through staging). Mouse look
  +-150 deg yaw, +75 / -60 deg pitch; wheel changes FOV 25-85 deg. Head sway: a critically damped spring
  (omega 14/s) toward -0.004 m per m/s^2 of the *transient* proper acceleration (acceleration minus its 1.2 s
  low-pass) plus 8 % of that per sustained m/s^2, capped at 5 cm. `isAvailable` is false for vessels without a
  cockpit (the manager then falls back to the next flight view).
- **Chase**: orbits the vessel CoM. Reference frame per `snapshot.navball.mode`: surface = local vertical up,
  azimuth from north; orbit = the orbit plane (azimuth 0 along the orbital velocity, up = in-plane
  perpendicular). A mode change blends the frame over 1.6 s while re-expressing the camera angles, so the view
  does not swing. Distances from `VehicleDef.cameras.chase` (min raised to 1.05 x bounding radius); vessels
  without a vehicle definition use 2.4 / 1.15 / 60 x bounding radius. With a TerrainProvider the eye stays
  `clearance` (2.5 m) above `heightAt(..., lambdaMin 0.5 m)` and above the sea; without one above the datum
  sphere (and sea level).
- **Map**: distance measured from the focus SURFACE, 100 km .. 2e9 m, exponential zoom smoothed in log space;
  azimuth about ROOT +Z. Focus changes from `CameraInput.focusBodyId / focusVesselId` glide the pivot over 1.1 s
  (C-infinity smooth step, both ends tracked live) with the eye distance continuous; activation starts on the
  ray through the previous camera. `fillLight` 0.005, `minEv100` 9 (lower bound on EV100, keeps night sides
  dark-but-readable with the fill light).
- **View manager**: M toggles the first kind-'map' rig and back to the last flight view; C cycles all
  non-map rigs (in registration order, skipping unavailable ones; nothing in the map). Unknown modes are
  classified by their `kind` (`FlightCameraRig.kind` or, for a plain `CameraRig`, one zero-time update).
  Every switch blends 0.6 s: the presented camera is frozen relative to the active vessel (vessel frame for
  interior views, CoM-relative otherwise), then interpolated log-polar about the CoM (slerped direction,
  interpolated log distance), slerped orientation, lerped FOV / fill / exposure, with the C-infinity smooth step;
  mode / kind / insideVesselId switch at the midpoint. Observers = camera + every vessel within 2 km of a surface
  (active vessel: radar altitude; others: TerrainProvider if given, else datum sphere), radiusBias = bounding
  radius. Listener: position / forward / up in the active vessel's VES frame; `ambientPressure` = the vessel's
  ambient pressure carried to the eye with the isothermal barometric formula (H = R T / g), 0 above the
  atmosphere's `simTop` or on airless bodies.
- **Input mapping**: drags with any button that START on the scene (not over the HUD, not consumed by the map)
  orbit/look (0.005 rad/px, drag right = view turns right); arrow keys 1.4 rad/s; wheel step x1.18 (forward =
  zoom in); Page Up/Down, Num +/- x3 per second. While `pointerConsumed`, no pointer input reaches the rig.

### src/ui (`@/ui`)

```ts
function createNavballRenderer(gpu: GpuHandle, opts?: { perf?: Pick<PerfRecorder, 'gpuPass'> }): NavballRendererImpl;
interface NavballRendererImpl extends NavballRenderer {      // view: 512 x 512 rgba8unorm, published as 'ui.navball'
  readonly texture: GPUTexture;
  readonly lastMarkers: readonly MarkerInstance[];
  renderState(encoder, state: NavballState): void;            // render(encoder, snapshot) = renderState(encoder, snapshot.navball)
  renderTo(encoder, state, target: GPUTextureView, format: GPUTextureFormat, sizePx: number): void;
  dispose(): void;
}
function projectMarker(dirVes: Vec3, sizePx: number): { sx; sy; px; py; visible; alpha };   // CPU = GPU placement
function markerInstances(markers: NavballMarkers): MarkerInstance[];
function ballDirectionHorizon(sx, sy, qVesselToHorizon): Vec3 | null;  function pitchHeadingOf(d): { pitchDeg; headingDeg };

function createHud(opts: HudOptions): HudImpl;
interface HudOptions {
  defs: DefLibrary; gpu: GpuHandle; navball: NavballRendererImpl;
  dispatch: (action: ButtonAction) => void;                  // connect InputSystem.trigger
  requestKeyboardCapture?: () => void;                       // connect InputSystem.requestKeyboardCapture
  keyHelp: readonly HudKeyHelpEntry[];                       // keyHelpEntries(input.bindings)
  keyFor?: (action: ButtonAction) => string | null;          // key caps on buttons / stage tile
  commands?: () => PlayerCommands | null;                    // target selection on the pad
}
interface HudImpl extends Hud {
  readonly root: HTMLElement; readonly visible: boolean; readonly keyHelpOpen: boolean;
  setKeyboardLocked(locked: boolean): void; toggleKeyHelp(force?: boolean): void;
  readonly lastUpdateMs: number; readonly meanUpdateMs: number;
  landingTargetRows(): [string, string][] | null; notifications(): string[];
}

function createMfdPainter(): MfdPainter & { build(page, snapshot, defs): MfdPageModel };
function buildMfdPage(page: MfdPage, snapshot, defs): MfdPageModel;   // { title, rows, section?, status }
const MFD_PAGES = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];
// shared display models and formatters (HUD and MFD render from these):
describeLandingTarget, landingTargetRows, describeOrbit, describeStages, describeResources, describeWarp, describeNodeBurn, describePad,
formatLength / formatAltitude / formatDistance / formatSpeed / formatDeltaV / formatDuration / formatCountdown / formatMet / formatUt /
formatBearing / formatDeg / formatPercent / formatPressure / formatHeatFlux / formatG / formatMach / formatMass / formatSignedRange / formatLatLon ...
```

- **Navball**: an analytically ray-cast sphere (exact silhouette, per-pixel normal) whose equirectangular
  texture (2048 x 1024 + mips, drawn once with Canvas 2D: sky/ground hemispheres, horizon, heading ticks and
  labels every 30 deg, meridians, pitch ladder every 10 deg with numerals, zenith / nadir marks, labels
  pre-stretched by 1/cos(latitude)) is fixed in the horizon frame and rotated by `qVesselToHorizon`. The ball
  shows the hemisphere in front of the nose orthographically: screen right = VES +X, up = VES +Z; a VES marker
  `d` sits at `(d.x, d.z)` when `d.y > 0` and fades toward the limb. Markers (all of `NavballMarkers`) and the
  orange vessel reticle are icons from a natively-drawn mip-mapped atlas, reticle under the markers. Soft key
  light, limb darkening, faint gloss. **Texture contents: sRGB-encoded colour, premultiplied by coverage,
  alpha = coverage** (the cockpit should treat it as a premultiplied sRGB image). `render` and `renderTo` share
  one marker uniform buffer: within one submission, render both from the same state.
- **HUD**: DOM + the navball canvas over the WebGPU canvas; only interactive parts take pointer events (and
  carry `data-hud-interactive`). Layout by `camera.kind`: external = everything; interior = clock, warp,
  notifications, landing target, stage stack, keyboard pill, help; map = clock, warp, altitude, orbit, landing
  target, node burn, navball + SAS. Panels: MET / UT / warp chevrons with the limit reason and warp buttons;
  altitude (auto: radar within 2 km of the ground in flight, else sea level; click cycles auto / sea level /
  radar) with vertical and horizontal speed; launch panel on the ground (target body buttons via `commands`,
  relative inclination, plane crossing countdown, launch azimuth); orbit (Ap / Pe with time-to, inclination,
  period; Pe red below the surface, amber inside the atmosphere); landing target (name, kind, distance, bearing,
  down-range ahead/behind, cross-range left/right, "no ground track" when stationary, impact / entry-point miss
  or "Predicted arrival: none", INSIDE ZONE badge); atmosphere (q, Mach, AoA); entry (heat flux, ablator bar,
  skin temperature bar, LIFT UP/DOWN, chute envelope light); stage stack (next 6 unfired stages, next at the
  bottom, icon + action icons, delta-v, TWR, burn time, propellant bar, Space key cap, click to stage, LOCKED
  state); resources per stage group; SAS / RCS / GEAR / LIGHTS / FINE / ABORT toggles and the 8 SAS mode buttons
  (unavailable modes disabled); speed with surface/orbit (click toggles); navball with heading, pitch, roll;
  throttle and g gauges with g-dose bar; node burn (delta-v, burn time, start countdown, pulsing in the last
  10 s); terrain-loading notice (pending below 2 km radar); mission-failed banner; keyboard-capture pill (click
  to capture) / "Keyboard captured"; key-help overlay generated from the binding table; toasts (deduplicated
  with a count; also for warp drops with a reason, milestones, SOI changes, crew loss, part loss, vessel switch,
  chute failure). Sizes derive from `min(1vh, 0.5625vw)`, so 1280 x 720 and 3840 x 2160 look identical.
- **The HUD renders the navball** in every `update` (the shared 512 texture always, the HUD canvas copy while it
  is on screen) on its own command encoder and submits it. The app must not render the navball separately; it
  publishes `navball.view` as `'ui.navball'`.
- **MFD**: `paint(ctx, w, h, page, snapshot, defs)` draws a full page (header tabs, MET, rows, an instrument -
  ADI on flight, orbit diagram on orbit, resource bars on systems, stage list on staging, g / dose / ablator /
  temperature gauges + lift arrow on entry, landing scope on landing - and a SAS / RCS / warp / UT footer). All
  sizes scale with the canvas height (designed for 1024 x 768, legible at 512 x 384). The entry and landing
  pages carry `landingTargetRows()` verbatim. The ADI uses rollDeg positive = roll right (ARCHITECTURE sign).

## 2. How the app wires it (ARCHITECTURE section 5)

```ts
const input = createInputSystem(canvas);                       // captureKeyboard defaults to true
const navball = createNavballRenderer(gpu, { perf });           // resources.publish('ui.navball', navball.view)
const hud = createHud({ defs, gpu, navball, dispatch: (a) => input.trigger(a),
  requestKeyboardCapture: () => void input.requestKeyboardCapture(), keyHelp: keyHelpEntries(input.bindings),
  keyFor, commands: () => sim.commands });
hud.mount(document.getElementById('ui-root')!); hud.setKeyboardLocked(input.keyboardLocked);
input.onKeyboardLockChange((l) => hud.setKeyboardLocked(l));
const controller = createFlightController({ notify: (m) => hud.notify(m) });
const views = createViewManager([createChaseRig({ defs, terrain }), createCockpitRig({ defs }), createMapRig({ defs })], { defs, terrain, initialMode: 'chase' });
const mapper = createCameraInputMapper();
installUnloadGuard(() => flightInProgress);

frame(realDt):
  const f = input.sample();
  if (f.ui.has('ui:keyHelp')) hud.toggleKeyHelp();
  if (f.pressed.has('toggleHud')) hud.setVisible(!hud.visible);   // pause, mfdCycle:i -> app / cockpit.cyclePage(i)
  mapView.setActive(views.mode is a kind-'map' rig);
  const map = mapActive ? mapView.update(lastSnapshot, lastCamera, sim.commands, f.pointer, size) : { consumed: false };
  sim.setControls(controller.update(f, lastSnapshot, sim.commands, realDt, { view: lastCamera.kind, pointerCaptured: map.consumed }));
  sim.advance(realDt); snapshot = sim.snapshot();
  const view = views.update(snapshot, mapper.map(f, realDt, { pointerConsumed: map.consumed, focus: map.focus }), realDt, f.pressed);
  hud.update(snapshot, view.camera, realDt);                       // also renders the navball texture
  audio.update({ snapshot, listener: view.listener, ... }); renderer.render(snapshot, view.camera, view.observers, realDt);
```

`labs/flight-ui/main.ts` is a working example of exactly this loop against the FakeSim.

## 3. How to run and verify

```
npm run typecheck:paths -- src/input src/camera src/ui labs/flight-ui tests/browser/flight-ui tests/unit/flight-ui
npx vitest run src/input src/camera src/ui tests/unit/flight-ui tools/dev/boundaries.test.ts      # 62 tests
npx playwright test tests/browser/flight-ui --project=functional                                  # 45 tests
npx playwright test tests/browser/flight-ui --project=perf                                        # under the GPU lock
```

Lab: `/labs/flight-ui/?scene=<FakeScene>` with `view=chase|cockpit|map`, `capture=1`, `extraRig=1`,
`node=1`, `target=moon`, `predicted=impact|entry`, `failed=1`, `terrainPending=1`, `lockout=1`, `guard=1`,
`mfd=1` (the six MFD pages), `help=1`, `orbit=<yawDeg>,<pitchDeg>,<distance>`. The lab adds a test vehicle
(`labs/flight-ui/labVehicle.ts`: four stage groups, resources, a command part with the mouldline seats) to the
loaded library and tags FakeSim snapshots with it; `predicted`, `failed`, `terrainPending`, `lockout` are lab
decorations of the snapshot (the FakeSim produces none of them). The backdrop (`backdrop.ts`) is a lab-only ray
tracer for judging cameras and HUD legibility; it is not shipped.

Screenshots (all reviewed by eye): `out/screens/flight-ui/<scene>-720p.png` and `<scene>-4k.png` for all eight
FakeSim scenes, plus `cockpit-lowOrbit`, `map-lowOrbit`, `keyhelp`, `failed`, `terrain-pending`, `mfd-pages`
(both sizes), `prograde-hold`, `warp-refused`, `extra-rig`, `stage-lockout`.

## 4. Acceptance criteria and measured results

| Criterion | Result |
|---|---|
| Binding table: no Ctrl/Alt/Meta key or modifier unless `requiresKeyboardLock`; no shared chord; every ButtonAction / AxisAction reachable | met (`tests/unit/flight-ui/bindings.test.ts`) |
| Controller: pointerCaptured + held throttle key changes nothing while pitch/yaw/roll work; free pointer ramps 0.5/s | met (`src/input/flightController.test.ts`, browser spec "pointer captured by the map") |
| Real keys: W pitch -1 (S +1, D yaw +1, Q roll -1) | met |
| ShiftLeft ramps 0.5/s, F lowers it (closed loop, slope from the frame log) | met: measured within 0.45-0.55 per s both ways |
| F + W + T held together: page alive and responsive, T toggled once | met |
| Space stages; T / R / G toggle | met |
| Digit2 -> prograde; reticle converges onto the prograde marker (within 2 px on the 512 texture) | met |
| Digit9 emits mfdCycle:0 (and 0 / - -> 1 / 2) exactly once | met |
| Period / comma / slash change warp; refusal shows a notification | met ("Cannot warp faster here" toast at the physics-warp cap) |
| Clicking SAS buttons, toggles, the stage tile (and the speed readout) works | met; lockout blocks the tile |
| Blur releases all keys | met |
| captureKeyboard: a real click leaves `keyboardLocked` a boolean, no error | met (either answer accepted; the HUD shows the matching pill) |
| PointerState edges and doubleClick exactly once | met (click: 1 / 1 / 0; double click: 2 / 2 / 1) |
| Navball: zenith at the reticle for nose-up; heading 090 wings level horizontal horizon with sky on top; roll right raises the horizon's right end by tan(roll) | met on the CPU reference (unit) and on the GPU texture (readback spec) |
| Marker positions match an independent projection within 1 px | met: < 1e-6 px over 2,000 random directions (`navball.test.ts`) |
| Camera: continuous through switches (< 1 cm / 0.1 deg at both blend ends, no spikes), incl. a vessel at 7.8 km/s | met (6 switch cases) |
| Chase respects a fake terrain; cockpit eye at the seat; map 100 km .. 2e9 m in float64; focus request smooth; unknown-mode external rig through manager, HUD and listener | met (vitest + "M and C" browser spec) |
| Landing-target panel shows the lunar scenes' numbers and equals the MFD landing page strings | met (DOM rows == `buildMfdPage('landing')` rows, distance and bearing checked against the readout) |
| Screenshots of every scene at 720p and 4K reviewed by eye | done (section 3) |
| HUD update < 0.5 ms per frame average | **0.28 ms mean**, p50 0.26 ms, p99 0.55 ms (400 frames, 2560 x 1440, lowOrbit with a node; includes the navball encode + submit) |
| Navball < 0.05 ms GPU (17.1) | **0.009 ms p50, 0.025 ms p99** for the 512 texture; HUD canvas copy 0.0005 ms p50 / 0.007 ms p99 |
| expectNoErrors on every spec | yes (window errors, GPU errors and console warnings) |

Timings were taken under the GPU lock while other agents' work may have been loading the machine (wave 1):
provisional, to be re-measured by the lead.

## 5. Known limits (stated plainly)

- `InputFrame.pressed` is a set: two presses of the same key inside one frame (under ~16 ms) count once. Pointer
  edges are queued across frames; key presses are not, because the contract has no count.
- FakeSim's `rollDeg` has the opposite sign to the ARCHITECTURE / real-sim convention (request
  `sim-orbits-2`, against `src/core`). The HUD prints `rollDeg` as given and the MFD ADI assumes the
  ARCHITECTURE sign, so the ADI looks mirrored on the FakeSim only. The navball itself uses the quaternion and is
  unaffected.
- The HUD's interior (cockpit) layout is deliberately minimal (the cockpit instruments carry the rest); the
  cockpit package must provide the navball / MFD instruments for it to be complete.
- Head sway is a kinematic spring on the proper acceleration, not a body model.
- Chase-rig limits for vessels without a vehicle definition and LOD-observer heights for non-active vessels
  without a TerrainProvider are documented approximations (bounding-radius multiples, datum sphere).
- The listener's pressure uses an isothermal extrapolation from the vessel; the chase camera is metres from the
  vessel so the error is negligible; the map camera is above the atmosphere (0 Pa).
- The map rig's reference is ROOT +Z for every focus (not the focus body's own pole).
- Fonts: system stack `Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui` (Bahnschrift ships with Windows
  10/11, the target platform); no font file is shipped in `public/assets/ui`.
- The lab's FakeSim stage stack shows generic per-stage numbers (FakeSim limitation, not the HUD's).
- Multiple MFD consumers: `paint` is stateless; the cockpit owns page selection (`CockpitControls`).

## 6. Requests and contract notes

No request files were filed. No open request in `docs/requests/` targets flight-ui paths. Notes for the lead:

1. `createHud` takes an options object (the brief wrote `createHud(): Hud`): it needs the GPU handle, the navball
   renderer and the dispatch / capture callbacks, and `src/ui` may not import `src/input`, so the binding table
   arrives as data (`keyHelp`, `keyFor`).
2. Consider documenting in `ui.ts` that `'ui.navball'` holds sRGB-encoded, premultiplied colour (what this
   implementation writes into the `rgba8unorm` texture).
3. `sim-orbits-2` (FakeSim roll sign) affects how the FakeSim looks in this lab; nothing in flight-ui needs to
   change when it is fixed.
