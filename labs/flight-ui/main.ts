/**
 * flight-ui lab: the full HUD, navball, input system, flight controller and view manager running against the
 * FakeSim, with the cameras shown against a simple ray-traced backdrop (backdrop.ts).
 *
 * Query parameters:
 *   scene=<FakeScene>          default lowOrbit
 *   view=chase|cockpit|map     initial view (default chase)
 *   capture=1                  request fullscreen + keyboard lock on the first gesture (the app default)
 *   extraRig=1                 register an extra rig of unknown mode 'lab-orbit-cam' (kind external)
 *   node=1                     plan a 120 m/s prograde maneuver node 10 minutes ahead (orbit scenes)
 *   target=<bodyId>            set a target body at start
 *   targetOffset=<m>,<deg>     landing target at that distance and compass bearing (down/cross-range resolved
 *                              along the ground track; 0 without one)
 *   failed=1, terrainPending=1, lockout=1   a heat-shield burn-through (mission failed), the terrain-loading notice,
 *                              a staging interlock
 *   guard=1                    install the beforeunload guard (flight always in progress)
 *   mfd=1                      show the six MFD pages instead of the flight view
 *   ballast=<iterations>       perf: a GPU ballast pass before the navball (ballast.ts; setBallast() at run time)
 *   help=1                     open the key-help overlay
 *   orbit=<yawDeg>,<pitchDeg>,<distance>   initial chase / map orbit
 *   flight=<throttle>,<gLoad>  lab decoration: a powered flight (throttle lever, thrust and g load in the readouts)
 *   backdrop=bright            the backdrop's worst case for HUD legibility: a near-white sunlit cloud deck / regolith
 *                              and a pale sky
 *   mfd=native                 the six MFD pages at 512 x 384, shown 1 : 1 (the smallest supported display)
 *   attitude=<yaw>,<pitch>,<roll>  lab decoration: the vessel turned by this offset in its own frame (degrees),
 *                              markers and read-outs moved to match (markers off the nose, a real roll)
 *   dose=<g s>                 lab decoration: the crew's g-dose (the bar under the g tube)
 *   lift=<bankDeg>             lab decoration: a capsule lift-vector marker 30 deg off the nose, banked (0 = up)
 *   still=<url> (or cabin=)    a still of the real renderer (the integration's flight views, the cockpit package's
 *                              seat view) shown in place of the lab backdrop, to judge the HUD over real pictures
 *   met=<s>                    the mission elapsed time to show (to match a still); default: the scene's own
 *   predicted=impact|entry|none  the predicted arrival (default: an impact in the descending scenes only), placed
 *                              along the ground track and measured from the target on the sphere
 * The flight state of a still of the integration lab, with that lab's own parameters (labs/integration/main.ts):
 *   start=<m>                  ascent and chutes: the vessel's altitude (above the reference radius) at the start
 *                              (default 9,000 / 2,500; the mission clock moves along the FakeSim's climb with it)
 *   hover=<m>                  lunarSurface: the lander's feet this high above the ground, flying (default 0: landed)
 *   throttle=<0..1>            the throttle lever held from the start (engines of the fired stages burn)
 *   stage=<n>                  stages fired at the start in place of the scene's own (pad: stage=1 is the lift-off)
 *   sas=<mode>                 the SAS mode held from the start (e.g. retrograde)
 *   ground=<m>                 the ground (or the sea) under the vessel, m above the reference radius, in place of
 *                              the lab ground (the integration's stills stand on the real terrain or the sea)
 *
 * The FakeSim gives every stage the same engine numbers and the vessel a constant mass; the lab replaces them with
 * the mission vehicle's stage table (data/defs/vehicles/meridian-lunar.json: icons, action kinds, which stages
 * carry engines) and with figures computed from the lab parts the vessel carries (flightState.ts: mass, delta-v,
 * TWR at local gravity, burn time), reported as the sim reports them: the fired stage that owns the running
 * engines keeps live numbers (the active stage), other fired stages none. Stages without engines (gear, chutes,
 * jettisons) are photographed too.
 */
import type { ButtonAction, ControlInputs, SasMode } from '@/core/contracts/controls';
import type { CameraRig, CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { DefLibrary } from '@/core/contracts/defs';
import type { TerrainProvider, TileManifest } from '@/core/contracts/terrain';
import type { MfdPage } from '@/core/contracts/ui';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu } from '@/core/gpu/device';
import { quat, type Quat } from '@/core/math/quat';
import { DEG, G0 } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { installTestApi } from '@/core/testing/testApi';
import { createCameraInputMapper, createChaseRig, createCockpitRig, createMapRig, createViewManager, vesselComRoot, type ViewFrame } from '@/camera';
import { createFlightController, createInputSystem, DEFAULT_BINDINGS, installUnloadGuard, keyHelpEntries, keyLabel } from '@/input';
import { buildMfdPage, createHud, createMfdPainter, createNavballRenderer, formatAltitude, MFD_PAGES, projectMarker, type BodyAlbedoMap, type NavballRendererImpl } from '@/ui';
import { createLabBackdrop, LAB_GROUND } from './backdrop';
import { createGpuBallast } from './ballast';
import { airDensity, ellipseState, entryAtG, integrateEntry, labStageFigures, partsMass, speedOfSound, stageEngineGroup, withTrajectory, type EntrySample } from './flightState';
import { createGpuTimer } from './gpuTimer';
import { LAB_STAGES, LAB_VEHICLE_ID, labCylinders, labVehicleParts, tagLabVehicle, withLabVehicle, type LabGroup } from './labVehicle';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'lowOrbit') as FakeScene;
const testApi = installTestApi({ kind: 'lab', name: 'flight-ui', scenarioId: `fake-${scene}` });

const STAGES = LAB_STAGES.map((s) => s.label);

/** The mission vehicle's stages (icon and action kinds as in meridian-lunar.json). */
const STAGE_TABLE = LAB_STAGES.map((s) => ({ icon: s.icon, actions: s.actions.map((a) => a.kind as string) }));

/** Index of the 'Landing gear' stage (deploys the lander's legs). */
const GEAR_STAGE = LAB_STAGES.findIndex((s) => s.actions.some((a) => a.kind === 'deployLegs'));

/** A parameter as a finite number, or null. */
const numParam = (name: string): number | null => {
  const raw = params.get(name);
  const x = raw === null ? NaN : Number(raw);
  return Number.isFinite(x) ? x : null;
};

/**
 * Lab decoration: the vessel turned by an attitude offset in its own frame (yaw right, pitch up, roll right,
 * degrees) away from the FakeSim's attitude, with every navball marker and the pitch / heading / roll read-outs
 * moved to match. Shows markers off the nose and a roll other than 0 or 180 degrees.
 */
function offsetAttitude(s: SimSnapshot, yawDeg: number, pitchDeg: number, rollDeg: number): SimSnapshot {
  const qOff = quat.mul(quat.mul(quat.fromAxisAngle(v3.unitZ(), -yawDeg * DEG), quat.fromAxisAngle(v3.unitX(), pitchDeg * DEG)), quat.fromAxisAngle(v3.unitY(), rollDeg * DEG));
  const q = quat.mul(s.navball.qVesselToHorizon, qOff);
  const inv = quat.conj(qOff);
  const m = s.navball.markers;
  const mv = (d: Vec3 | null): Vec3 | null => (d ? quat.rotate(inv, d) : null);
  const markers = {
    prograde: mv(m.prograde)!,
    retrograde: mv(m.retrograde)!,
    normal: mv(m.normal)!,
    antinormal: mv(m.antinormal)!,
    radialOut: mv(m.radialOut)!,
    radialIn: mv(m.radialIn)!,
    maneuver: mv(m.maneuver),
    target: mv(m.target),
    antiTarget: mv(m.antiTarget),
    liftVector: mv(m.liftVector),
  };
  const nose = quat.rotate(q, v3.unitY());
  const dorsal = quat.rotate(q, v3.unitZ());
  const level = v3.reject(v3.unitZ(), nose);
  const upPerp = v3.len(level) > 1e-6 ? v3.normalize(level) : dorsal;
  const roll = Math.atan2(v3.dot(v3.cross(upPerp, dorsal), nose), v3.dot(upPerp, dorsal)) / DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, nose.z))) / DEG;
  const heading = (((Math.atan2(nose.x, nose.y) / DEG) % 360) + 360) % 360;
  return { ...s, navball: { ...s.navball, qVesselToHorizon: q, markers, pitchDeg: pitch, headingDeg: heading, rollDeg: roll } };
}

/**
 * One coherent flight state per FakeSim scene: what remains of the stack, the stages fired, and what the FakeSim
 * does not model (it opens every scene at mission time 0, coasts on circular orbits and weighs 50 t): the mission
 * elapsed time, the mass and stage figures of the parts carried, a powered climb, an entry that is one moment of
 * an integrated ballistic entry (its height, speed, flight-path angle, dynamic pressure, heating, osculating orbit
 * and range to the impact all from that trajectory), a translunar ellipse, the lander standing on the ground, a
 * steady descent under the mains, and a predicted impact only where the vessel is coming down.
 */
interface SceneSetup {
  groups: LabGroup[];
  fill: Partial<Record<LabGroup, number>>;
  fired: number;
  /** Mission elapsed time when the page opens, s (the pad stays at 0 until the first stage fires). */
  met: number;
  /** A powered flight: the lever (the g load follows from the active stage's thrust and the vessel's mass). */
  throttle?: number;
  /** A moment of the entry (ENTRY): the one at which the drag deceleration reaches this g. */
  entryG?: number;
  /** Descending under the main chutes at a steady rate (drag = weight: 1 g). */
  chutes?: boolean;
  /** A predicted impact straight below (a descent under chutes). */
  impactBelow?: boolean;
  /** The target placed beyond the entry's impact point: miss distance (m) and bearing off the ground track (deg). */
  targetBeyondImpact?: [number, number];
  /** An elliptic coast: periapsis and apoapsis altitudes, m. */
  coast?: { pe: number; ap: number };
  /** The scene stands on (or moves above) the lab ground: the FakeSim measures its radar altitude from it. */
  onGround?: boolean;
}
const ALL_GROUPS: LabGroup[] = ['booster', 'upper', 'm3', 'descent', 'ascent', 'capsule'];
const DAY = 86400;
/** Drag deceleration of the plain entry view, g. */
const ENTRY_BASE_G = 0.68;
const SETUP: Record<FakeScene, SceneSetup> = {
  pad: { groups: ALL_GROUPS, fill: {}, fired: 0, met: 0, onGround: true },
  ascent: { groups: ALL_GROUPS, fill: { booster: 0.62 }, fired: 1, met: 70, throttle: 0.86, onGround: true },
  lowOrbit: { groups: ['m3', 'descent', 'ascent', 'capsule'], fill: { m3: 0.34 }, fired: 4, met: 52 * 60 },
  // A day after the translunar injection: climbing out on an ellipse from a 190 km perigee toward the Moon's distance.
  translunar: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.97 }, fired: 5, met: DAY + 2 * 3600 + 21 * 60, coast: { pe: 190e3, ap: 380e6 } },
  lunarOrbit: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.81 }, fired: 5, met: 3 * DAY + 4 * 3600 + 25 * 60 },
  lunarSurface: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.22 }, fired: 6, met: 4 * DAY + 6 * 3600 + 12 * 60, onGround: true },
  reentry: { groups: ['capsule'], fill: { capsule: 0.8 }, fired: 8, met: 8 * DAY + 2 * 3600 + 41 * 60, entryG: ENTRY_BASE_G, targetBeyondImpact: [26e3, 1.2] },
  // Under the three mains (both chute stages fired), the ablator as the entry left it.
  chutes: { groups: ['capsule'], fill: { capsule: 0.8 }, fired: 10, met: 8 * DAY + 2 * 3600 + 52 * 60, chutes: true, impactBelow: true, onGround: true },
};

/** A capsule's ballistic coefficient m / (Cd A), kg/m^2: its drag deceleration is q / BALLISTIC. */
const BALLISTIC = 400;
/** Sutton-Graves stagnation heating constant (Earth, SI) and the capsule's nose radius (m). */
const SUTTON_GRAVES = 1.74e-4;
const NOSE_RADIUS = 3;
/** The entry interface: height (m), speed relative to the air (m/s) and flight-path angle (deg) of the entry. */
const ENTRY_INTERFACE = { h: 120e3, v: 7400, gammaDeg: -3 };
/** The FakeSim's climb rates of its moving surface scenes (m/s) and their default start altitudes (m). */
const FAKE_CLIMB: Partial<Record<FakeScene, { rate: number; start: number }>> = { ascent: { rate: 350, start: 9000 }, chutes: { rate: -8, start: 2500 } };

/** Great-circle helpers on a sphere of radius R (angles in radians). */
function destination(lat: number, lon: number, bearing: number, dist: number, R: number): [number, number] {
  const d = dist / R;
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing));
  const lon2 = lon + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  return [lat2, lon2];
}
function gcDistance(lat1: number, lon1: number, lat2: number, lon2: number, R: number): number {
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function gcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return Math.atan2(y, x);
}
const wrapDeg = (d: number): number => ((d % 360) + 360) % 360;

/** Debug surface of this lab for its Playwright specs. */
interface FlightUiLabApi {
  keyboardLocked(): boolean;
  heldCodes(): string[];
  /** Cumulative log of every ButtonAction / UI action seen in an InputFrame. */
  actions(): string[];
  /** Number of frames whose PointerState had each edge set (uiPressed / uiWheelFrames: those with overUi set). */
  pointerEdges(): { pressed: number; released: number; doubleClick: number; wheelFrames: number; uiPressed: number; uiWheelFrames: number };
  /** Per-frame samples (performance.now ms, lever throttle as applied, pitch). */
  frames(): { t: number; throttle: number; pitch: number; hudMs: number }[];
  /** Pixel position of a navball marker on the 512 x 512 texture (CPU projection of the current snapshot). */
  marker(name: string): { px: number; py: number; visible: boolean } | null;
  hudLandingRows(): [string, string][] | null;
  mfdRows(page: MfdPage): { label: string; value: string }[];
  mfdSection(page: MfdPage): { heading: string; rows: { label: string; value: string }[] } | null;
  notifications(): string[];
  hudTiming(): { last: number; mean: number; textUpdates: number };
  /** Show / hide the HUD (as F2 does) without a key press. */
  setHudVisible(on: boolean): void;
  /** Frames presented since boot. */
  frameCount(): number;
  gpuTimes(): Record<string, number[]>;
  /** GPU ballast iterations per pixel (0 = off); see ballast.ts. */
  setBallast(iterations: number): void;
  resetTimes(): void;
  setPointerCaptured(on: boolean): void;
  mode(): string;
  /** Render a navball for a pitch / heading / roll attitude and read pixels / horizon rows back. */
  navballProbe(att: { pitchDeg: number; headingDeg: number; rollDeg: number }, points: [number, number][], columns: number[]): Promise<{ pixels: number[][]; horizonRows: (number | null)[] }>;
}

declare global {
  interface Window {
    __flightUi?: FlightUiLabApi;
  }
}

/**
 * The low-resolution albedo map of every body with a tile set (TileManifest.globals.albedoLowRes under
 * /tiles/<tileset>/), decoded to RGBA for the MFD painter. A body without one is drawn in its mean colour.
 */
async function loadAlbedoMaps(defs: DefLibrary): Promise<{ albedo: Map<string, BodyAlbedoMap>; clouds: Map<string, BodyAlbedoMap> }> {
  const albedo = new Map<string, BodyAlbedoMap>();
  const clouds = new Map<string, BodyAlbedoMap>();
  /** A global map of the tile set, decoded to RGBA at most `maxWidth` wide. */
  const decode = async (tileset: string, path: string, maxWidth: number): Promise<BodyAlbedoMap> => {
    const bitmap = await createImageBitmap(await (await fetch(`/tiles/${tileset}/${path}`)).blob());
    const w = Math.min(maxWidth, bitmap.width);
    const h = Math.round((bitmap.height * w) / bitmap.width);
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext('2d')!;
    cx.drawImage(bitmap, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h);
    return { width: d.width, height: d.height, data: d.data };
  };
  for (const body of Object.values(defs.bodies)) {
    const tileset = body.terrain?.tileset;
    if (!tileset) continue;
    const manifest = (await (await fetch(`/tiles/${tileset}/manifest.json`)).json()) as TileManifest;
    const g = manifest.globals.albedoLowRes;
    if (g) albedo.set(body.id, await decode(tileset, g.path, g.width));
    // The cloud cover the atmosphere draws (its coverage channel), reduced to the albedo map's size.
    const cov = body.render.clouds ? manifest.globals[body.render.clouds.coverageMap] : undefined;
    if (cov) clouds.set(body.id, await decode(tileset, cov.path, g?.width ?? 1024));
  }
  return { albedo, clouds };
}

/** Vessel attitude from navball angles (heading clockwise from north, roll right positive), as VES -> horizon. */
function attitudeToQuat(pitchDeg: number, headingDeg: number, rollDeg: number): Quat {
  const p = pitchDeg * DEG;
  const h = headingDeg * DEG;
  const nose: Vec3 = { x: Math.cos(p) * Math.sin(h), y: Math.cos(p) * Math.cos(h), z: Math.sin(p) };
  const up = v3.unitZ();
  let dorsal = v3.reject(up, nose);
  dorsal = v3.len(dorsal) < 1e-6 ? v3.neg({ x: Math.sin(h), y: Math.cos(h), z: 0 }) : v3.normalize(dorsal);
  dorsal = quat.rotate(quat.fromAxisAngle(nose, rollDeg * DEG), dorsal);
  return quat.fromBasis(v3.cross(nose, dorsal), nose, dorsal);
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLDivElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  const context = canvas.getContext('webgpu')!;
  context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
  const resize = (): void => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const defs = withLabVehicle(await loadDefs(fetchDefSource()));
  const setup = SETUP[scene];
  const fired = numParam('stage') ?? setup.fired;
  const parts = labVehicleParts(defs, setup.fill, setup.groups);
  const vehicle = defs.vehicles[LAB_VEHICLE_ID]!;
  // The scene's body and the ground under the vessel: the lab ground (what the backdrop draws), or ground=.
  const sceneBody = scene === 'lunarOrbit' || scene === 'lunarSurface' ? 'moon' : defs.rootBodyId;
  const groundHeight = numParam('ground') ?? LAB_GROUND[sceneBody] ?? 0;
  const groundOverride = numParam('ground') !== null ? { [sceneBody]: groundHeight } : undefined;
  const hover = Math.max(0, numParam('hover') ?? 0);
  const start = numParam('start');
  // A standing scene's lowest point sits on the ground (the pad: on the launch mount, at its clamp height).
  const clampHeight = Object.values(defs.sites)[0]?.pad.clampHeight ?? 0;
  const sim = createFakeSim(defs, {
    scene,
    parts,
    stageLabels: STAGES,
    ...(setup.onGround ? { ground: { height: groundHeight, originHeight: 0, clearance: scene === 'pad' ? clampHeight : hover } } : {}),
    ...(start !== null && FAKE_CLIMB[scene] ? { altitude: start } : {}),
  });
  for (let i = 0; i < fired; i++) sim.commands.stage();
  if (params.get('target')) sim.commands.setTarget(params.get('target'));
  if (params.get('sas')) sim.commands.setSasMode(params.get('sas') as SasMode);
  if (params.get('node') === '1') {
    const id = sim.commands.addNode(sim.peek().ut + 600);
    sim.commands.setNode(id, { dv: { prograde: 120, normal: 8, radial: -3 } });
  }
  sim.snapshot();

  const predictedParam = params.get('predicted');
  const flightParam = params.get('flight')?.split(',').map(Number) ?? null;
  const throttleParam = numParam('throttle');
  const attitudeParam = params.get('attitude')?.split(',').map(Number) ?? null;
  const doseParam = params.get('dose');
  const liftParam = params.get('lift');
  const metParam = params.get('met');
  const offsetParam = params.get('targetOffset')?.split(',').map(Number) ?? null;

  // The entry: one ballistic trajectory from the entry interface; each entry view is the moment of it at which the
  // deceleration reaches its g (flight=<thr>,<g> picks another), and it flies on along it with the FakeSim's clock.
  const earth = defs.bodies[defs.rootBodyId]!;
  const entryPath: EntrySample[] = setup.entryG !== undefined ? integrateEntry(earth.mu, earth.radius, BALLISTIC, ENTRY_INTERFACE.h, ENTRY_INTERFACE.v, ENTRY_INTERFACE.gammaDeg * DEG) : [];
  const entryBase = setup.entryG !== undefined ? entryAtG(entryPath, setup.entryG) : null;
  const entryView = setup.entryG !== undefined ? entryAtG(entryPath, flightParam?.[1] ?? setup.entryG) : null;
  const entryEnd = entryPath[entryPath.length - 1] ?? null;
  const entryAt = (t: number): EntrySample => entryPath.find((x) => x.t >= t) ?? entryEnd!;
  /** The moment of the entry the latest snapshot shows. */
  let entryNow: EntrySample | null = null;

  /** The active stage, as the sim reports it: the fired stage whose engines run (none after a shutdown stage). */
  const activeStageIndex = (n: number): number => {
    for (let i = n - 1; i >= 0; i--) {
      if (stageEngineGroup(vehicle, i)) return i;
      if (STAGE_TABLE[i]?.actions.includes('shutdownEngines')) return -1;
    }
    return -1;
  };

  /** The scene's flight state on top of the FakeSim's (SceneSetup). */
  const sceneState = (raw: SimSnapshot): SimSnapshot => {
    let s = raw;
    const v0 = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const body = defs.bodies[v0.bodyId]!;
    // Mission time: the FakeSim opens every scene at 0. On the pad the clock waits for the first stage; a scene
    // started higher or lower (start=) is that much later or earlier on the FakeSim's climb.
    const onPad = scene === 'pad' && s.staging.nextStage === 0;
    const climb = FAKE_CLIMB[scene];
    const startShift = climb && start !== null ? (start - climb.start) / climb.rate : 0;
    const entryShift = entryView && entryBase ? entryView.t - entryBase.t : 0;
    const met = metParam !== null ? Number(metParam) : onPad ? 0 : setup.met + startShift + entryShift + s.readouts.met;

    // The state the lab sets: a moment of the entry, or the translunar ellipse.
    if (entryView) {
      const m = entryAt(entryView.t + s.readouts.met);
      entryNow = m;
      s = withTrajectory(s, defs, { altitude: m.h, ground: groundHeight, speed: m.v, gamma: m.gamma, frame: 'surface' });
    } else if (setup.coast) {
      const r = body.radius + s.readouts.altitudeAsl;
      const e = ellipseState(body.mu, body.radius + setup.coast.pe, body.radius + setup.coast.ap, r);
      s = withTrajectory(s, defs, { altitude: s.readouts.altitudeAsl, ground: 0, speed: e.speed, gamma: e.gamma, frame: 'inertial' });
    }
    // Off the ground (the lift-off still, a hover): the FakeSim still calls the vessel landed and reports no orbit;
    // a flying vessel has the osculating orbit of its state (at rest over the turning body: an apoapsis where it is
    // and a periapsis deep below the surface).
    const liftedOff = v0.situation === 'landed' && (hover > 0 || (scene === 'pad' && s.staging.nextStage > 0 && (throttleParam ?? 0) > 0));
    if (liftedOff) {
      const rr = s.readouts;
      s = withTrajectory(s, defs, { altitude: rr.altitudeAsl, ground: rr.altitudeAsl - rr.altitudeRadar, speed: rr.speedSurface, gamma: rr.verticalSpeed < 0 ? -Math.PI / 2 : Math.PI / 2, frame: 'surface' });
    }
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const r = s.readouts;
    const out = { ...r, met };
    const ut = onPad ? s.ut : s.ut - r.met + met;

    // Mass and stage figures from the parts the vessel carries (the sim's way: TWR at local gravity).
    const gLocal = body.mu / v3.lenSq(v.r);
    const mass = partsMass(defs, v.parts);
    const active = activeStageIndex(s.staging.nextStage);
    const stageInfos = s.staging.stages.map((info, i) => ({ ...info, icon: STAGE_TABLE[i]?.icon ?? info.icon, actionKinds: STAGE_TABLE[i]?.actions ?? info.actionKinds }));
    const figures = labStageFigures(defs, vehicle, v.parts, stageInfos, active, gLocal);
    out.mass = mass;
    out.deltaVTotal = figures.total;
    out.twr = 0;
    out.thrust = 0;
    // Gear: the lander's legs come down with the 'Landing gear' stage; a vessel without the lander has none.
    const hasLegs = setup.groups.includes('descent');
    out.legsDeployed = hasLegs ? (s.staging.nextStage > GEAR_STAGE ? !r.legsDeployed : r.legsDeployed) : null;

    // A powered flight: the lever, and the thrust of the active stage's engines at it (the felt g follows).
    const lever = flightParam ? flightParam[0]! : (throttleParam ?? setup.throttle ?? r.throttle);
    const situation = liftedOff ? 'flying' : v.situation;
    if (lever !== null && lever > 0 && active >= 0) {
      const full = figures.stages[active]!.twr * mass * gLocal;
      out.throttle = lever;
      out.thrust = lever * full;
      out.twr = out.thrust / (mass * gLocal);
      out.gLoad = out.thrust / (mass * G0);
      // Hovering: thrust balances weight, whatever lever the still was taken at.
      if (hover > 0) out.gLoad = gLocal / G0;
    } else if (lever !== null) out.throttle = lever;

    if (entryView) {
      // The entry's drag: the dynamic pressure, the felt g, the stagnation heating (Sutton-Graves).
      const h = out.altitudeAsl;
      const rho = airDensity(h);
      const vAir = out.speedSurface;
      out.dynamicPressure = 0.5 * rho * vAir * vAir;
      out.gLoad = out.dynamicPressure / (BALLISTIC * G0);
      out.heatFlux = SUTTON_GRAVES * Math.sqrt(rho / NOSE_RADIUS) * vAir * vAir * vAir;
    }
    // Under the mains at a steady sink rate drag equals weight: one g.
    if (setup.chutes) out.gLoad = 1;
    // The chute envelope is reported while a chute stage remains to be fired (as the sim does), none after the mains.
    if (!stageInfos.some((x) => !x.fired && x.actionKinds.includes('deployParachute'))) out.chuteEnvelope = null;
    // The Mach number from the standard atmosphere's speed of sound at the vessel's height.
    if (body.atmosphere && out.altitudeAsl < body.atmosphere.simTop) out.mach = out.speedSurface / speedOfSound(out.altitudeAsl);

    return {
      ...s,
      ut,
      vessels: s.vessels.map((x) => (x.id === v.id ? { ...x, mass, situation } : x)),
      staging: { ...s.staging, stages: figures.stages },
      readouts: out,
    };
  };

  /**
   * The landing target / recovery zone and the predicted arrival, worked out on the sphere so that every number
   * agrees: the target moved to `targetOffset` (distance, compass bearing) or beyond the entry's impact point
   * (SceneSetup), down-range and cross-range resolved along the FakeSim's ground track, and an impact (or entry
   * interface) point along the track - in an entry where the integrated trajectory ends - whose miss is its
   * distance from the target.
   */
  const landingState = (s: SimSnapshot): SimSnapshot => {
    const r = s.readouts;
    const lt = r.landingTarget;
    if (!lt) return s;
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const R = defs.bodies[v.bodyId]!.radius;
    const target = s.surfaceTargets.find((t) => t.id === lt.targetId)!;
    const tracked = r.horizontalSpeed >= 0.1 && Math.hypot(lt.downRange, lt.crossRange) >= 1;
    // Compass direction of the ground track, recovered from the readout (T = bearing - atan2(cross, down)).
    const track = tracked ? (lt.bearingDeg - (Math.atan2(lt.crossRange, lt.downRange) * 180) / Math.PI) * DEG : null;
    let tLat = target.latitude;
    let tLon = target.longitude;
    let out = lt;
    // The entry's impact: where the integrated trajectory ends, ahead along the track.
    const impactRange = entryNow && entryEnd ? entryEnd.x - entryNow.x : null;
    const beyond = setup.targetBeyondImpact;
    const place = offsetParam
      ? ([offsetParam[0]!, offsetParam[1]! * DEG] as const)
      : beyond && impactRange !== null && track !== null
        ? ([impactRange + beyond[0], track + beyond[1] * DEG] as const)
        : null;
    if (place) {
      const [dist, brg] = place;
      [tLat, tLon] = destination(r.latitude, r.longitude, brg, dist, R);
      out = { ...lt, distance: dist, bearingDeg: wrapDeg(brg / DEG), downRange: track !== null ? dist * Math.cos(brg - track) : 0, crossRange: track !== null ? dist * Math.sin(brg - track) : 0 };
    }
    const kind = predictedParam === 'none' ? null : predictedParam === 'impact' || predictedParam === 'entry' ? predictedParam : impactRange !== null || setup.impactBelow ? 'impact' : null;
    if (kind) {
      // Along the track (straight below without one): the entry's impact, else a few hundred km ahead.
      const range = track === null || setup.impactBelow ? 0 : (impactRange ?? (kind === 'entry' ? 2_000e3 : 300e3));
      const [pLat, pLon] = range === 0 ? [r.latitude, r.longitude] : destination(r.latitude, r.longitude, track!, range, R);
      const eta = entryNow && entryEnd ? entryEnd.t - entryNow.t : range === 0 ? r.altitudeRadar / Math.max(1, -r.verticalSpeed) : range / Math.max(1, r.horizontalSpeed);
      out = {
        ...out,
        predicted: { kind, ut: s.ut + eta, latitude: pLat, longitude: pLon, missDistance: gcDistance(tLat, tLon, pLat, pLon, R), missBearingDeg: wrapDeg(gcBearing(tLat, tLon, pLat, pLon) / DEG) },
      };
    }
    return out === lt ? s : { ...s, readouts: { ...r, landingTarget: out } };
  };

  const decorate = (raw: SimSnapshot): SimSnapshot => {
    let s = sceneState(tagLabVehicle(raw));
    if (doseParam !== null) s = { ...s, readouts: { ...s.readouts, gDose: Number(doseParam) } };
    if (liftParam !== null) {
      // A lifting capsule's lift vector: 30 deg off the nose toward the lift direction (bank in degrees, 0 = up).
      const b = Number(liftParam) * DEG;
      const lift = v3.normalize({ x: Math.sin(b) * 0.5, y: Math.cos(30 * DEG), z: Math.cos(b) * 0.5 });
      s = { ...s, navball: { ...s.navball, markers: { ...s.navball.markers, liftVector: lift } }, readouts: { ...s.readouts, liftVectorUp: Math.cos(b) > 0 } };
    }
    if (attitudeParam) {
      const [yaw, pitch, roll] = attitudeParam as [number, number, number];
      s = offsetAttitude(s, yaw ?? 0, pitch ?? 0, roll ?? 0);
    }
    if (params.get('failed') === '1') {
      // A burn-through: the shield's ablator gone, the skin past its limit, the crew lost, at the height shown.
      const r = s.readouts;
      s = {
        ...s,
        readouts: { ...r, ablatorFraction: r.ablatorFraction !== null ? 0 : null, maxTempFraction: 1 },
        mission: { failed: true, failureReason: `Heat shield burned through at ${formatAltitude(r.altitudeAsl)}. The crew did not survive the entry.`, crewAlive: false },
      };
    }
    if (params.get('terrainPending') === '1') s = { ...s, terrain: { ...s.terrain, pending: true, complete: false } };
    if (params.get('lockout') === '1') s = { ...s, staging: { ...s.staging, lockout: true } };
    return landingState(s);
  };

  const notifySink: { fn: (m: string) => void } = { fn: () => undefined };
  // Keyboard capture is the player's choice (the HUD's switch); capture=1 is the app's opt-in to ask on the first gesture.
  const input = createInputSystem(canvas, { captureKeyboard: params.get('capture') === '1' });
  if (params.get('guard') === '1') installUnloadGuard(() => true);
  const controller = createFlightController({ notify: (m) => notifySink.fn(m) });
  // A throttle held from the start (the integration lab's throttle=): the lever starts there.
  if (throttleParam !== null) controller.setThrottle(Math.min(1, Math.max(0, throttleParam)));
  const terrain: TerrainProvider = {
    heightAt: (bodyId) => groundOverride?.[bodyId] ?? LAB_GROUND[bodyId] ?? 0,
    normalAt: (_b, dir) => dir,
    surfaceKind: () => 'land',
    ensureLoaded: () => Promise.resolve(),
    prewarmCollision: () => 0,
    residency: () => ({ availableLevel: 0, finalLevel: 0, complete: true }) as unknown as ReturnType<TerrainProvider['residency']>,
    elevationRange: (bodyId) => ({ min: groundOverride?.[bodyId] ?? LAB_GROUND[bodyId] ?? 0, max: groundOverride?.[bodyId] ?? LAB_GROUND[bodyId] ?? 0 }),
  };
  const chase = createChaseRig({ defs, terrain });
  const cockpit = createCockpitRig({ defs });
  const map = createMapRig({ defs });
  const rigs: CameraRig[] = [chase, cockpit, map];
  if (params.get('extraRig') === '1') {
    // A rig known only through the CameraRig contract: unknown mode, kind 'external'.
    rigs.push({
      mode: 'lab-orbit-cam',
      activate: () => undefined,
      update: (s) => {
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
        const com = vesselComRoot(v);
        const up = v3.normalize(v.r);
        const side = v3.normalize(v3.cross(up, v3.unitZ()));
        const eye = v3.add(v3.add(com, v3.scale(side, 140)), v3.scale(up, 40));
        const fwd = v3.normalize(v3.sub(com, eye));
        const z = v3.neg(fwd);
        const x = v3.normalize(v3.cross(up, z));
        return { mode: 'lab-orbit-cam', kind: 'external', positionRoot: eye, qViewToRoot: quat.fromBasis(x, v3.cross(z, x), z), fovY: 50 * DEG, insideVesselId: null, focusVesselId: v.id, focusBodyId: v.bodyId, exposureCompensation: 0, minEv100: null, fillLight: 0 };
      },
    });
  }
  const viewManager = createViewManager(rigs, { defs, initialMode: params.get('view') ?? 'chase' });
  const mapper = createCameraInputMapper();
  const timer = createGpuTimer(gpu);
  const ballast = createGpuBallast(gpu, timer, Number(params.get('ballast') ?? 0));
  const navball: NavballRendererImpl = createNavballRenderer(gpu, { perf: timer });
  const keyFor = (action: ButtonAction): string | null => {
    const b = DEFAULT_BINDINGS.find((x) => x.kind === 'button' && x.action === action && !x.requiresKeyboardLock);
    return b ? keyLabel(b.code) : null;
  };
  const hud = createHud({
    defs,
    gpu,
    navball,
    dispatch: (a) => input.trigger(a),
    requestKeyboardCapture: () => void input.requestKeyboardCapture(),
    releaseKeyboardCapture: () => input.releaseKeyboardCapture(),
    // capturepill=0: clean footage without the capture switch.
    showCaptureControl: params.get('capturepill') !== '0',
    keyHelp: keyHelpEntries(input.bindings),
    keyFor,
    commands: () => sim.commands,
    // The lab's next steps after a failed mission: back to the pad, or this flight from its start.
    failureActions: [
      { label: 'Revert to launch', title: 'Start again from the pad', run: () => location.assign(`${location.pathname}?scene=pad`) },
      { label: 'Restart flight', title: 'Fly this part of the mission again from its start', run: () => location.reload() },
    ],
  });
  hud.mount(uiRoot);
  const stillUrl = params.get('still') ?? params.get('cabin');
  if (stillUrl) {
    // Over the backdrop canvas, under the HUD.
    const img = document.createElement('img');
    img.id = 'still';
    img.alt = '';
    img.src = stillUrl;
    uiRoot.before(img);
    await img.decode();
  }
  notifySink.fn = (m) => hud.notify(m);
  hud.setKeyboardLocked(input.keyboardLocked, input.fullscreen);
  input.onKeyboardLockChange((locked, fullscreen) => hud.setKeyboardLocked(locked, fullscreen));
  if (params.get('help') === '1') hud.toggleKeyHelp(true);
  const backdrop = createLabBackdrop(gpu, defs, () => labCylinders(defs, parts), { bright: params.get('backdrop') === 'bright', ...(groundOverride ? { ground: groundOverride } : {}) });

  // MFD showcase: 1024 x 768 pages scaled into a grid, or 512 x 384 pages shown 1 : 1 (mfd=native).
  const mfdEl = document.getElementById('mfd') as HTMLDivElement;
  const mfdNative = params.get('mfd') === 'native';
  const showMfd = params.get('mfd') === '1' || mfdNative;
  // The ORB page draws each body from its tile set's low-resolution albedo map, as the app would pass the one
  // it loads for its globe.
  const maps = showMfd ? await loadAlbedoMaps(defs) : { albedo: new Map<string, BodyAlbedoMap>(), clouds: new Map<string, BodyAlbedoMap>() };
  const painter = createMfdPainter({ bodyAlbedo: (id) => maps.albedo.get(id) ?? null, bodyClouds: (id) => maps.clouds.get(id) ?? null });
  const [mfdW, mfdH] = mfdNative ? [512, 384] : [1024, 768];
  const mfdCanvases = MFD_PAGES.map(() => {
    const c = document.createElement('canvas');
    c.width = mfdW;
    c.height = mfdH;
    mfdEl.append(c);
    return c;
  });
  const mfdOffscreen = new OffscreenCanvas(mfdW, mfdH);
  const mfdCtx = mfdOffscreen.getContext('2d')!;
  mfdEl.classList.toggle('visible', showMfd);
  mfdEl.classList.toggle('native', mfdNative);

  let snapshot = decorate(sim.snapshot());
  let view: ViewFrame | null = null;
  let camera: CameraState | null = null;
  let paused = false;
  let pointerCaptured = false;
  const testOverride: Partial<ControlInputs> = {};
  const actionLog: string[] = [];
  const edges = { pressed: 0, released: 0, doubleClick: 0, wheelFrames: 0, uiPressed: 0, uiWheelFrames: 0 };
  const frameLog: { t: number; throttle: number; pitch: number; hudMs: number }[] = [];
  const orbitParam = params.get('orbit');
  let orbitApplied = false;
  let probe: NavballRendererImpl | null = null;
  let frameCount = 0;

  testApi.extend({
    state: () => structuredClone(snapshot),
    commands: sim.commands,
    setControls: (partial) => {
      if (partial.throttle !== undefined) controller.setThrottle(partial.throttle);
      Object.assign(testOverride, partial);
      delete testOverride.throttle;
    },
    setPaused: (p) => {
      paused = p;
    },
    setView: (mode) => {
      viewManager.setMode(mode, snapshot);
    },
    camera: () => (camera ? structuredClone(camera) : null),
    setCameraOrbit: (yaw, pitch, distance) => {
      const rig = viewManager.rig(viewManager.mode) as { setOrbit?: (a: number, e: number, d: number) => void } | undefined;
      rig?.setOrbit?.(yaw, pitch, distance);
    },
  });

  window.__flightUi = {
    keyboardLocked: () => input.keyboardLocked,
    heldCodes: () => input.heldCodes(),
    actions: () => actionLog.slice(),
    pointerEdges: () => ({ ...edges }),
    frames: () => frameLog.slice(),
    marker: (name) => {
      const d = (snapshot.navball.markers as unknown as Record<string, Vec3 | null>)[name];
      if (!d) return null;
      const p = projectMarker(d, 512);
      return { px: p.px, py: p.py, visible: p.visible };
    },
    hudLandingRows: () => hud.landingTargetRows(),
    mfdRows: (page) => buildMfdPage(page, snapshot, defs).rows.map((r) => ({ label: r.label, value: r.value })),
    mfdSection: (page) => {
      const sec = buildMfdPage(page, snapshot, defs).section;
      return sec ? { heading: sec.heading, rows: sec.rows.map((r) => ({ label: r.label, value: r.value })) } : null;
    },
    notifications: () => hud.notifications(),
    hudTiming: () => ({ last: hud.lastUpdateMs, mean: hud.meanUpdateMs, textUpdates: hud.textUpdates }),
    setHudVisible: (on) => hud.setVisible(on),
    frameCount: () => frameCount,
    gpuTimes: () => structuredClone(timer.samples()),
    resetTimes: () => timer.reset(),
    setBallast: (n) => {
      ballast.iterations = Math.max(0, Math.round(n));
    },
    setPointerCaptured: (on) => {
      pointerCaptured = on;
    },
    mode: () => viewManager.mode,
    async navballProbe(att, points, columns) {
      probe ??= createNavballRenderer(gpu);
      const q = attitudeToQuat(att.pitchDeg, att.headingDeg, att.rollDeg);
      const none = { prograde: { x: 0, y: -1, z: 0 }, retrograde: { x: 0, y: -1, z: 0 }, normal: { x: 0, y: -1, z: 0 }, antinormal: { x: 0, y: -1, z: 0 }, radialOut: { x: 0, y: -1, z: 0 }, radialIn: { x: 0, y: -1, z: 0 }, maneuver: null, target: null, antiTarget: null, liftVector: null };
      const enc = gpu.device.createCommandEncoder();
      probe.renderState(enc, { mode: 'surface', qVesselToHorizon: q, markers: none, pitchDeg: att.pitchDeg, headingDeg: att.headingDeg, rollDeg: att.rollDeg });
      const buf = gpu.device.createBuffer({ size: 512 * 512 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: probe.texture }, { buffer: buf, bytesPerRow: 2048 }, [512, 512]);
      gpu.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(buf.getMappedRange().slice(0));
      buf.unmap();
      buf.destroy();
      const at = (x: number, y: number): number[] => {
        const i = (Math.round(y) * 512 + Math.round(x)) * 4;
        return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
      };
      // Horizon row of a column: midway between the last sky pixel (blue-dominant) and the first ground pixel
      // (red-dominant) below it; white lines and labels in between are neither.
      const isSky = (p: number[]): boolean => p[3]! > 200 && p[2]! > p[0]! + 30;
      const isGround = (p: number[]): boolean => p[3]! > 200 && p[0]! > p[2]! + 30;
      const horizonRows = columns.map((x) => {
        let lastSky: number | null = null;
        for (let y = 8; y < 504; y++) {
          const p = at(x, y);
          if (isSky(p)) lastSky = y;
          else if (isGround(p) && lastSky !== null) return (lastSky + y) / 2;
        }
        return null;
      });
      return { pixels: points.map(([x, y]) => at(x, y)), horizonRows };
    },
  };

  let last = performance.now();
  const frame = (now: number): void => {
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const f = input.sample();
    for (const a of f.pressed) actionLog.push(a);
    for (const a of f.ui) {
      actionLog.push(a);
      if (a === 'ui:keyHelp') hud.toggleKeyHelp();
    }
    if (f.pointer.pressed) edges.pressed++;
    if (f.pointer.released) edges.released++;
    if (f.pointer.doubleClick) edges.doubleClick++;
    if (f.pointer.wheel !== 0) edges.wheelFrames++;
    if (f.pointer.pressed && f.pointer.overUi) edges.uiPressed++;
    if (f.pointer.wheel !== 0 && f.pointer.overUi) edges.uiWheelFrames++;
    if (f.pressed.has('toggleHud')) hud.setVisible(!hud.visible);
    if (f.pressed.has('pause')) paused = !paused;

    const ctl = controller.update(f, snapshot, sim.commands, realDt, { view: camera?.kind ?? 'external', pointerCaptured });
    sim.setControls({
      ...ctl,
      pitch: testOverride.pitch ?? ctl.pitch,
      yaw: testOverride.yaw ?? ctl.yaw,
      roll: testOverride.roll ?? ctl.roll,
      translate: testOverride.translate ?? ctl.translate,
    });
    if (!paused) sim.advance(realDt);
    snapshot = decorate(sim.snapshot());

    const camIn = mapper.map(f, realDt, { pointerConsumed: pointerCaptured });
    view = viewManager.update(snapshot, camIn, realDt, f.pressed);
    if (!orbitApplied && orbitParam) {
      const [y, p, d] = orbitParam.split(',').map(Number);
      const rig = viewManager.rig(viewManager.mode) as { setOrbit?: (a: number, e: number, d: number) => void } | undefined;
      rig?.setOrbit?.((y ?? 0) * DEG, (p ?? 0) * DEG, d ?? 100);
      view = viewManager.update(snapshot, { yaw: 0, pitch: 0, zoom: 1 }, 0);
      orbitApplied = true;
    }
    camera = view.camera;
    ballast.submit();
    hud.update(snapshot, camera, realDt);

    const encoder = gpu.device.createCommandEncoder({ label: 'lab.frame' });
    backdrop.render(encoder, context.getCurrentTexture().createView(), snapshot, camera, [canvas.width, canvas.height]);
    gpu.device.queue.submit([encoder.finish()]);
    timer.endFrame();

    if (showMfd) {
      MFD_PAGES.forEach((page, i) => {
        painter.paint(mfdCtx, mfdW, mfdH, page, snapshot, defs);
        mfdCanvases[i]!.getContext('2d')!.drawImage(mfdOffscreen, 0, 0);
      });
    }
    frameLog.push({ t: now, throttle: snapshot.appliedControls.throttle, pitch: snapshot.appliedControls.pitch, hudMs: hud.lastUpdateMs });
    if (frameLog.length > 1500) frameLog.splice(0, frameLog.length - 1500);
    frameCount++;
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(3);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? err.message : String(err));
    testApi.markReady(false);
  },
);
