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
  isOverUi?: (target: EventTarget | null) => boolean;   // PointerState.overUi; default: an element other than the canvas
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
           opts?: { radiusFraction?: number; instrument?: boolean }): void;   // HUD: HUD_BALL_RADIUS_FRACTION 0.84, instrument look
  dispose(): void;
}
const HUD_BALL_RADIUS_FRACTION = 0.84;                          // the outer ring of the HUD canvas carries the bezel
function drawNavballBezel(ctx, sizePx, ballFraction): void;    // src/ui/navball/bezel.ts (static 2-D bezel, drawn on resize)
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
  readonly lastUpdateMs: number; readonly meanUpdateMs: number;   // JavaScript of update() only (see section 4)
  readonly textUpdates: number;                                     // updates that refreshed the text readouts
  landingTargetRows(): [string, string][] | null; notifications(): string[];
}
const HUD_TEXT_HZ = 10;                                             // refresh rate of the numeric text readouts

function createMfdPainter(): MfdPainter & { build(page, snapshot, defs): MfdPageModel };
function buildMfdPage(page: MfdPage, snapshot, defs): MfdPageModel;   // { title, rows, section?, status }
const MFD_PAGES = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];
// shared display models and formatters (HUD and MFD render from these):
describeFlight(s, mode?: 'auto' | 'asl' | 'radar'): FlightView;   // altitude (+ source), vertical speed (signed) + verticalTrend
                                                                   // ('up' | 'down' | 'level', drawn as an icon), horizontal speed,
                                                                   // speed of the navball mode, pitch, heading, roll, throttle, g
altitudeSource(s, mode?): 'radar' | 'asl';  const RADAR_ALTITUDE_SWITCH = 2000;  isLanded(v): boolean;
altitudeDatumName(s, defs): 'sea level' | 'datum';                // 'sea level' only on a body with an ocean (not the Moon)
orbitPhase(s, defs): { show; suborbital; periapsisTone };         // phase-aware orbit readout (see HUD below)
const G_SCALE = { caution: 6, limit: 10, full: 12 }; gTone(g);    // one g scale for the HUD gauge and the MFD pages
describeLandingTarget (LandingTargetView incl. `tracked`), landingTargetRows (rows without data collapse), isPredictionRow(label),
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
form around the 100 km lunar parking orbit; distances m below 10 km; vertical speed "+12.3 m/s" / "−4.0 m/s" /
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
  silhouette; the orange vessel reticle is drawn LAST (on top, like an ADI's aircraft symbol) with an open
  centre ring and a thin outline, so a marker held on the nose shows through it. Two looks: the shared texture
  has soft shading only (the cockpit relights it as an albedo); the HUD canvas (`instrument: true`) has a
  wrap-diffuse key light from the upper left with a dark terminator side, limb darkening to 0.4, a contact
  shadow at the bezel, a curved window reflection on the varnish (annular sector, crisp radial edges, a frame
  bar) and a faint Fresnel rim; the HUD's bezel (recessed gap, top-lit bevel, roll index ticks at 10 / 20 /
  30 / 45 / 60 and every 30 deg, orange top index) is a static 2-D canvas over it. **Texture contents:
  sRGB-encoded colour, premultiplied by coverage, alpha = coverage** (the cockpit should treat it as a
  premultiplied sRGB image). `render` and `renderTo` share one marker uniform buffer: within one submission,
  render both from the same state.
- **HUD**: DOM + the navball canvas (and its static bezel canvas) over the WebGPU canvas; only interactive parts
  take pointer events (exactly the elements carrying `data-hud-interactive`, `INTERACTIVE_ATTR`). Layout by
  `camera.kind`: external = everything; interior = clock, warp, notifications, landing target, stage stack,
  keyboard pill, help; map = clock, warp, altitude, orbit, landing target, node burn, navball + SAS. Plates are
  86 % opaque with a light hairline, a dark outer ring and a lit top edge; secondary text `#aebccf` keeps >= 4.5 : 1
  over a near-white backdrop (measured on screenshots by the spec). The bottom cluster is a `1fr auto 1fr` grid
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
  primary flight display (ADI about 60 % of the page height with graded sky / ground, a pitch ladder every 5 deg
  clipped to 0.8 r with numerals at both ends of every 10 deg line and none within 4 deg of the aircraft symbol,
  a fixed bank scale outside the disc at 10 / 20 / 30 / 45 / 60 deg with the sky pointer riding against it, the
  velocity vector from the prograde marker; speed and altitude tapes with pointer boxes holding the HUD's
  strings, a log vertical-speed scale, a heading tape with the boxed heading, throttle / g / horizontal /
  vertical boxes); ORB draws the conic around the body in the body's own colour (from `render.meanColor`), true
  to scale when that keeps the orbit clear of the body and otherwise with the altitude exaggerated (caption
  "ALTITUDE EXAGGERATED ×13" for the 100 km lunar orbit) so Ap and Pe are apart, apsis diamonds labelled with
  their altitudes; Ap / Pe rows read "—" while landed; SYS has the vehicle rows and large resource bars; STG a
  next-stage summary strip and the whole stack (number, icon, name, delta-v / TWR / burn or "no engines",
  propellant bar, lock state); ENT the entry rows, g / dose / ablator / skin-temperature bar gauges with scales,
  zones, redlines (10 g, the dose limit, 30 % ablator, 85 % temperature) and readouts (the ablator gauge only
  when the vessel has one), and the landing-target rows; LND the landing rows and target rows beside a
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
  (ARCHITECTURE sign).

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

Through the machine-load gate (docs/PACKAGE_RULES.md, "Machine load"):

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck:paths -- src/input src/camera src/ui labs/flight-ui tests/browser/flight-ui tests/unit/flight-ui
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/input src/camera src/ui tests/unit/flight-ui tools/dev/boundaries.test.ts   # 69 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/flight-ui --project=functional                               # 49 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/flight-ui --project=perf                                     # under the GPU lock
```

Lab: `/labs/flight-ui/?scene=<FakeScene>` with `view=chase|cockpit|map`, `capture=1`, `extraRig=1`,
`node=1`, `target=moon`, `predicted=impact|entry`, `targetOffset=<m>,<bearingDeg>`, `failed=1`,
`terrainPending=1`, `lockout=1`, `guard=1`, `mfd=1` (the six MFD pages), `mfd=native` (the pages at 512 x 384,
shown 1 : 1), `help=1`, `ballast=<iterations>` (perf: GPU ballast), `orbit=<yawDeg>,<pitchDeg>,<distance>`,
`flight=<throttle>,<gLoad>` (a powered flight: throttle, thrust and g in the readouts), `backdrop=bright` (the
HUD-legibility worst case: a near-white cloud deck / regolith and a pale sky). The lab replaces the FakeSim's
generic stage numbers with the mission vehicle's stage table (icons and action kinds of meridian-lunar.json,
engine stages with plausible delta-v / TWR / burn, gear / chute / jettison stages without engines). The lab adds a test vehicle (`labs/flight-ui/labVehicle.ts`: four stage
groups, resources, a command part with the mouldline seats) to the loaded library and tags FakeSim snapshots
with it; `predicted`, `targetOffset`, `failed`, `terrainPending`, `lockout` are lab decorations of the snapshot
(the FakeSim produces none of them; `targetOffset` follows the readout rule, down/cross-range 0 without a
ground track, track due north otherwise). The backdrop (`backdrop.ts`) is a lab-only ray
tracer for judging cameras and HUD legibility; it is not shipped.

Screenshots (all reviewed by eye): `out/screens/flight-ui/<scene>-720p.png` and `<scene>-4k.png` for all eight
FakeSim scenes, plus `cockpit-lowOrbit`, `map-lowOrbit`, `keyhelp`, `failed`, `terrain-pending`, `mfd-pages`,
`mfd-pages-hover` (landed 400 m from the target: no ground track) (all at both sizes),
`bright-<pad|ascent|reentry|lunarSurface>-720p` (near-white backdrop, label contrast asserted), `mfd-pages-native`
and `mfd-pages-native-reentry` (512 x 384 at 1 : 1), `prograde-hold`, `warp-refused`, `extra-rig`, `stage-lockout`.

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
| captureKeyboard: a real click leaves `keyboardLocked` a boolean, no error | met (either answer accepted; the HUD shows the matching pill) |
| PointerState edges and doubleClick exactly once | met (click: 1 / 1 / 0; double click: 2 / 2 / 1) |
| Navball: zenith at the reticle for nose-up; heading 090 wings level horizontal horizon with sky on top; roll right raises the horizon's right end by tan(roll) | met on the CPU reference (unit) and on the GPU texture (readback spec) |
| Marker positions match an independent projection within 1 px | met: < 1e-6 px over 2,000 random directions (`navball.test.ts`) |
| Camera: no jump above 1 cm / 0.1 deg between consecutive frames of a blend, incl. a vessel at 7.8 km/s | met (6 switch cases), read as: every frame's step is at most the blend's own smooth motion over that frame + 1 cm (turn: + 0.1 deg). The smooth motion is bounded analytically from the two endpoints (log-polar path, slerped orientation, weight k(t)), so near both ends, where k barely moves, any step beyond 1 cm / 0.1 deg fails; mid-blend a 0.6 s move from 2 m to 95 m necessarily moves metres per frame, so a literal per-frame 1 cm bound cannot hold there. A 2 cm jump injected at frame 2 or 50 of the blend is caught |
| Chase respects a fake terrain; cockpit eye at the seat; map 100 km .. 2e9 m in float64; focus request smooth; unknown-mode external rig through manager, HUD and listener | met (vitest + "M and C" browser spec) |
| Landing-target panel shows the lunar scenes' numbers and equals the MFD landing page strings | met (DOM rows == `buildMfdPage('landing')` rows, distance and bearing checked against the readout); the MFD's flight data (altitude source, vertical speed, heading) and Ap / Pe come from the same models as the HUD (unit tests) |
| Landing scope never shows "on target" while hovering away from it | met: a hovering vessel 400 m from the target draws it 400 m out at its bearing (unit test on the painted canvas calls); the target does not move when the drift crosses 0.1 m/s; the track line matches the down/cross-range rows |
| Text fields and DOM panels over the scene (request map-view-1) | met: typing digits / Backspace / Space / Enter edits the field and fires nothing; clicks and wheel over the panel come with `overUi` |
| Screenshots of every scene at 720p and 4K reviewed by eye | done (section 3) |
| HUD update < 0.5 ms per frame average | met: **whole main-thread cost 0.09 ms per frame** (low orbit with a node) and **0.11 ms** (powered ascent, every readout moving): CDP main-thread task time, HUD visible minus hidden (F2) over 5 + 5 alternating windows of 240 frames, plus the hidden HUD's own update; includes style, layout, paint and the navball encode + submit; 2560 x 1440. JavaScript inside `update()` alone: 0.06 ms mean. Without the GPU ballast (previous runs, busier machine): 0.16 / 0.19 ms and 0.25 / 0.30 ms. Before the fix the same method read 0.6-0.7 ms (text written every frame) |
| Navball < 0.05 ms GPU (17.1), p99 | met: **0.0065 ms p50, 0.008 ms p99** for the 512 texture (2,698 frames per scene, both scenes), HUD canvas copy 0.0006 / 0.0014 ms, measured with a 7 ms GPU ballast per frame as in the game (`labs/flight-ui/ballast.ts`, the method of docs/handoff/render-core.md 4.1). With an otherwise idle GPU the card drops its clocks and the same pass reads p50 0.014-0.016 ms and p99 0.025-0.077 ms from run to run (logged by the spec, not asserted) |
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

## Visual close-out, round 1 (in progress)

Work list: `out/qa/wave2/flight-ui.md` (19 items). Status while the work runs (a successor continues from here):
all 19 items have code changes committed (HUD plates, centring grid, tape gauges, vertical-speed icon, datum
altimeter, stage tiles and lock state, navball texture / shading / bezel / reticle / marker clipping, MFD page
layouts, help sheet, SAS key corners, zone status row, phase-aware orbit panel). Screenshots and perf are being
re-run; the final section below replaces this one.
