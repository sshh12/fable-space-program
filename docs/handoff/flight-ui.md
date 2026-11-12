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
  captureKeyboard?: boolean;                // default FALSE (round 6): true = the app's opt-in to ask on the first real gesture
  fullscreenElement?: () => Element;        // default document.documentElement (HUD stays visible)
  isOverUi?: (target: EventTarget | null) => boolean;   // PointerState.overUi; default: an element other than the canvas
}): InputSystem;
interface InputSystem {
  readonly bindings: readonly Binding[];
  readonly keyboardLocked: boolean;         // fullscreen AND the lock granted
  readonly fullscreen: boolean;             // the capture is on (with or without the lock)
  sample(): FlightInputFrame;               // InputFrame + `ui: ReadonlySet<UiAction>`; call once per frame
  trigger(action: ButtonAction | UiAction): void;     // on-screen controls -> next frame's `pressed`
  requestKeyboardCapture(): Promise<boolean>;         // call from a click handler; never rejects
  releaseKeyboardCapture(): void;                      // leave fullscreen + unlock (the switch's second click)
  onKeyboardLockChange(listener: (locked: boolean, fullscreen: boolean) => void): () => void;
  heldCodes(): string[];
  dispose(): void;
}

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
is an editable element (`input` other than buttons / checkboxes, `textarea`, `select`, contenteditable) reach
no binding and are not `preventDefault`ed (digits, Backspace, Space and Enter edit the text), and focusing one
releases all keys; release-all on window blur, page hidden and fullscreen exit; the wheel listener is
non-passive, always cancelled, and steps are normalised to their sign (+1 = away from the user). PointerState
is complete (position, deltas incl. pointer lock, buttons, edges, doubleClick, wheel, shift/ctrl/alt, overUi).
**`overUi` is true while the pointer is over any element other than the canvas** (HUD controls, the map's node
panel, any overlay that takes pointer events; the HUD lets the pointer through everywhere else); edges and wheel
steps are still reported, with `overUi` set, and consumers (camera mapper, map view) ignore them. A press on
the canvas captures the pointer, so a drag that starts on the scene stays a scene drag (`overUi` false) until
release wherever it goes. Primary-button edges are queued so that every click yields exactly
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
  renderTo(encoder, state, target: GPUTextureView, format: GPUTextureFormat, sizePx: number,
           opts?: { radiusFraction?: number; lip?: number; instrument?: boolean }): void;
           // HUD: radiusFraction HUD_BALL_RADIUS_FRACTION / HUD_BALL_LIP, lip HUD_BALL_LIP, instrument look
  dispose(): void;
}
const HUD_BALL_RADIUS_FRACTION = 0.84;                          // the bezel's window (inner edge) in the HUD ball canvas
const HUD_BALL_LIP = 0.94;                                      // part of the ball's radius the window shows (the lip covers the rest)
function drawNavballBezel(ctx, sizePx, windowFraction, outerFraction?): void;  // src/ui/navball/bezel.ts (static 2-D bezel on a
                                                                // canvas 1.28 x the ball box: its round shadow fades out inside it)
function projectMarker(dirVes: Vec3, sizePx: number): { sx; sy; px; py; visible; alpha };   // CPU = GPU placement
function markerInstances(markers: NavballMarkers): MarkerInstance[];
function ballDirectionHorizon(sx, sy, qVesselToHorizon): Vec3 | null;  function pitchHeadingOf(d): { pitchDeg; headingDeg };

function createHud(opts: HudOptions): HudImpl;
interface HudOptions {
  defs: DefLibrary; gpu: GpuHandle; navball: NavballRendererImpl;
  dispatch: (action: ButtonAction) => void;                  // connect InputSystem.trigger
  requestKeyboardCapture?: () => void;                       // connect InputSystem.requestKeyboardCapture
  releaseKeyboardCapture?: () => void;                       // connect InputSystem.releaseKeyboardCapture
  showCaptureControl?: boolean;                              // default true; false = no capture switch (footage)
  keyHelp: readonly HudKeyHelpEntry[];                       // keyHelpEntries(input.bindings)
  keyFor?: (action: ButtonAction) => string | null;          // key caps on buttons / stage tile
  commands?: () => PlayerCommands | null;                    // target selection on the pad
  failureActions?: readonly HudFailureAction[];              // next steps on the mission-failed banner (app shell)
}
interface HudFailureAction { label: string; key?: string; title?: string; run(): void }
interface HudImpl extends Hud {
  readonly root: HTMLElement; readonly visible: boolean; readonly keyHelpOpen: boolean;
  setKeyboardLocked(locked: boolean, fullscreen?: boolean): void;   // fullscreen defaults to locked
  setCaptureControlVisible(visible: boolean): void; toggleKeyHelp(force?: boolean): void;
  readonly lastUpdateMs: number; readonly meanUpdateMs: number;   // JavaScript of update() only (see section 4)
  readonly textUpdates: number;                                     // updates that refreshed the text readouts
  landingTargetRows(): [string, string][] | null; notifications(): string[];
}
const HUD_TEXT_HZ = 10;                                             // refresh rate of the numeric text readouts

function createMfdPainter(opts?: { bodyAlbedo?: (bodyId: string) => BodyAlbedoMap | null }): MfdPainter & { build(page, snapshot, defs): MfdPageModel };
interface BodyAlbedoMap { width: number; height: number; data: Uint8ClampedArray }  // equirect, row 0 north, col 0 lon -180, sRGB RGBA
                                                                   // (the tile set's globals.albedoLowRes, as the app loads it for its globe)
function buildMfdPage(page: MfdPage, snapshot, defs): MfdPageModel;   // { title, rows, section?, status }
const MFD_PAGES = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];
// shared display models and formatters (HUD and MFD render from these):
describeFlight(s, mode?: 'auto' | 'asl' | 'radar'): FlightView;   // altitude (+ source), vertical speed (signed) + verticalTrend
                                                                   // ('up' | 'down' | 'level', drawn as an icon), horizontal speed,
                                                                   // speed of the navball mode, pitch, heading, roll, throttle, g
altitudeSource(s, mode?): 'radar' | 'asl';  const RADAR_ALTITUDE_SWITCH = 2000;  isLanded(v): boolean;
altitudeDatumName(s, defs): 'sea level' | 'datum';                // 'sea level' only on a body with an ocean (not the Moon)
orbitPhase(s, defs): { show; suborbital; periapsisTone };         // phase-aware orbit readout (see HUD below)
inAtmosphere(s, defs); isDescending(s, defs);                     // flight phase helpers
landingTargetExpanded(s, defs): boolean;                          // the landing-target panel shows its rows (else one line)
describeStages(s, defs?): { tiles (StageTileView incl. active, actions, burnName); active: number; lockout; nextStage; deltaVTotal };
                                                                   // active = the fired stage the sim still reports numbers for
stageBurnLabel(s, defs, index): string | null;                    // what a stage burns: the stage-group labels of the engines its
                                                                   // igniteEngines actions light ("Meridian M-3"); titles the active tile
zoneStatus(s, defs): { inside; basis: 'impact' | 'position' } | null;  // recovery-zone light: from an impact prediction, or the
                                                                   // sub-point landed / below TERMINAL_DESCENT_SPEED (250 m/s) descending
                                                                   // through air; null in orbit and with only an entry-interface prediction
stageActionText(actionKinds): string;                             // "separate · deploy chute"
summarizeResources(groups): { inUse: { id; label; fraction; amount; detail }[]; full: string[] };  // HUD resource panel
const ABLATOR_REDLINE = 0.3; ablatorTone(f): 'good' | 'warning';  // one ablator rule for HUD and MFD (low is bad)
const G_SCALE = { caution: 6, limit: 10, full: 12 }; gTone(g);    // one g scale for the HUD gauge and the MFD pages
describeLandingTarget (LandingTargetView incl. `tracked`; bearing "on target" within ON_TARGET_DISTANCE = 0.5 m),
landingTargetRows (rows without data collapse), isPredictionRow(label),
landingScope(view): { east; north; trackDeg: number | null },
TREND_ICONS (up / down / level), drawIcon(ctx, icon, x, y, size, color, outline?, box?, outlineWidth = 2.4),
describeOrbit, describeStages, describeResources, describeWarp, describeNodeBurn, describePad,
formatLength(m, 'distance' | 'altitude' | 'apsis') / formatAltitude / formatDistance / formatApsis / formatSpeed / formatVerticalSpeed /
formatDeltaV / formatDuration / formatCountdown / formatMet / formatUt / formatBearing / formatDeg / formatPercent / formatPressure /
formatHeatFlux / formatG / formatMach / formatMass / formatSignedRange / formatLatLon ...
```

Number formats that matter (one rule for HUD and MFD, chosen so that no unit or precision boundary sits where a
value hovers in flight): current altitude in m below 50 km, then km with one decimal; apoapsis / periapsis
always in km with one decimal (Mm from 10,000 km), so Ap and Pe share unit and precision and nothing changes
form around the 100 km lunar parking orbit; distances m below 10 km, km with two decimals below 100 km, one below
1,000 km and none from 1,000 km on (a recovery zone 6 126 km away); vertical speed "+12.3 m/s" / "−4.0 m/s" /
"0.0 m/s" with the direction drawn as an SVG / Path2D chevron or level bar (never a font glyph); heading "087°"
(compass, integer); pitch and roll one decimal.

- **Navball**: an analytically ray-cast sphere (exact silhouette, per-pixel normal) whose equirectangular
  texture (2048 x 1024 + mips, drawn once with Canvas 2D) is fixed in the horizon frame and rotated by
  `qVesselToHorizon`. Texture: sky/ground hemispheres, horizon with heading ticks, heading labels every 30 deg
  just above it, meridians every 30 deg and the ladder every 10 deg up to 70 (both stop at the pole rings),
  pitch numerals ON the ladder lines in the open between meridians (headings 45 / 135 / 225 / 315: +-20 to
  +-60 on four columns, +-70 on two, none at +-10 and +-80), every label over a halo of the local background
  colour (no line runs through a glyph) and pre-stretched by 1/cos(latitude); zenith / nadir: a bold ring at
  80 deg with four inward ticks and a cap from 87.5 deg (larger than the reticle hub, so it frames the reticle
  pole-on). The ball shows the hemisphere in front of the nose orthographically: screen right = VES +X, up =
  VES +Z; a VES marker `d` sits at `(d.x, d.z)` when `d.y > 0` and fades toward the limb. Markers (all of
  `NavballMarkers`) are icons from a natively-drawn mip-mapped atlas (256 px cells), clipped to the ball's
  visible disc; the orange vessel reticle is drawn LAST (on top, like an ADI's aircraft symbol): two thin wings
  with downward stubs and a centre dot, everything but the dot outside a radius of 12 icon units, beyond the
  rays of a marker (ring 5, rays to 10.5), so a marker held on the nose shows whole around the dot. Two looks:
  the shared texture has soft shading only (the cockpit relights it as an albedo); the HUD canvas
  (`instrument: true`) draws the ball 1 / 0.94 larger than the bezel's window, whose lip covers the outer rim
  (`HUD_BALL_LIP`: the window shows directions up to 70 deg off the nose, so heading labels and numerals
  foreshortened to slivers at the limb are never shown), with a wrap-diffuse key light from the upper left and a
  dark terminator side, limb darkening, a contact shadow under the lip, label ink shaded less than the painted
  background (numerals on the dark side keep their contrast) and fading into the paint toward the lip, a faint
  graded window reflection (peak 0.17, soft edges, in the outer band just inside the lip, off the numeral
  diagonal), a faint Fresnel rim, and the bank **sky pointer**: a white triangle on the rim toward the zenith as
  projected on the ball, which reads against the bezel's fixed roll scale (fades out with the nose within about
  8 deg of the vertical, where bank is undefined). The HUD's bezel (recessed gap, top-lit bevel, roll scale at
  10 / 20 / 30 / 45 / 60 and every 30 deg, orange top index) is a static 2-D canvas over it, larger than the
  ball's box so its round drop shadow fades out inside it. **Texture contents:
  sRGB-encoded colour, premultiplied by coverage, alpha = coverage** (the cockpit should treat it as a
  premultiplied sRGB image). `render` and `renderTo` share one marker uniform buffer: within one submission,
  render both from the same state.
- **HUD**: DOM + the navball canvas (and its static bezel canvas) over the WebGPU canvas; only interactive parts
  take pointer events (exactly the elements carrying `data-hud-interactive`, `INTERACTIVE_ATTR`). Layout by
  `camera.kind`: external = everything; interior = clock, warp, notifications, landing target, stage stack,
  keyboard pill, help; map = clock, warp, altitude, orbit, landing target, node burn, navball + SAS. **The frame
  is for the scene: the HUD covers at most 20 % of a 16:9 frame in every external scene** (measured 15.5-19.9 %
  at 720p, asserted by the screenshot spec from the layout: plates, tiles, chips and the bezel disc). Plates are
  near-opaque (`UI_COLORS.panel`, alpha 0.97, request flight-ui-2) with a light hairline, a dark outer ring and
  a lit top edge: a horizon behind a plate stays within 8 levels across it (asserted on the near-white backdrop);
  secondary text `#aebccf` keeps >= 4.5 : 1 (asserted). Base type 1.85u (13.3 px at 720p), nothing under 0.76 em
  (10 px). The bottom cluster is a `1fr auto 1fr` grid
  with the navball alone in the middle column: the ball stays on the centre line whatever appears beside it (node
  panel, gauges), asserted to 1 px with and without a node in the flight and map views. Panels: MET / UT / warp
  chevrons with the limit reason and warp buttons; altitude (auto: radar within 2 km of the ground in flight,
  else the reference height - `altitudeSource`, the same rule as the MFD flight page; the reference is named
  "sea level" on a body with an ocean and "datum" elsewhere - `altitudeDatumName`; click cycles auto / sea level
  (datum) / radar) with vertical speed (trend icon + signed value) and horizontal speed; launch panel on the
  ground, shown only when it has content (a target body button to pick - every attractor except the root and the
  body underfoot -, a target, or a launch window; so not on the lunar surface) with relative inclination, plane
  crossing countdown, launch azimuth; orbit (Ap / Pe with time-to, inclination, period), phase-aware
  (`orbitPhase`): a periapsis below the surface is amber with "suborbital" under power or inside the atmosphere
  and red only when coasting above it (an impact); Pe amber inside the atmosphere; the panel hides in the
  external view while the vessel falls through the atmosphere on a suborbital path (entry, parachutes); landing
  target (name, kind, distance, bearing, down-range ahead/behind, cross-range left/right, impact / entry-point
  miss or "Predicted arrival: none"; without a ground track and a prediction the empty rows collapse into one
  "Track · arrival: none" row); a recovery zone gets a status row at value size: green INSIDE ZONE, amber
  OUTSIDE ZONE once the descent is committed (chutes or a prediction), with the zone radius; atmosphere (q, Mach,
  AoA) as its own panel during an ascent and folded into the entry panel while that shows; entry (heat flux,
  ablator bar, skin temperature bar, LIFT UP/DOWN, chute envelope light); stage stack (one tile per unfired
  StageInfo - fired stages leave the stack -, next at the bottom; a tile is a stage-number column, an icon plate,
  the name on a line of its own with the action icons that differ from the stage icon, then the Space key cap,
  delta-v, TWR and burn time (or "no engines"), and a thin propellant strip; click to stage; LOCKED state: an
  amber hatched tile, a padlock plate and "LOCKED after last stage" at label size; with more than 6 stages the
  stages after the next two are compact one-line tiles (number, icon, name, delta-v), so the 10-stage mission
  vehicle fits on the pad above the resources at every resolution, every name in full (asserted); a stack taller
  than the column would be clipped at its far end, never at the next stage; header "Δv … total"); resources per
  stage group; SAS / RCS / GEAR / LIGHTS / FINE / ABORT toggles and the 8 SAS mode buttons (the key digit owns
  the top-left corner, the icon is inset away from it; unavailable modes disabled); speed with surface/orbit
  (click toggles); navball with heading, pitch, roll; throttle and g tape gauges on one grid (shared tops,
  bottoms and value rows) with numerals (0 / 50 / 100 %, 0 / 4 / 8 / 12 g), ticks, colour zones fixed to the
  scale (g: green to 6 g, amber to the 10 g limit, red above; `G_SCALE`, the sim's g-dose thresholds) revealed by
  the fill, a red limit mark at 10 g and the g-dose bar under the g tube; node burn (delta-v, burn time, start
  countdown, pulsing in the last 10 s); terrain-loading notice (pending below 2 km radar; under the altimeter,
  above the toasts, clear of every panel); mission-failed banner; keyboard-capture pill (click to capture) /
  "Keyboard captured"; key-help overlay generated from the binding table (an opaque sheet; the flight panels are
  hidden while it is open; punctuation key caps show the glyph and its shifted glyph: ". >", ", <", "` ~");
  toasts (deduplicated with a count; the same text twice within one HUD frame - e.g. a refusal reported as a
  CommandResult and again as a sim event - counts once; a `warpChanged` reason is toasted only when the sim
  LOWERED the warp by itself, because refusals of the player's own warp requests come back as CommandResults
  that the flight controller reports; also milestones, SOI changes, crew loss, part loss, vessel switch, chute
  failure). Sizes derive from `min(1vh, 0.5625vw)`, so 1280 x 720 and 3840 x 2160 look identical.
  Round-2 layout (supersedes the panel list above where they differ): clock = MET with the warp factor on one
  line, UT, warp chevrons and the limit; orbit = Ap / Pe, inclination and period only while the periapsis is
  above the surface (a suborbital path says so once, amber, in the title), the atmosphere strip (dyn. Q, Mach,
  AoA as three cells) under it during an ascent, in the entry panel while that shows, else in its own panel;
  the orbit panel also leaves while heating; landing target = one line (name, distance · bearing) until a
  prediction, heating or a descent (`landingTargetExpanded`), then the full rows and the zone light; entry =
  heat flux, heat shield and skin temperature as label / bar / value rows (each bar coloured by the zone of its
  reading: the heat shield green, red only below the 30 % redline), lift vector, chute envelope (shown only while
  coming down through air: the real sim reports an envelope whenever a chute stage remains); stage stack = the
  later stages as one list of one-line rows (number, icon, name, delta-v of engine stages; nothing about engines
  on the others), the next stage as a full tile (number, name, Space cap; delta-v / TWR / burn, or for an
  engine-less stage what firing it does: "separate · deploy chute"), and at the bottom the **active stage**
  (the fired stage the sim still reports numbers for: green, ACTIVE tag, live delta-v / TWR / burn and the
  propellant strip); header "Δv … total" (the sim's total includes the active stage); resources = one bar per
  stage group in use (its resource that runs out first; tooltip lists all) and the full groups folded into one
  "FULL …" line ("ALL FULL" on the pad); bottom = SAS panel, speed, a chip row above the bezel (PITCH, heading
  over the top index, ROLL: fixed-width windows that never touch the instrument), the 24.5u ball, the throttle /
  g tape gauges (flat-topped fill, numerals 0.78 em), node panel.
  Round-3 changes: the crew g-dose is a labelled line across the gauge panel ("G DOSE", bar, share of the fatal
  limit; amber, red from two thirds), shown only while a dose exists; the heat-shield row of the entry panel shows
  while heating or below the redline (not under chutes); the "Δv … total" header is hidden while nothing left can
  burn (only chutes / separations); the launch panel says "No target · pick a body for its launch window" while
  no target is set; a suborbital periapsis (no time to it) takes the time column too; arrow-key caps keep their
  glyph, enlarged; every visible text is at least 10 px at 720p and fits its box (asserted). Navball instrument:
  label ink is gone just before the lip (no numeral cut in half by the bezel), and a marker whose centre passes
  under the lip fades out within a few degrees (no icon slivers at the window's edge).
  Round-5 changes (supersede the above where they differ): two materials - the flight readouts of the left column
  and the altimeter are panes of the MFD's black glass (header strip with the title as the active tab: accent text
  over an accent underline; a status edge on the left in the colour of the panel's state: the clock amber while
  warp is capped, the orbit amber / red with its periapsis, the recovery zone green inside / amber outside, the
  entry amber while heating and red past a redline), and the bottom cluster (SAS panel, gauges) is housed in the
  navball bezel's gunmetal with black-glass windows for the speed and the pitch / heading / roll chips; resources
  and the stage list keep the plain plate. The **active stage tile is titled with what burns**
  (`stageBurnLabel`: the stage group of the engines its stage ignited, "Meridian M-3", "Heron descent stage"), with
  an engine icon and the event in its tooltip ("Burning since stage 4: M-2 separation"); a long name sends the
  ACTIVE tag to a line of its own. The locked next tile reads "LOCKED staging interlock". The recovery-zone light
  follows `zoneStatus` (an impact prediction, or the sub-point landed / under chutes; nothing in orbit and nothing
  for an entry-interface prediction, whose row is now named "Entry interface"). The crew g-dose line holds its
  place (a dim "0 %") wherever a dose can build up (in an atmosphere, or above 0.5 g), so the tubes never move when
  the first dose appears (asserted: the g tube's box is the same in `reentry` and `entry-highg`). A suborbital
  periapsis puts both apsis rows in the wide form (time after the label, values at the panel's edge). Resources:
  the group's name and share on one line with its bar under them (a long group name reads in full), the full
  groups listed while they fit on about two lines, else counted ("FULL 5 stage groups", names in the tooltip).
  Mission failed: the flight panels dim to 30 % and take no pointer events (the clock stays), the banner names the
  cause and offers `HudOptions.failureActions` (the app shell's next steps; without any it says the flight
  controls are off). Warp step buttons are drawn chevrons. Navball: the texture comes in two versions (painted ball
  / with lettering) and the shader shows the lettering **per label** (each label fades as a whole by where its
  farthest corner lies, so no glyph is ever cut by the lip or smeared into a blurred copy; lines run crisply under
  the lip); numerals 54 px and heading labels 56 / 68 px on the 1024-texel texture (caps of 9-11 px on the 720p
  ball, unit-tested against the 10 px type floor), numerals on the 20 / 40 / 60 deg lines of the four columns
  between the meridians; markers keep full strength until their centre reaches the lip and are gone about two
  degrees later.
  Round-6 changes (supersede the above where they differ): **the bottom cluster is one instrument** - a gunmetal
  housing (`.housing`) symmetric about the ball carries the SAS controls (six toggles in 3 x 2, the eight mode
  buttons with icons of about 18 px at 720p and no key digit: the key is in the tooltip and the key help) on the
  left and the tape gauges on the right; the ball's read-outs are black-glass windows set into the instrument:
  speed (mode word + value, click toggles the navball mode) and heading in one window on the bezel's top arc,
  pitch at 9 o'clock and roll at 3 o'clock (`.prw`, two-line, over the bezel's rim); the maneuver readout is a
  glass pane standing on the housing right of the ball (title row "MANEUVER" + the countdown to the burn, then
  delta-v and burn time). The cluster tops out at about 29 % of the frame height (was 34 %). The g-dose line is
  always there (dim "0 %" without a dose), so the tubes never move between flight phases (asserted on pad, ascent,
  low orbit, entry and the high-g entry). The right column is glass like the left: the stage list under a header
  strip ("STAGES" tab, total delta-v, or "2 left" / "all fired" when nothing can burn), resources with a tab title.
  The landing-target panel names its target in the title row ("TARGET Tranquility Base", "RECOVERY South
  Pacific"). The **entry panel shows for an entry, not for an ascent's heating** (`isEntering`: heat flux above
  1 kW/m^2 while coming down, or rising unpowered on a path whose apoapsis stays inside the atmosphere; request
  app-integration-4), and in any phase once the skin passes 70 % of its limit or the shield its redline. The
  altimeter's vertical / horizontal speeds are in the navball's frame (`describeFlight`: in orbit mode the
  horizontal part of the orbital velocity, so the two add up to the ORBIT speed; the MFD landing page keeps the
  ground speed, `horizontalSpeedSurface`). Orbit rows: no time to periapsis and no period on a path that meets the
  surface, no time to apoapsis while coming down on it (`describeOrbit`). Stage tiles: an engine-less stage names
  its chutes ("separate · deploy drogues", "release drogues · deploy mains", `stageActionWords`); where local
  gravity is below 0.5 m/s^2 (a translunar coast) the tile gives the full-throttle acceleration instead of a TWR
  (`thrustLabel` / `thrustValue`; MFD "Stage accel"). Key caps show the key's glyph (". , / - `" drawn large, the
  name in the tooltip). Target chips read "TARGET Moon". Mission failed: the panels are powered down (content
  dimmed and desaturated with `filter`, plates as opaque as ever: no scene prints through). Navball labels fade
  within about 0.012 R (one pixel at 720p) just before the lip: a still shows a label whole or not at all.
- **HUD main-thread cost**: a changed text node costs a style / layout / paint / layerization pass (about 1 ms
  on this page), far more than the JavaScript formatting it. So the numeric readouts refresh at `HUD_TEXT_HZ`
  (10 Hz), all in one frame; the navball, the throttle and g gauges (composited transforms), every indicator
  light and every panel's visibility follow each frame; and any discrete change (a panel appearing, SAS or
  navball mode, warp level, altimeter source, a stage fired, a target set...) refreshes the text in that same
  frame, so a label and its number never disagree. Every box whose text changes is a relayout boundary
  (fixed height + `contain: size layout`), so a changed number lays out only its own line. The node pulse
  animates opacity (compositor), the warp chevrons are one SVG (no clip-path per chevron).
- **The HUD renders the navball** in every `update` (the shared 512 texture always, the HUD canvas copy while it
  is on screen) on its own command encoder and submits it. The app must not render the navball separately; it
  publishes `navball.view` as `'ui.navball'`.
- **MFD**: `paint(ctx, w, h, page, snapshot, defs)` draws a full page (header tabs with MET, the page's own
  layout, a SAS / RCS / warp / UT footer). Every page fills the canvas and its instrument dominates: FLT is a
  primary flight display (ADI about 60 % of the page height, sky and ground graded radially around the zenith and
  nadir points so the disc is never one flat colour, zenith / nadir marks, a pitch ladder every 5 deg clipped to
  0.8 r that continues over the poles, a rung drawn only where the clip leaves most of it, numerals upright at
  both ends of every 10 deg line where they fit whole and none within 4 deg of the aircraft symbol, a fixed bank
  scale outside the disc at 10 / 20 / 30 / 45 / 60 deg with the sky pointer riding against it, the velocity
  vector from the prograde marker drawn over the aircraft symbol; speed and altitude tapes with pointer boxes
  holding the HUD's strings, scale numerals only where whole (clear of the tape ends and the box), the speed
  scale ending at zero (hatched below); a log vertical-speed scale with short ticks and the numerals after them;
  a heading tape with the boxed heading and no label cut at its ends; throttle / g / horizontal / vertical boxes); ORB draws the conic around the body in the body's own colour (from `render.meanColor`), true
  to scale when that keeps the orbit clear of the body and otherwise with the altitude exaggerated (caption
  "ALTITUDE EXAGGERATED ×13" for the 100 km lunar orbit) so Ap and Pe are apart, apsis diamonds labelled with
  their altitudes, the body with its night side and terminator from the sun direction, its name in the caption;
  landed, the page is one status line (body, "Landed · no orbit") over a large body graphic; SYS has the vehicle
  rows and the resources: up to six as full-height tank gauges side by side under their stage group's name
  (late in a mission), more as bars that fill the column; STG a summary strip of the active stage (the next engine stage
  before the first ignition) and the whole stack, active stage first (number, icon, name, delta-v / TWR / burn
  or what an engine-less stage does, propellant bar, lock state; tiles grow when few stages remain); ENT the
  entry rows, g / dose / ablator / skin-temperature bar gauges with scales, zones, redlines (10 g, the dose limit,
  30 % ablator, 85 % temperature) and readouts (the ablator gauge only when the vessel has one; it is a
  low-is-bad gauge, `GaugeSpec.lowIsBad`: the whole fill takes the colour of the zone its reading is in, green
  above the redline, so a nominal reading shows no red), and the landing-target rows; LND the landing rows and target rows beside a
  full-height scope. All sizes scale with the canvas height (designed for 1024 x 768) and no text is smaller
  than 3 % of it (12 px at 512 x 384; unit-tested on every page of every scene at both sizes, and photographed
  1 : 1 at 512 x 384). The entry and landing pages carry `landingTargetRows()` verbatim; the flight and landing
  pages take altitude, speeds, heading, pitch, roll, throttle and g from `describeFlight` (the HUD's strings;
  `MfdRow.icon` carries the vertical-speed trend). The landing scope (log-scaled rings 100 m .. 100 km, labels
  stacked along the vertical hair on the half away from the target) is **north-up at every speed**
  (`landingScope`): the target is placed from distance and bearing, which the readout gives at any speed, so a
  target 400 m from a hovering lander (down/cross-range both 0 below 0.1 m/s) is never drawn on the vessel, and
  nothing jumps or swings as a slow drift crosses the 0.1 m/s threshold. While there is a ground track it is
  drawn as a dashed line at the compass direction recovered from the readout's own down/cross-range
  (T = bearing - atan2(cross, down)), so the line agrees with the "ahead / right" rows; caption
  "NORTH UP · TRACK 218°" or "NORTH UP · NO GROUND TRACK". The ADI uses rollDeg positive = roll right
  (ARCHITECTURE sign). Round 5: STG reads bottom-up like the HUD's stack (later stages on top, the next stage,
  the active stage at the bottom, named for what burns) with the summary strip under it; the ORB body is shaded per
  pixel (cosine of the sun's incidence falling to a dim night level at a terminator softened over 1.5 % of R,
  5 % with an atmosphere, mild limb darkening under an atmosphere) from `bodyAlbedo` (the tile set's low-resolution
  albedo map: land, sea and cloud on the Earth, maria on the Moon), or the mean colour with a faint mottle fixed by
  the body's id; it is re-shaded only when the size, the view or the light changes by about 0.3 deg. The landing
  rows of ENT and LND end with the zone light as a row ("Zone INSIDE · r 1 800 km"); the ENT g-dose gauge reads
  in g·s; SYS splits a long stage-group name over two lines instead of squeezing it. Round 6: the ORB body's
  display gain is set from the mean of the surface actually drawn (the albedo map with its clouds), so every body's
  day side reaches the same level; `MfdPainterOptions.bodyClouds(bodyId)` (a cloud cover map, red channel, e.g. the
  tile set's coverage map named by `render.clouds.coverageMap` reduced to about 1024 x 512) lays the clouds over the
  albedo map, and a body with an atmosphere gets the blue Rayleigh in-scatter of its `render.atmosphere`
  (single scattering from its optical depth, stronger toward the limb). STG rows are at most 11.5 % of the page
  tall, standing on the summary strip under a "STACK · n STAGES LEFT" heading. Raw "none" values are gone: "—",
  "no gear", "no shield", "vertical" (ground track while moving straight up or down).

## 2. How the app wires it (ARCHITECTURE section 5)

```ts
const input = createInputSystem(canvas);                       // windowed and uncaptured until the player asks
const navball = createNavballRenderer(gpu, { perf });           // resources.publish('ui.navball', navball.view)
const hud = createHud({ defs, gpu, navball, dispatch: (a) => input.trigger(a),
  requestKeyboardCapture: () => void input.requestKeyboardCapture(), releaseKeyboardCapture: () => input.releaseKeyboardCapture(),
  showCaptureControl: settings.capturePill, keyHelp: keyHelpEntries(input.bindings), keyFor, commands: () => sim.commands });
hud.mount(document.getElementById('ui-root')!); hud.setKeyboardLocked(input.keyboardLocked, input.fullscreen);
input.onKeyboardLockChange((l, fs) => hud.setKeyboardLocked(l, fs));
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

Through the machine-load gate (docs/PACKAGE_RULES.md, "Machine load"):

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck:paths -- src/input src/camera src/ui labs/flight-ui tests/browser/flight-ui tests/unit/flight-ui
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/input src/camera src/ui tests/unit/flight-ui tools/dev/boundaries.test.ts   # 85 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/flight-ui --project=functional                               # 65 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/flight-ui --project=perf                                     # under the GPU lock
```

Lab: `/labs/flight-ui/?scene=<FakeScene>` with `view=chase|cockpit|map`, `capture=1`, `extraRig=1`,
`node=1`, `target=moon`, `predicted=impact|entry`, `targetOffset=<m>,<bearingDeg>`, `failed=1`,
`terrainPending=1`, `lockout=1`, `guard=1`, `mfd=1` (the six MFD pages), `mfd=native` (the pages at 512 x 384,
shown 1 : 1), `help=1`, `ballast=<iterations>` (perf: GPU ballast), `orbit=<yawDeg>,<pitchDeg>,<distance>`,
`flight=<throttle>,<gLoad>` (a powered flight: throttle, thrust and g in the readouts), `backdrop=bright` (the
HUD-legibility worst case: a near-white cloud deck / regolith and a pale sky), `attitude=<yaw>,<pitch>,<roll>`
(the vessel turned by this offset in its own frame, degrees: markers off the nose and a real roll), `dose=<g s>`
(the crew g-dose), `lift=<bankDeg>` (a capsule lift-vector marker 30 deg off the nose), `still=<url>` (also
`cabin=`: a still of the real renderer - the integration package's flight views, the cockpit package's seat
view - shown in place of the backdrop), `met=<s>` (the mission time to show, to match a still),
`predicted=impact|entry|none`, and (round 6) the integration lab's own flight-state parameters so a still of the
real renderer is shown with the state it was rendered in: `start=<m>` (ascent / chutes start altitude; the clock
moves along the FakeSim's climb with it), `hover=<m>` (the lander's feet that high, flying on the descent
engine), `throttle=<0..1>` (lever held from the start), `stage=<n>` (stages fired in place of the scene's own;
`scene=pad&stage=1&throttle=1` is the lift-off), `ground=<m>` (the ground or sea under the vessel), plus
`sas=<mode>` (SAS mode held from the start). Round 6 lab state (`flightState.ts`): the vessel's mass and every stage
figure (delta-v at vacuum Isp, TWR at local gravity, burn time, propellant) are computed from the lab parts it
carries, as the sim's `stagingInfo` does (the lander's engines resized so its numbers are plausible: descent 82 kN,
ascent 30 kN); the surface scenes stand on the lab ground through the FakeSim's `ground` option (radar altitude 0
when landed); the entry views are moments of one integrated ballistic entry (entry interface 120 km, 7.4 km/s,
-3 deg, beta 400 kg/m^2: 0.68 g at 67.9 km / 7.37 km/s / -3.9 deg, 11.2 g 50 s later at 42.6 km / 5.16 km/s; peak
12.3 g; the impact where the trajectory ends) with the osculating conic of that state (Pe below the surface);
translunar is a 190 km x 380 000 km ellipse (climbing at 1.45 km/s); chutes has both chute stages fired (the
mains: 8 m/s at 1 g, no chute envelope left); Mach from the US-76 speed of sound. Round 5: every scene carries one coherent flight state (`SETUP` in main.ts): a
mission clock that runs (ascent T+ 00:01:10, low orbit 00:52, translunar 1d 02:21, lunar orbit 3d 04:25, landed
4d 06:12, entry 8d 02:41, chutes 8d 02:52; the pad stays at 0 until the first stage fires; UT = launch + MET), a
powered climb in the ascent (throttle 0.86, g from the active stage's TWR), an entry whose dynamic pressure,
height (exponential atmosphere), stagnation heating (Sutton-Graves) and sink rate (1.3 deg flight-path angle)
follow from its g load through a ballistic coefficient of 400 kg/m^2, 1 g under the mains, the lander's gear down
once the gear stage has fired (no gear on the capsule alone), and predictions only where the vessel comes down
(entry: the recovery zone 1 450 km ahead, the impact 1 425 km down-track; chutes: the impact under the vessel),
every point placed on the sphere along the FakeSim's ground track and every miss measured from the target. The lab
vehicle is the mission stack in six stage groups with the mission's ten stages and their engine ignitions. The
lab replaces the
FakeSim's generic stage numbers with the mission vehicle's stage table (icons and action kinds of
meridian-lunar.json, engine stages with plausible delta-v / TWR / burn, gear / chute / jettison stages without
engines), reported the way the sim reports them: the fired stage that owns the running engines keeps live
numbers (the active stage), other fired stages none, the total includes the active stage. The lab adds a test vehicle (`labs/flight-ui/labVehicle.ts`: four stage
groups, resources, a command part with the mouldline seats) to the loaded library and tags FakeSim snapshots
with it; `predicted`, `targetOffset`, `failed`, `terrainPending`, `lockout` are lab decorations of the snapshot
(the FakeSim produces none of them; `targetOffset` follows the readout rule, down/cross-range 0 without a
ground track, track due north otherwise). The backdrop (`backdrop.ts`) is a lab-only ray
tracer for judging cameras and HUD legibility; it is not shipped.

Screenshots (all reviewed by eye): `out/screens/flight-ui/<scene>-720p.png` and `<scene>-4k.png` for all eight
FakeSim scenes, plus `cockpit-lowOrbit`, `map-lowOrbit`, `keyhelp`, `failed`, `terrain-pending`, `mfd-pages`,
`mfd-pages-hover` (landed 400 m from the target: no ground track) (all at both sizes),
`attitude-lowOrbit` (markers off the nose, 25 deg roll against the sky pointer), `entry-highg` (11.2 g in the red
zone, the g-dose line, the lift-vector marker), `retrograde-hold` (retrograde on the nose under chutes),
`cockpit-cabin-lowOrbit` (the interior layout over the cockpit package's seat-view render
`out/screens/cockpit/perf-1440p-leo-seat.png`; skipped with a message when that file is absent) (all at both
sizes), `bright-<pad|ascent|reentry|lunarSurface>-720p` (near-white backdrop: label contrast, plate
uniformity and the coverage budget asserted), `mfd-pages-native` and `mfd-pages-native-reentry` (512 x 384 at
1 : 1), `real-<ascent|lowOrbit|lunarSurface|reentry>-720p/4k` (the HUD over stills of the real renderer,
`out/screens/integration/budget-*.png`; skipped with a message when a still is absent; coverage and the text
floor asserted), `prograde-hold`, `warp-refused`, `extra-rig`, `stage-lockout`. The 720p scene tests log and assert the
HUD's coverage of the frame (<= 20 %) and that no visible HUD text is smaller than 10 px or wider than its box;
a stage-stack test checks the active stage's tile against the snapshot.

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
| Period / comma / slash change warp; refusal shows a notification | met ("Cannot warp faster here" toast at the physics-warp cap; one refused press = one toast without a count, a second press reads "×2") |
| Clicking SAS buttons, toggles, the stage tile (and the speed readout) works | met; lockout blocks the tile |
| Blur releases all keys | met |
| captureKeyboard: a real click leaves `keyboardLocked` a boolean, no error | met (either answer accepted; the HUD's switch shows the state granted). Round 6: capture is opt-in (user feedback): with no option nothing asks; a click on the switch asks, a second click or Esc leaves |
| PointerState edges and doubleClick exactly once | met (click: 1 / 1 / 0; double click: 2 / 2 / 1) |
| Navball: zenith at the reticle for nose-up; heading 090 wings level horizontal horizon with sky on top; roll right raises the horizon's right end by tan(roll) | met on the CPU reference (unit) and on the GPU texture (readback spec) |
| Marker positions match an independent projection within 1 px | met: < 1e-6 px over 2,000 random directions (`navball.test.ts`) |
| Camera: no jump above 1 cm / 0.1 deg between consecutive frames of a blend, incl. a vessel at 7.8 km/s | met (6 switch cases), read as: every frame's step is at most the blend's own smooth motion over that frame + 1 cm (turn: + 0.1 deg). The smooth motion is bounded analytically from the two endpoints (log-polar path, slerped orientation, weight k(t)), so near both ends, where k barely moves, any step beyond 1 cm / 0.1 deg fails; mid-blend a 0.6 s move from 2 m to 95 m necessarily moves metres per frame, so a literal per-frame 1 cm bound cannot hold there. A 2 cm jump injected at frame 2 or 50 of the blend is caught |
| Chase respects a fake terrain; cockpit eye at the seat; map 100 km .. 2e9 m in float64; focus request smooth; unknown-mode external rig through manager, HUD and listener | met (vitest + "M and C" browser spec) |
| Landing-target panel shows the lunar scenes' numbers and equals the MFD landing page strings | met (DOM rows == `buildMfdPage('landing')` rows, distance and bearing checked against the readout); the MFD's flight data (altitude source, vertical speed, heading) and Ap / Pe come from the same models as the HUD (unit tests) |
| Landing scope never shows "on target" while hovering away from it | met: a hovering vessel 400 m from the target draws it 400 m out at its bearing (unit test on the painted canvas calls); the target does not move when the drift crosses 0.1 m/s; the track line matches the down/cross-range rows |
| Text fields and DOM panels over the scene (request map-view-1) | met: typing digits / Backspace / Space / Enter edits the field and fires nothing; clicks and wheel over the panel come with `overUi` |
| Screenshots of every scene at 720p and 4K reviewed by eye | done (section 3) |
| HUD update < 0.5 ms per frame average | met: **round 5: 0.11 ms** (low orbit with a node) and **0.09 ms** (powered ascent); round 3: 0.10 ms (low orbit with a node) and **0.16 ms** (powered ascent); round 2: 0.12 / 0.13 ms; round 1: **whole main-thread cost 0.14 ms per frame** (low orbit with a node) and **0.12 ms** (powered ascent, every readout moving) after the round-1 visual rework (wave 1: 0.09 / 0.11 ms): CDP main-thread task time, HUD visible minus hidden (F2) over 5 + 5 alternating windows of 240 frames, plus the hidden HUD's own update; includes style, layout, paint and the navball encode + submit; 2560 x 1440. JavaScript inside `update()` alone: 0.06 ms mean. Without the GPU ballast (previous runs, busier machine): 0.16 / 0.19 ms and 0.25 / 0.30 ms. Before the fix the same method read 0.6-0.7 ms (text written every frame) |
| Navball < 0.05 ms GPU (17.1), p99 | met: **round 5: 0.0094 ms p50, 0.0112 ms p99** (two ball textures, per-label lettering), HUD canvas 0.0017 / 0.0022 ms; round 3: 0.0062 ms p50, 0.0081 ms p99 (512 texture), HUD canvas 0.0016 / 0.0023 ms; round 2: 0.0081 / 0.0095 ms, HUD canvas 0.0019 / 0.0025 ms; round 1: **0.0080 ms p50, 0.0092 ms p99** for the 512 texture after the round-1 rework (wave 1: 0.0065 / 0.008 ms; 2,698 frames per scene, both scenes), HUD instrument canvas 0.0024 / 0.0028 ms, measured with a 7 ms GPU ballast per frame as in the game (`labs/flight-ui/ballast.ts`, the method of docs/handoff/render-core.md 4.1). With an otherwise idle GPU the card drops its clocks and the same pass reads p50 0.014-0.016 ms and p99 0.025-0.077 ms from run to run (logged by the spec, not asserted) |
| expectNoErrors on every spec | yes (window errors, GPU errors and console warnings) |

Timings were taken under the GPU lock and through the heavy-job gate while the Earth bake and other agents' work
were loading the machine (wave 1): provisional, to be re-measured by the lead.

## 5. Known limits (stated plainly)

- `InputFrame.pressed` is a set: two presses of the same key inside one frame (under ~16 ms) count once. Pointer
  edges are queued across frames; key presses are not, because the contract has no count.
- The HUD's numeric text refreshes at 10 Hz (`HUD_TEXT_HZ`), not every frame (the main-thread budget; see
  section 1). Gauges, lights, panel visibility and the navball follow every frame, and discrete changes refresh
  the text at once, so the only visible effect is digits stepping at 10 Hz.
- The landing scope's ground-track line is recovered from the readout's down-range / cross-range, so it is not
  drawn within 1 m of the target (those numbers carry no direction there), and for targets thousands of km
  away its direction carries the spherical error of a flat recovery (the target then sits on the rim anyway).
- Wheel steps take `overUi` from the last pointer event: a wheel over an overlay with no pointer movement onto
  it since the last pointer event (practically impossible with a mouse) would be attributed to the old target.
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

Requests filed: `flight-ui-1` (Vite's cold dependency scan walked `data/` and held the first page load of every
Playwright run for minutes) - resolved by the lead in fa1c31b; the warm-up workaround and the raised timeouts
are gone again (the perf spec keeps 25 minutes because `withGpuLock` itself may wait up to 20 minutes).

Requests against flight-ui paths: `map-view-1` (text fields of the map's node panel, overUi over any DOM
element) - resolved here: editable targets reach no binding and are not `preventDefault`ed, and `overUi` is
true over every element other than the canvas (section 1); browser spec "a text field over the scene ..." types
"25" + Backspace + Space + Enter into a field over the canvas and clicks / wheels over the panel without any
action, SAS or staging change. No other open request targets flight-ui paths. Notes for the lead:

1. `createHud` takes an options object (the brief wrote `createHud(): Hud`): it needs the GPU handle, the navball
   renderer and the dispatch / capture callbacks, and `src/ui` may not import `src/input`, so the binding table
   arrives as data (`keyHelp`, `keyFor`).
2. Consider documenting in `ui.ts` that `'ui.navball'` holds sRGB-encoded, premultiplied colour (what this
   implementation writes into the `rgba8unorm` texture).
3. `sim-orbits-2` (FakeSim roll sign) affects how the FakeSim looks in this lab; nothing in flight-ui needs to
   change when it is fixed.

## Changes by the lead between the waves (2026-11-10)

- `sim-orbits-2` resolved: FakeSim's `rollDeg` now has the ARCHITECTURE / real-sim sign (positive = dorsal
  toward starboard) and its heading on the pad is that of the ventral side, so the MFD ADI is no longer
  mirrored in the lab (section 5, "FakeSim's rollDeg has the opposite sign", no longer applies).
- `audio-1`: `buildAudioListener` (`src/camera/listener.ts`) fills the new `AudioListener.attachedVesselId`:
  `camera.focusVesselId` for a `kind: 'external'` camera, null for the cockpit and the map.
- Note 2 of section 6: `NavballRenderer.view` is documented as sRGB-encoded, premultiplied colour.

Full list: `docs/handoff/lead-baseline.md`.

## Visual close-out, round 1

Work list: `out/qa/wave2/flight-ui.md` (19 items, round 0: photo 5.5, artifact 6.5). References used:
`out/qa/ref/cockpit-interiors/apollo11-columbia-panel.jpg` (FDAI: strongly shaded ball, black recess, roll
index ring, glass reflections), `soyuz-ms20-descent-module.jpg` and `dragon-seats.jpg` (display pages that fill
the glass). Every item below was changed at its cause, re-shot and looked at (720p and 4K, crops enlarged).

| # | Item | What was done | Screenshot |
|---|---|---|---|
| 1 | G tube red at every reading | Tape gauges rebuilt: the colour layer is fixed to the scale (g: green to 6 g, amber to the 10 g limit, red above, from the sim's g-dose thresholds, `G_SCALE`) and only revealed by the fill (window translated by 1 - f, layer counter-translated: two composited transforms); numerals 0/4/8/12 g and 0/50/100 %, ticks, a red 10 g limit mark, rounded fill top with a meniscus line; the faint zone track shows where the bands lie. One shared threshold set for the HUD and both MFD pages (`gTone`). Lab decoration `flight=<thr>,<g>` photographs a powered ascent | `ascent-720p/4k` (86 %, 2.35 g all green), `reentry-*` (4.50 g green), `pad-*` (1.00 g) |
| 2 | Pole-on dartboard, zenith hidden | Texture: numerals only between meridians at 45/135/225/315 deg, +-20..60 on four columns, +-70 on two, none at +-10 / +-80; meridians and ladder stop at a bold 80 deg pole ring with four inward ticks plus a cap from 87.5 deg, larger than the reticle hub, so the ring frames the reticle pole-on; numeral size 40 (about 12 px at 720p) | `pad-*`, `chutes-*`, `lunarSurface-*` |
| 3 | Node pushes the cluster off centre | Bottom cluster is a `1fr auto 1fr` grid with the ball alone in the middle column; browser assertion: ball centre = viewport centre within 1 px with and without `node=1`, flight and map views | `lowOrbit-*`, `map-lowOrbit-*` |
| 4 | See-through panels, label contrast | Plates 86 % opaque (gradient, light hairline, dark outer ring, lit top edge), `--label` #aebccf; lab `backdrop=bright` (near-white cloud deck / regolith, pale sky); the spec measures every visible label against its plate on the screenshot and asserts >= 4.5 : 1 | `bright-pad/ascent/reentry/lunarSurface-720p` |
| 5 | Zero vertical speed as a solid square | `formatVerticalSpeed` is a signed number; the direction is an SVG chevron / level bar (HUD) and a Path2D icon (MFD), coloured by trend | all scenes (altitude panel), `mfd-pages-*` |
| 6 | "Sea level" on the Moon | `altitudeDatumName`: "sea level" only on a body with an ocean, "datum" elsewhere; title, tooltip and click cycle follow | `lunarOrbit-*`, `lunarSurface-*`, `terrain-pending-*` |
| 7 | Stage names cut, badge over icon, icon twice | Tile = number column, icon plate, the name on its own line with only the action icons that differ from the stage icon, then key cap / delta-v / TWR / burn, and a thin propellant strip; compact rows are number, icon, name, delta-v; right column 38u; the lab uses the mission vehicle's stage table (engine-less gear / chute / jettison stages); assertion: no stage name or meta line truncated, number and icon inside their tile | `pad-*`, `ascent-*`, `lowOrbit-*` |
| 8 | Locked stage looks armed | Amber hatched tile, amber padlock plate in place of the stage icon, "LOCKED after last stage" at label size | `stage-lockout` |
| 9 | Ball not a lit sphere, flat bezel | HUD instrument look in the shader: wrap-diffuse key light (dark terminator side), limb darkening to 0.4, contact shadow at the bezel, a curved window reflection on the varnish (annular sector with crisp edges and a frame bar), faint Fresnel rim, the broad gloss lobe removed; machined bezel (static 2-D canvas): recessed black gap, top-lit outer and inner chamfers, roll index ticks at 10/20/30/45/60 and every 30 deg, orange top index; the shared texture keeps soft shading only (the cockpit relights it) | `lowOrbit-4k`, `pad-4k`, `reentry-4k` |
| 10 | MFD pages are tables | Purpose-built layouts: FLT primary flight display (ADI about 60 % of the height, ladder every 5 deg with numerals at both ends and none near the aircraft symbol, fixed bank scale with the sky pointer against it, velocity vector, speed / altitude tapes, log VSI, heading tape, read-out boxes); ORB conic in the body's colour with exaggerated altitude for low orbits (Ap / Pe apart, labelled), "—" while landed; SYS large resource bars; STG summary strip + full stack; ENT bar gauges with scales, zones, redlines, readouts (ablator gauge only with an ablator) | `mfd-pages-*`, `mfd-pages-hover-*`, `mfd-pages-native*` |
| 11 | Context-blind panels | `orbitPhase`: Pe amber + "suborbital" under power / in the atmosphere, red only for a coasting impact; orbit panel hidden while falling through the atmosphere on a suborbital path; landing rows without data collapse to one "Track · arrival: none" row; atmosphere rows fold into the entry panel (four plates on the left edge in entry, was five) | `ascent-*`, `chutes-*`, `reentry-*`, `pad-*` |
| 12 | Reticle under the markers | Reticle drawn last with an open centre ring and a thin outline (marker visible through it); unit test, comments and this note updated | `prograde-hold`, `lowOrbit-4k`, `pad-4k` |
| 13 | Labels collide on the horizon band | Every label drawn over a halo of the local background (no line through a glyph); numeral columns 15 deg from any heading label; +-10 numerals dropped | `lowOrbit-*`, `reentry-*` |
| 14 | SAS key digits on their icons | Asymmetric padding reserves the top-left corner; digit 0.68em | every external view |
| 15 | Markers spill over the edge, lumpy target | Marker fragments clipped to the ball's silhouette (same edge as the ball); target icon = ring + centre dot + four separate diagonal ticks; atlas 2048 x 512 with 256 px cells | `pad-4k`, `stage-lockout` |
| 16 | INSIDE ZONE smallest text | Zone status row at value size with a light: green INSIDE ZONE / amber OUTSIDE ZONE (once committed), with the radius | `chutes-*`, `reentry-*` |
| 17 | MFD small text, scope wastes space | Text floor 3 % of the page height on every page (unit test paints every page of every scene at 1024 x 768 and 512 x 384 and checks every font size), full-height scope, ring labels stacked along the vertical hair away from the target; 1 : 1 512 x 384 sheet photographed | `mfd-pages-native*`, `mfd-pages-hover-*` |
| 18 | Help sheet ghosting, punctuation caps | Opaque sheet; flight panels hidden while it is open; punctuation caps show ". >", ", <", "` ~" etc. at a larger glyph size | `keyhelp-*` |
| 19 | Tubes staggered | Both gauges on one grid (shared value, tube, dose-slot and caption rows); the dose bar keeps its slot (visibility) | every external view |

Not fixed / limits, plainly:
- The MFD ADI is drawn in Canvas 2D; it is not painted from the navball texture (the painter contract is a 2-D
  context without GPU access), so cockpit and HUD show two different instruments with the same data.
- At 720p the ball is about 194 px wide: numerals near the limb are foreshortened by the sphere itself and stay
  small there (as on a real FDAI / KSP navball); the ones near the centre are about 12 px.
- Pole-on, the numeral columns above the reticle read upside down: the texture is fixed to the horizon frame,
  as on every attitude ball.
- The lab's stage numbers (delta-v, TWR, burn) are plausible lab data, not the sim's (FakeSim limitation).
- Pre-existing out-of-path typecheck errors in `src/render/cockpit` (sunmap work of the cockpit package) are
  not flight-ui's.

Requests filed: none (everything was inside flight-ui paths). Open request naming a flight-ui path:
`map-view-4` (shared UI tokens; owner paths a new `src/core` module, maintained by core-support, and
`src/ui/hud/hudStyles.ts`). The HUD side is a one-line change once the core module exists: build the `.hud`
CSS variables from its constants. Until then note that round 1 changed the HUD tokens the map copies:
`--bg` rgba(17, 24, 34, 0.86) (top of the plate gradient rgba(22, 30, 42, 0.87)), `--bg-strong`
rgba(12, 17, 25, 0.94), `--line` rgba(170, 198, 235, 0.26), `--label` #aebccf, `--dim` #8492a7, `--warning`
#ff6a6a (font stack, `--text`, `--accent`, `--good`, `--caution` unchanged).

Perf (measured 2026-11-11 under the machine-wide GPU lock through the gate, other agents' jobs running;
2560 x 1440; method of section 4): HUD whole main-thread cost **0.14 ms** per frame (low orbit with a node)
and **0.12 ms** (powered ascent, every readout moving), JavaScript inside `update()` 0.06 / 0.07 ms; navball
512 texture **p50 0.0080 ms, p99 0.0092 ms** with the 7 ms GPU ballast (idle GPU, for the record: p99 0.044 /
0.057 ms), HUD instrument canvas p50 0.0024 ms, p99 0.0028 ms. Budgets: HUD < 0.5 ms, navball < 0.05 ms p99
(ARCHITECTURE 17.1): met. The bezel is a static 2-D canvas (redrawn only on resize) and the gauges move by two
composited transforms, so the new look adds no per-frame paint.

Verification: typecheck of the package paths OK; `npx vitest run src/input src/camera src/ui tests/unit/flight-ui
tools/dev/boundaries.test.ts` 75 passed; `playwright --project=functional` 56 passed (screens of every view
re-shot; new assertions: ball centred within 1 px with and without a node in flight and map views, no stage
name or meta line cut and number / icon inside their tile, label contrast >= 4.5 : 1 over the near-white
backdrop); `--project=perf` passed.

Own estimate after this round (honest, from the screenshots against the references): photo lens about 7.5,
artifact lens about 8. What still holds the photo lens back: the HUD is clean and readable but not yet
distinctive (flat type, no per-panel art direction), and the MFD ADI is a 2-D drawing rather than the same
ball as the HUD.

## Changes in wave 2 (core-support)

- **Shared interface theme** (request `map-view-4`). The HUD's font stack and palette live in
  `src/core/ui/theme.ts` (`UI_FONT_FAMILY`, `UI_COLORS`: text, label, dim, accent, good, caution, warning,
  line, panel, panelStrong; constants only, no DOM). `src/ui/hud/hudStyles.ts` builds its CSS variables
  (`--text`, `--label`, `--dim`, `--accent`, `--good`, `--caution`, `--warning`, `--line`, `--bg`,
  `--bg-strong`) and its `font-family` from them; the generated stylesheet is byte-identical to the one
  before the change. The map view (`src/map`, which may not import `src/ui`) reads the same module.
  Test: `tests/unit/flight-ui/theme.test.ts`.
- **Plate opacity** (request `flight-ui-2`). `UI_COLORS.panel` is `rgba(17, 24, 34, 0.97)` (was 0.86) and
  `UI_COLORS.panelStrong` `rgba(12, 17, 25, 0.985)` (was 0.94): a white-to-black edge of the scene behind
  a plate leaves a step of 8 levels at most. `--bg` and `--bg-strong` follow; `--bg-top` is the HUD's own.

## Visual close-out, round 2

Work lists: `out/qa/wave2/flight-ui.r1.photo.json` and `out/qa/wave2/flight-ui.r1.artifact.json` (round 1:
photo 6.8, artifact 7). References used: `out/qa/ref/cockpit-interiors/apollo11-columbia-panel.jpg` (FDAI: case
mask over the ball rim, soft glass reflections, bank pointer against the index ring),
`soyuz-ms20-descent-module.jpg` (display pages that fill the glass). Every item was changed at its cause,
re-shot at 720p and 4K and looked at (crops enlarged: ball, bezel side, gauges, MFD flight page).

| Item (critic) | What was done | Screenshot |
|---|---|---|
| Plates see-through: a horizon prints a tone step through text rows (both, previous item 4) | Request `flight-ui-2` (resolved by core-support, 3416a9c): panel tokens 0.97 / 0.985 alpha; the HUD's top gradient 0.975. The bright-backdrop spec now samples every visible plate's padding column below its lit top and asserts a spread of at most 8 levels (passes over the sunlit regolith / black sky horizon and the cloud deck) | `bright-lunarSurface-720p`, `bright-pad-720p`, `pad-4k` |
| HUD a wall of cards, 30-37 % of the frame (photo, major) | Rebuilt for a fifth of the frame, asserted (<= 20 % in every external scene, from the layout: plates, tiles, chips, the bezel disc; measured **15.4-19.6 %** at 720p, was 30-37 %): base type 1.85u, columns 26u / 26.5u; stage stack = one list of one-line rows for the later stages, full tiles only for the next and the active stage; resources = one bar per group in use, full groups folded into one "FULL ..." line ("ALL FULL" on the pad); landing target / recovery zone one line (name, distance · bearing) until a prediction, heating or a descent; orbit panel hidden while heating, inclination and period hidden while the path meets the surface; atmosphere rows a three-cell strip under the orbit rows (ascent) or in the entry panel; clock without a title row; chip row (pitch, heading, roll) above the ball; ball 24.5u (was 32u); tape gauges 9.5u; the next tile has no propellant strip (an unfired stage is always full) | every `<scene>-720p/4k`, `bright-*` |
| The burning stage has no tile (photo, major) | `describeStages().active` (the fired stage the sim still reports numbers for, as `stagingInfo` fills only the owner of the running engines): a green ACTIVE tile at the bottom of the stack with live delta-v, TWR, burn time and the propellant strip; the MFD STG strip and stack lead with it ("Active Δv / TWR / burn"); the lab reports stages as the sim does and its total includes the active stage. Spec: the ascent and lunar-orbit active tiles match the snapshot's StageInfo and the MFD rows | `ascent-*`, `lowOrbit-*`, `lunarOrbit-*`, `mfd-pages-*` |
| ABLATOR gauge red at a nominal 80 % (both, major) | `GaugeSpec.lowIsBad`: the whole fill takes the colour of the zone of its reading (green above the 30 % redline, red only below), the low zone stays a faint track tint and the red line; `ablatorTone` / `ABLATOR_REDLINE` shared: the HUD's heat-shield bar is green (red below 30 %), the resource bar green, the MFD green. Unit test: at 0.8 and 0.31 no fill is warning red, at 0.2 it is | `mfd-pages-native-reentry`, `reentry-*` |
| Window reflection washes out numerals, reads as a sticker (both) | Strength 0.17 (was 0.5) with soft graded edges, in the outer band just inside the lip, centred at 113 deg (off the 135 deg numeral diagonal), no frame bar | `pad-4k`, `retrograde-hold-4k`, `attitude-lowOrbit-4k` |
| Bank scale without a pointer (photo) | Sky pointer in the ball shader: a white triangle with a dark edge on the rim toward the projected zenith, reading against the bezel's roll scale; fades out near nose-vertical. New view with 25 deg roll | `attitude-lowOrbit-720p/4k`, `entry-highg-*` |
| Reticle hides a marker on the nose (both) | New reticle: thin wings with downward stubs and a centre dot, nothing but the dot within 12 icon units (marker rays end at 10.5), so prograde (ring, dot, three rays) and retrograde (ring, cross, three rays) read whole; no stem over the heading labels | `lowOrbit-*`, `retrograde-hold-*`, `prograde-hold` |
| "no engines" lines (photo) | Gone: later stages are one line (name; delta-v only for engine stages); an engine-less next stage says what firing it does (`stageActionText`: "separate · deploy chute"), also on the MFD; spec asserts no "no engines" | `reentry-*`, `chutes-*`, `mfd-pages-*` |
| MFD ADI pole-on: flat disc, half ladder, no zenith (both) | Sky / ground graded radially around the zenith / nadir points; ladder continues over the pole; zenith (ring with spokes) and nadir (ring with cross) marks; numerals upright at any roll; velocity marker over the aircraft symbol; speed tape ends at 0 (hatched below) | `mfd-pages-hover-*` |
| MFD FLT clipped text (artifact) | Tape numerals only where whole (clear of both ends and the pointer box); V/S ticks short with the numerals after them (VSI wider); heading labels not cut at the tape ends; ladder rungs skipped where the clip would leave a sliver | `mfd-pages-*`, `mfd-pages-native*` |
| ORB body a labelled shaded ball (photo) | The body drawn down the orbit normal with its night side and the terminator from the body's sun direction (`BodySnapshot.sunDir`; the projected terminator is the half-ellipse u = -s_z sqrt(R^2 - v^2)), limb darkening, a lit-side atmosphere rim; the name moved to the caption. No land / maria mask: engine code may not carry per-body coastline tables (rule 7) and the painter has no asset access | `mfd-pages-*`, `mfd-pages-native-reentry` |
| MFD blank areas (artifact) | ORB landed: one status line (two boxes) over a large body graphic; SYS bars take the column height; STG tiles grow when few stages remain (two stages take two thirds) | `mfd-pages-hover-*`, `mfd-pages-native-reentry` |
| Pole-on limb debris on the HUD ball (artifact) | Bezel lip covers the outer 6 % of the ball (`HUD_BALL_LIP`, window to 70 deg off the nose); label ink fades into the paint toward the lip and is darkened less than the background on the shaded side | `pad-4k`, `retrograde-hold-4k` |
| Bezel shadow cut by its canvas (artifact) | The bezel canvas is 1.28 x the ball box; the shadow is a radial falloff that reaches zero inside it | `lowOrbit-4k` (crop of the bezel side) |
| G tube low readings, small numerals (both) | Square-ish tube ends, flat fill top with a thin light line, numerals and captions 0.78 em (10.4 px at 720p), the top numeral clear of the value row | `pad-4k`, `lunarSurface-*`, `entry-highg-*` |
| Smallest glyphs (artifact) | Stage action icons removed from the tiles (the actions are words now); punctuation key caps named (Period, Comma, Slash, Backquote, Minus), brackets enlarged; zone radius and "suborbital" (now a title tag) at >= 10 px | `keyhelp-*`, `ascent-*`, `reentry-*` |
| PITCH / ROLL chips on the bezel, width jumps (artifact) | A chip row above the bezel: fixed-width PITCH and ROLL windows (sized for "−179.9°") and the heading over the top index; nothing touches the instrument | every external view, `bright-lunarSurface-720p` (−179.2°) |
| Key help columns unbalanced (photo) | Explicit three-column grid, groups assigned by `balanceColumns` (minimises the tallest column, keeps order inside a column, first group first): columns now end within two rows | `keyhelp-*` |
| Coverage gaps (photo) | New views: `attitude-lowOrbit` (lab `attitude=24,-14,25`: prograde, normal, maneuver, target off the nose, 25 deg roll), `entry-highg` (`flight=0,11.2&dose=6.4&lift=35&attitude=-8,10,-18`: g tube in its red zone, the g-dose bar, the lift-vector marker), `retrograde-hold` (retrograde on the nose) | as named, 720p and 4K |
| Also fixed on the way | Altitude panel at a fixed width with vertical and horizontal speed as icon cells (no wrapping); the chute-envelope light only while coming down through air (the real sim reports an envelope whenever a chute stage remains, which would have kept the entry panel up all mission); ground distances from 1,000 km without decimals ("6 127 km") | `lunarOrbit-720p`, `chutes-*` |

Not fixed, plainly:
- The HUD panels over an actual cabin in the cockpit view: this lab has no cabin renderer (the cabin is the
  cockpit package's); `cockpit-lowOrbit` still shows the interior layout over space. The interior layout is the
  clock, the landing-target line, the stage stack and the pill (5 % of the frame).
- The ORB page has no coastline / maria mask (see the table); it has the terminator.
- The MFD ADI is still a 2-D drawing, not the HUD ball (the painter contract is Canvas 2D).
- At the 20 % budget the ascent sits at 19.6 %: a new always-on panel needs a matching cut.

Requests: `flight-ui-2` (plate token alpha, `src/core/ui/theme.ts`) - resolved by core-support (3416a9c).
No open request names a flight-ui path.

Perf (2026-11-11, through the GPU gate under the machine-wide lock, other agents' jobs running; 2560 x 1440;
method of section 4): HUD whole main-thread cost **0.12 ms** per frame (low orbit with a node) and **0.13 ms**
(powered ascent), JavaScript inside `update()` 0.07 / 0.08 ms; navball 512 texture **p50 0.0081 ms, p99
0.0095 ms** with the 7 ms GPU ballast (idle GPU: p50 0.0072, p99 0.011 ms), HUD instrument canvas p50
0.0019 ms, p99 0.0025 ms. Budgets: HUD < 0.5 ms, navball < 0.05 ms p99 (ARCHITECTURE 17.1): met. The extra
shader work (coarse background sample, ink weighting, sky pointer) did not move the navball's time
measurably.

Verification: typecheck of the package paths OK; `npx vitest run src/input src/camera src/ui tests/unit/flight-ui
tools/dev/boundaries.test.ts` 83 passed; `playwright --project=functional` 63 passed (every screenshot re-shot;
new assertions: coverage <= 20 % in every external scene and over the bright backdrop, plate spread <= 8 levels,
the active stage's tile against the snapshot and the MFD, no "no engines", the collapsed landing-target line);
`--project=perf` passed.

Own estimate after this round (honest, from the screenshots against the references): photo lens about 8, artifact
lens about 8. The scene now owns the frame and the instrument reads as an instrument (case lip, bank pointer,
faint glass); what still holds the photo lens back is that the HUD is a clean flat UI rather than anything
photographic (by design), and the MFD body has a terminator but no surface detail.

## Visual close-out, round 3

Work list. The round-2 critic lists (`out/qa/wave2/flight-ui.r2.photo.json`, `.r2.artifact.json`) were never
written (round-2 score blank), so the newest critic lists are still round 1's, which round 2 worked through.
This round first re-checked every round-1 item on the current screenshots (720p and 4K, crops enlarged, next to
`out/qa/ref/cockpit-interiors/apollo11-columbia-panel.jpg` for the FDAI): all hold as round 2 describes (plates
one tone over the horizon, coverage 15.3-19.6 %, active-stage tile, ablator gauge green at 80 %, faint graded
reflection, sky pointer, reticle with an open centre, no "no engines", MFD ADI pole-on, clipped tape text gone,
ORB terminator, chips clear of the bezel, balanced key help). Then a strict critic pass of my own over all
screenshots found the defects below; each was fixed at its cause, re-shot and looked at.

| Defect found | What was done | Screenshot |
|---|---|---|
| Navball pole-on: the 20-degree numerals lie right at the bezel lip and were cut in half (grey half-glyphs at four places on the rim) | Label ink fades out over the last 0.06 R before the lip (`navballShader.ts`, `lipFade`); the 30-degree ring and everything inside it stay at full strength | `pad-4k`, `chutes-4k`, `lunarSurface-4k`, `retrograde-hold-4k` |
| Navball: slivers of markers whose centre is already under the lip (purple and cyan crescents on the rim in `entry-highg`, `attitude-lowOrbit`) | A marker whose centre passes under the lip fades out within a few degrees (instrument look only; the shared texture keeps its limb fade); markers with their centre in the window stay at full strength and may pass under the lip at their outer edge, as paint on a real ball does | `entry-highg-4k`, `attitude-lowOrbit-4k` |
| Unlabelled orange bar under the g tube (the g-dose) | A labelled line across the gauge panel: "G DOSE", bar, share of the fatal limit ("43 %"), amber, red from two thirds; shown only while there is a dose (the empty slot under both tubes is gone). Spec: visible, labelled, 43 % for 6.4 / 15 g s, inside the panel | `entry-highg-720p/4k` |
| Text under the HUD's own 10 px floor at 720p: key-help key caps 8.9 px, PITCH / ROLL chip labels 9.4 px, the next tile's Space cap 9.9 px, the ACTIVE tag 9.8 px | Raised (caps 0.9 em of the item, chip text 0.8 em, cap 1 em of the hint, tag 0.78 em). New spec assertion in every 720p scene, the key help, the high-g entry and the cabin view: every visible HUD text is at least 10 px and no text is wider than its box | `keyhelp-720p`, every `<scene>-720p` |
| Text overflowing its box (found by that assertion): a suborbital periapsis "−6 361.1 km" ran 12 px past its column into the (empty) time column; "6 840 m · 238°" ran 3 px past its row | A periapsis with no time to it takes the time column too (`.apsis.wide`); the landing-target rows use a tighter label spacing and gap | `ascent-*`, `reentry-*`, `entry-highg-*` |
| Arrow-key caps in the key help were thin arrows much smaller than the cap text beside them | Kept as glyphs, enlarged like the bracket caps | `keyhelp-*` |
| The launch panel without a target was a title and a lone body button | "No target: pick a body for its launch window" (wraps inside the plate; asserted in the layout spec) | `stage-lockout` |
| "Δv 0.0 m/s total" over the stack when only chutes and separations remain | The header is hidden while nothing left can burn | `reentry-*`, `chutes-*`, `failed-*` |
| "0.0 m · 000°" when landed on the target (a compass bearing to a point under the vessel) | Bearing "on target" within 0.5 m (`ON_TARGET_DISTANCE`, the range rule's threshold); HUD and MFD rows share it (unit and browser specs) | `lunarSurface-*`, `terrain-pending-*`, `bright-lunarSurface-720p` |
| MFD ENT "ABLATOR none" while SYS showed "Ablator 100 %" (the FakeSim reports a heat shield only in its plasma scenes) | The lab reports the lab vehicle's heat shield as the sim would (`tagLabVehicle`); the HUD's heat-shield row shows only while heating or below the redline (not under chutes) | `mfd-pages-4k` (ENT, SYS), `chutes-720p` |
| MFD SYS page mostly empty late in a mission (one bar over a blank column) | Up to six resources are full-height tank gauges side by side under their group's name (low-is-bad fill, scale, readout, name); more stay bars. Unit test: the capsule alone is a tank taller than 40 % of the page, the full stack stays bars | `mfd-pages-native-reentry`, `mfd-pages-4k` |
| Coverage gap (round-1 photo list, open since): the interior layout over an actual cabin | Lab option `cabin=<url>` shows a still in place of the backdrop; the spec uses the cockpit package's own seat-view render (`out/screens/cockpit/perf-1440p-leo-seat.png`, skipped with a message when absent). The interior layout (clock, recovery zone, stage stack, pill) sits clear of the windows and the cabin's displays | `cockpit-cabin-lowOrbit-720p/4k` |

Not fixed, plainly:
- The cabin view is a composite: a still of the cockpit package's render under the live HUD (this lab cannot run
  the cockpit renderer; that is the integration's job). It depends on that package's screenshot being present.
- Unchanged from round 2: the ORB page has a terminator but no coastline / maria mask (no per-body tables in
  engine code, no assets in the painter); the MFD ADI is a 2-D drawing, not the HUD ball; the ascent sits at
  19.6 % of the 20 % coverage budget.
- No critic has judged rounds 2 and 3 yet; the list above is my own review.

Requests: none filed. No open request names a flight-ui path (`cockpit-9` is against `src/render/vfx`).

Perf (2026-11-11, through the GPU gate under the machine-wide lock, other agents' jobs running; 2560 x 1440;
method of section 4): HUD whole main-thread cost **0.10 ms** per frame (low orbit with a node) and **0.16 ms**
(powered ascent), JavaScript inside `update()` 0.057 / 0.057 ms; navball 512 texture **p50 0.0062 ms, p99
0.0081 ms** with the 7 ms GPU ballast (ascent 0.0065 / 0.0079 ms; idle GPU: p99 0.058 / 0.061 ms, logged only),
HUD instrument canvas p50 0.0016 ms, p99 0.0023 ms. Budgets: HUD < 0.5 ms, navball < 0.05 ms p99
(ARCHITECTURE 17.1): met.

Verification: typecheck of the package paths OK; `npx vitest run src/input src/camera src/ui tests/unit/flight-ui
tools/dev/boundaries.test.ts` 85 passed; `playwright --project=functional` 65 passed (every screenshot re-shot);
`--project=perf` passed.

Own estimate after this round (honest): photo lens about 8, artifact lens about 8 to 8.5. The changes this round
are polish (no text below 10 px, nothing spilling out of its box, nothing cut at the instrument's edge, no
empty or contradictory read-outs), now guarded by assertions. What still holds the photo lens back is unchanged:
a clean flat UI by design, a 2-D MFD attitude indicator, and a body disc without surface detail on the ORB page.

## Visual close-out, round 5

Work lists: `out/qa/wave2/flight-ui.r4.photo.json` (photo 7.5) and `out/qa/wave2/flight-ui.r4.artifact.json`
(artifact 7.7), both read in full, the items still open from earlier rounds first. References used:
`out/qa/ref/cockpit-interiors/apollo11-columbia-panel.jpg` (FDAI: few, large numerals, markings whole under the
case mask), `soyuz-ms20-descent-module.jpg` and `orion-a2-flyby-hansen.jpg` (display bodies with real surface
detail), `out/qa/ref/moon-surface/earthrise-a8.jpg` (a lit side that falls continuously to its terminator),
`out/qa/ref/earth-orbit-clouds/limb-panorama.jpg` (a graded limb). Every item was changed at its cause, re-shot
at 720p and 4K and looked at (ball rims, the ORB discs, the left column and the bottom cluster cropped and
enlarged).

| Item (critic) | What was done | Screenshot |
|---|---|---|
| MAJOR: a stopped clock and contradicting readings in every scene (photo) | The lab gives each scene one coherent flight state (`SETUP`, main.ts; section 3): a running mission clock (ascent T+ 00:01:10 ... chutes 8d 02:52; pad 0 until the first stage; UT = launch + MET), a powered ascent (throttle 0.86, g = active TWR x throttle = 1.44 g), an entry whose q, height, heat flux and sink follow from its g (0.68 g at 2.7 kPa / 68 km / 406 kW/m^2 / -169 m/s; the high-g view 11.2 g at 43.9 kPa / 47.9 km / 1.64 MW/m^2), 1 g under the mains, predictions only where the vessel comes down (computed on the sphere along the ground track: the entry's impact 38.9 km from the zone centre; under chutes the impact under the vessel), the gear down after the gear stage, a burn-through failure that matches the readouts ("Heat shield burned through at 68.0 km", shield 0 %, skin 100 %), no lab words on screen. Spec: MET runs in every scene but the pad, no "lab"/"decoration" text | every `<scene>-720p/4k`, `failed-*`, `warp-refused` |
| Active tile named after its trigger event (both) | `stageBurnLabel` / `StageTileView.burnName`: the active tile (HUD and MFD STG, its "Active stage" row) names the stage group of the engines its stage ignited, with an engine icon and the event in the tooltip. The lab vehicle now carries the mission's six stage groups and ten stages. Spec: the active tile's title equals the one draining resource group, in ascent, lunar orbit and on the lunar surface | `lowOrbit-*` ("4 Meridian M-3"), `lunarSurface-*` ("5 Heron descent stage"), `mfd-pages-*` |
| Entry-interface row next to an OUTSIDE ZONE light (photo) | Row named "Entry interface"; the zone light follows `zoneStatus` (impact prediction, or the sub-point landed / under chutes; nothing for an entry-interface prediction or in orbit); the MFD ENT / LND rows carry the same as a "Zone" row; the panel's status edge takes the light's colour. Spec: an entry-interface prediction shows no light | `reentry-*`, `chutes-*`, `mfd-pages-native-reentry` |
| Navball numerals 6 px caps; 3 px warp arrows (photo) | Numerals 40 -> 54 px, heading labels 42 / 56 -> 56 / 68 px on the texture (9-11 px caps on the 720p ball; unit test against the 10 px floor), numerals only on the 20 / 40 / 60 lines; warp step buttons are drawn SVG chevrons at the text's cap height | `lowOrbit-720p`, `reentry-720p`, `pad-720p` |
| Numerals cut by the lip / faded into a blurred copy; half-strength markers at the rim (both) | Two textures (painted ball / with lettering); the shader decides per label from its anchor and extent (`labelVisibility`), fading the whole label before its farthest corner reaches the lip and showing the lines under it - no mip ghost, no half glyph; markers at full strength until their centre reaches the lip, gone ~2 deg later | `lunarOrbit-4k`, `lowOrbit-4k`, `attitude-lowOrbit-4k`, `entry-highg-4k` (crops of both rims) |
| ORB body a two-tone ball with a ruled terminator (both) | Shaded per pixel: cosine of the incidence to a dim night level, terminator softened over 1.5 % of R (5 % with air), the body's albedo map (`createMfdPainter({ bodyAlbedo })`; the lab loads each tile set's `globals.albedoLowRes`) - maria on the Moon, land / sea / cloud on the Earth; without a map the mean colour with a faint mottle | `mfd-pages-4k`, `mfd-pages-native-reentry` |
| Failed state over a live, armed HUD (photo) | Flight panels dimmed to 30 % and inert (clock kept), banner with the cause and `HudOptions.failureActions` (lab: "Revert to launch", "Restart scene") | `failed-*` |
| "LOCKED after last stage" on the pad (photo) | "LOCKED staging interlock" (HUD tile, tooltip, MFD) | `stage-lockout` |
| Two stage stacks in opposite order (photo) | MFD STG reads bottom-up like the HUD (later stages on top, next, active at the bottom) with the summary strip under it | `mfd-pages-*` |
| HUD without a look of its own (photo) | Two materials: the left column and the altimeter as panes of the MFD's black glass (header strip, title as the active tab with its accent underline, a status edge in the panel's state colour); the bottom cluster in the bezel's gunmetal with black-glass windows for the speed and chips; resources and the stage list keep the plain plate. Coverage still asserted (<= 20 %) | `lowOrbit-4k`, `reentry-720p`, `ascent-720p` |
| G-dose line pushes the tubes up (artifact) | The line holds its place (dim 0 %) wherever a dose can build (in air, or above 0.5 g); spec: the g tube's box is identical in `reentry` and `entry-highg` | `reentry-720p` vs `entry-highg-720p` |
| Apsis values on two right edges; ENT dose header without unit (artifact) | A suborbital Pe puts both rows in the wide form (time after the label, values at the edge); ENT g-dose header "0.0 g·s" | `ascent-*`, `mfd-pages-native-reentry` |
| Toast shot mid fade-in (artifact, open since round 1) | The spec waits for the toast's animations to finish before saving | `warp-refused` |
| Evidence: lab placeholder backdrop; cabin clock (artifact) | New views over stills of the real renderer (`still=`; integration package's `budget-*.png`): `real-ascent`, `real-lowOrbit`, `real-lunarSurface`, `real-reentry` (coverage and text floor asserted); the backdrop's limb is continuous across the local horizontal and fades the stars behind it (no ruled line); the cabin composite runs at the still's MET (00:00:05, UT 20:26:45) and attitude | `real-*-720p/4k`, `reentry-4k`, `cockpit-cabin-lowOrbit-*` |
| Also fixed on the way | Resource rows: bar under the name, so "Heron descent stage" reads whole; full groups counted when they would take more than two lines; SYS tank group names on two lines instead of squeezed; a long burn name moves the ACTIVE tag to its own line | `lunarSurface-*`, `mfd-pages-*` |

Not fixed, plainly:
- The bottom cluster shares one material with the bezel but is not joined by a housing bar: a bar under the ball
  costs about 0.25 % of the frame and the ascent sits at 19.8 % of the 20 % budget.
- Faraway numerals pass through a short dimmed state (about 0.04 R of rotation) as they approach the lip: whole,
  never cut, but faint for a moment.
- The FakeSim's conic stays circular in the entry scene (the ORB page shows Pe 68 km while the lab's readouts
  descend at 169 m/s); the lab decorates readouts, not trajectories.
- Everything in the scene behind the HUD in the lab's own views is still the lab backdrop; the real renderer is
  shown only as stills (the integration owns the live composition).

Requests: resolved `app-integration-3` (against `src/camera/chaseRig.ts`): a vertical vessel standing on a surface
is first seen from its starboard side, so the pad's umbilical tower no longer stands between camera and vehicle
(unit-tested). None filed.

Perf (2026-11-11, through the GPU gate, other agents' jobs running; 2560 x 1440; method of section 4): HUD whole
main-thread cost **0.11 ms** per frame visible minus hidden (low orbit with a node; 0.13 ms all-in) and **0.09 ms**
(powered ascent; 0.11 ms all-in), JavaScript inside `update()` 0.076 / 0.069 ms; navball 512 texture **p50
0.0094 ms, p99 0.0112 ms** (ascent 0.0101 / 0.0119 ms) with the 7-9 ms GPU ballast, HUD instrument canvas p50
0.0017 ms, p99 0.0022 ms. Budgets: HUD < 0.5 ms, navball < 0.05 ms p99 (ARCHITECTURE 17.1): met. The second
ball texture and the per-label visibility added about 0.002 ms to the 512 pass.

Verification: typecheck of the package paths OK; `npx vitest run src/input src/camera src/ui tests/unit/flight-ui
tools/dev/boundaries.test.ts` 90 passed; `playwright --project=functional` 73 passed (every screenshot
re-shot); `--project=perf` passed.

Own estimate after this round (honest): photo lens about 8, artifact lens about 8. The pictures now show one
consistent flight state per scene, the HUD over the real renderer, whole numerals at the rim and real bodies on
the ORB page; what still holds the photo lens back is that most views remain over the lab backdrop and the
cluster is three housings rather than one.