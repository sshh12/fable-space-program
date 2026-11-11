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
 *
 * The FakeSim gives every stage the same engine numbers; the lab replaces them with the mission vehicle's
 * stage table (data/defs/vehicles/meridian-lunar.json: icons, action kinds, which stages carry engines) and
 * plausible delta-v / TWR / burn times, reported as the sim reports them: the fired stage that owns the running
 * engines keeps live numbers (the active stage), other fired stages none. Stages without engines (gear, chutes,
 * jettisons) are photographed too.
 */
import type { ButtonAction, ControlInputs } from '@/core/contracts/controls';
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
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { installTestApi } from '@/core/testing/testApi';
import { createCameraInputMapper, createChaseRig, createCockpitRig, createMapRig, createViewManager, vesselComRoot, type ViewFrame } from '@/camera';
import { createFlightController, createInputSystem, DEFAULT_BINDINGS, installUnloadGuard, keyHelpEntries, keyLabel } from '@/input';
import { buildMfdPage, createHud, createMfdPainter, createNavballRenderer, describeStages, formatAltitude, MFD_PAGES, projectMarker, type BodyAlbedoMap, type NavballRendererImpl } from '@/ui';
import { createLabBackdrop, LAB_GROUND } from './backdrop';
import { createGpuBallast } from './ballast';
import { createGpuTimer } from './gpuTimer';
import { LAB_STAGES, labCylinders, labVehicleParts, tagLabVehicle, withLabVehicle, type LabGroup } from './labVehicle';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'lowOrbit') as FakeScene;
const testApi = installTestApi({ kind: 'lab', name: 'flight-ui', scenarioId: `fake-${scene}` });

const STAGES = LAB_STAGES.map((s) => s.label);

/** The mission vehicle's stages (icon and action kinds as in meridian-lunar.json); dv / twr / burn for engine stages. */
const STAGE_TABLE = LAB_STAGES.map((s) => ({ icon: s.icon, actions: s.actions.map((a) => a.kind as string), engine: s.engine }));

/** Index of the 'Landing gear' stage (deploys the lander's legs). */
const GEAR_STAGE = LAB_STAGES.findIndex((s) => s.actions.some((a) => a.kind === 'deployLegs'));

/**
 * The fired stage that owns the running engines, as the sim reports it (src/sim/vessel/facade.ts stagingInfo):
 * the latest fired engine stage, unless a later fired stage shut the engines down. -1 without one.
 */
function activeStageIndex(fired: number): number {
  for (let i = fired - 1; i >= 0; i--) {
    const row = STAGE_TABLE[i];
    if (!row) continue;
    if (row.engine) return i;
    if (row.actions.includes('shutdownEngines')) return -1;
  }
  return -1;
}

/**
 * Lab decoration: the mission vehicle's stage table in place of the FakeSim's generic one, reported the way the
 * sim reports it: unfired engine stages and the fired stage that owns the running engines (`fill` = the
 * propellant left in it) carry numbers, every other fired stage none; the total is over all of them.
 */
function realisticStages(s: SimSnapshot, activeFill: number): SimSnapshot {
  let total = 0;
  const active = activeStageIndex(s.staging.nextStage);
  const stages = s.staging.stages.map((info, i) => {
    const row = STAGE_TABLE[i];
    if (!row) return info;
    const none = { ...info, icon: row.icon, actionKinds: row.actions, propellantFraction: null, deltaVVac: 0, deltaVNow: 0, twr: 0, burnTime: 0 };
    if (!row.engine || (info.fired && i !== active)) return none;
    const frac = info.fired ? activeFill : 1;
    const dv = Math.round(row.engine.dv * frac);
    total += dv;
    // TWR grows as the stage burns its propellant (mass falls); a rough lab figure.
    const twr = row.engine.twr / (1 - 0.55 * (1 - frac));
    return { ...info, icon: row.icon, actionKinds: row.actions, propellantFraction: frac, deltaVVac: dv, deltaVNow: dv, twr, burnTime: row.engine.burn * frac };
  });
  return { ...s, staging: { ...s.staging, stages }, readouts: { ...s.readouts, deltaVTotal: total } };
}

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
 * does not model (it opens every scene at mission time 0 and coasts): the mission elapsed time, a powered climb,
 * an entry whose dynamic pressure, height, heating and sink rate match its g load, a steady descent under the
 * mains, a predicted impact only where the vessel is coming down, and the recovery zone ahead of an entry.
 */
interface SceneSetup {
  groups: LabGroup[];
  fill: Partial<Record<LabGroup, number>>;
  fired: number;
  /** Propellant left in the active (burning) stage, as the sim would report it. */
  activeFill: number;
  /** Mission elapsed time when the page opens, s (the pad stays at 0 until the first stage fires). */
  met: number;
  /** A powered flight: the lever (the g load follows from the active stage's TWR). */
  throttle?: number;
  /** An entry: drag deceleration from the dynamic pressure (or the g given), and the state that goes with it. */
  entry?: boolean;
  /** Descending under the main chutes at a steady rate (drag = weight: 1 g). */
  chutes?: boolean;
  /** Predicted arrival reported while coming down: 'impact' (range ahead along the ground track, m; 0 = below). */
  impactRange?: number;
  /** The target placed ahead of the vessel: distance (m) and bearing off the ground track (deg). */
  targetAhead?: [number, number];
}
const ALL_GROUPS: LabGroup[] = ['booster', 'upper', 'm3', 'descent', 'ascent', 'capsule'];
const DAY = 86400;
const SETUP: Record<FakeScene, SceneSetup> = {
  pad: { groups: ALL_GROUPS, fill: {}, fired: 0, activeFill: 1, met: 0 },
  ascent: { groups: ALL_GROUPS, fill: { booster: 0.62 }, fired: 1, activeFill: 0.62, met: 70, throttle: 0.86 },
  lowOrbit: { groups: ['m3', 'descent', 'ascent', 'capsule'], fill: { m3: 0.34 }, fired: 4, activeFill: 0.34, met: 52 * 60 },
  translunar: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.97 }, fired: 5, activeFill: 0.97, met: DAY + 2 * 3600 + 21 * 60 },
  lunarOrbit: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.81 }, fired: 5, activeFill: 0.81, met: 3 * DAY + 4 * 3600 + 25 * 60 },
  lunarSurface: { groups: ['descent', 'ascent', 'capsule'], fill: { descent: 0.22 }, fired: 6, activeFill: 0.22, met: 4 * DAY + 6 * 3600 + 12 * 60 },
  reentry: { groups: ['capsule'], fill: { capsule: 0.8 }, fired: 8, activeFill: 1, met: 8 * DAY + 2 * 3600 + 41 * 60, entry: true, impactRange: 1_425e3, targetAhead: [1_450e3, 1.2] },
  chutes: { groups: ['capsule'], fill: { capsule: 0.55 }, fired: 9, activeFill: 1, met: 8 * DAY + 2 * 3600 + 52 * 60, chutes: true, impactRange: 0 },
};

const G0 = 9.80665;
/** A capsule's ballistic coefficient m / (Cd A), kg/m^2: its drag deceleration is q / BALLISTIC. */
const BALLISTIC = 400;
/** Exponential atmosphere (sea-level density kg/m^3, scale height m) for the entry state's height. */
const RHO0 = 1.225;
const SCALE_HEIGHT = 7200;
/** Sutton-Graves stagnation heating constant (Earth, SI) and the capsule's nose radius (m). */
const SUTTON_GRAVES = 1.74e-4;
const NOSE_RADIUS = 3;
/** Flight-path angle of the entry, deg below the horizon. */
const ENTRY_GAMMA = 1.3;

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
async function loadAlbedoMaps(defs: DefLibrary): Promise<Map<string, BodyAlbedoMap>> {
  const maps = new Map<string, BodyAlbedoMap>();
  for (const body of Object.values(defs.bodies)) {
    const tileset = body.terrain?.tileset;
    if (!tileset) continue;
    const manifest = (await (await fetch(`/tiles/${tileset}/manifest.json`)).json()) as TileManifest;
    const g = manifest.globals.albedoLowRes;
    if (!g) continue;
    const bitmap = await createImageBitmap(await (await fetch(`/tiles/${tileset}/${g.path}`)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const cx = c.getContext('2d')!;
    cx.drawImage(bitmap, 0, 0);
    const d = cx.getImageData(0, 0, bitmap.width, bitmap.height);
    maps.set(body.id, { width: d.width, height: d.height, data: d.data });
  }
  return maps;
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
  const parts = labVehicleParts(defs, setup.fill, setup.groups);
  const sim = createFakeSim(defs, { scene, parts, stageLabels: STAGES });
  for (let i = 0; i < setup.fired; i++) sim.commands.stage();
  if (params.get('target')) sim.commands.setTarget(params.get('target'));
  if (params.get('node') === '1') {
    const id = sim.commands.addNode(sim.peek().ut + 600);
    sim.commands.setNode(id, { dv: { prograde: 120, normal: 8, radial: -3 } });
  }
  sim.snapshot();

  const predictedParam = params.get('predicted');
  const flightParam = params.get('flight')?.split(',').map(Number) ?? null;
  const attitudeParam = params.get('attitude')?.split(',').map(Number) ?? null;
  const doseParam = params.get('dose');
  const liftParam = params.get('lift');
  const metParam = params.get('met');
  const offsetParam = params.get('targetOffset')?.split(',').map(Number) ?? null;

  /** The scene's flight state on top of the FakeSim's (SceneSetup): clock, powered flight, entry, chutes, gear. */
  const sceneState = (s: SimSnapshot): SimSnapshot => {
    const r = s.readouts;
    // Mission time: the FakeSim opens every scene at 0. On the pad the clock waits for the first stage.
    const onPad = scene === 'pad' && s.staging.nextStage === 0;
    const met = metParam !== null ? Number(metParam) : onPad ? 0 : setup.met + r.met;
    const ut = onPad ? s.ut : s.ut - r.met + met;
    const out = { ...r, met };
    // Gear: the lander's legs come down with the 'Landing gear' stage; a vessel without the lander has none.
    const hasLegs = setup.groups.includes('descent');
    out.legsDeployed = hasLegs ? (s.staging.nextStage > GEAR_STAGE ? !r.legsDeployed : r.legsDeployed) : null;
    // A powered flight: the g load is the active stage's TWR at this throttle (gravity losses aside).
    const flight = flightParam ? { thr: flightParam[0]!, g: flightParam[1] ?? null } : setup.throttle !== undefined ? { thr: setup.throttle, g: null } : null;
    if (flight) {
      const active = describeStages(s).active;
      const twr = active >= 0 ? s.staging.stages[active]!.twr : 0;
      const g = flight.g ?? twr * flight.thr;
      out.throttle = flight.thr;
      out.thrust = flight.thr > 0 ? g * r.mass * G0 : 0;
      out.twr = flight.thr > 0 ? twr : 0;
      out.gLoad = g;
    }
    if (setup.entry) {
      // Drag deceleration q / (m / Cd A): the g load fixes the dynamic pressure, which fixes the height for the
      // speed (exponential atmosphere), the stagnation heating and, with the flight-path angle, the sink rate.
      const v = r.speedSurface;
      const g = flight?.g ?? r.dynamicPressure / (BALLISTIC * G0);
      const q = g * BALLISTIC * G0;
      const rho = (2 * q) / (v * v);
      const alt = SCALE_HEIGHT * Math.log(RHO0 / rho);
      out.gLoad = g;
      out.dynamicPressure = q;
      out.altitudeAsl = alt;
      out.altitudeRadar = alt;
      out.heatFlux = SUTTON_GRAVES * Math.sqrt(rho / NOSE_RADIUS) * v * v * v;
      out.verticalSpeed = -v * Math.sin(ENTRY_GAMMA * DEG);
      out.horizontalSpeed = v * Math.cos(ENTRY_GAMMA * DEG);
    }
    // Under the mains at a steady sink rate drag equals weight: one g.
    if (setup.chutes) out.gLoad = flight?.g ?? 1;
    return { ...s, ut, readouts: out };
  };

  /**
   * The landing target / recovery zone and the predicted arrival, worked out on the sphere so that every number
   * agrees: the target moved to `targetOffset` (distance, compass bearing) or ahead of the vessel (SceneSetup),
   * down-range and cross-range resolved along the FakeSim's ground track, and an impact (or entry interface)
   * point along the track whose miss is its distance from the target.
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
    const place = offsetParam ? ([offsetParam[0]!, offsetParam[1]! * DEG] as const) : setup.targetAhead && track !== null ? ([setup.targetAhead[0], track + setup.targetAhead[1] * DEG] as const) : null;
    if (place) {
      const [dist, brg] = place;
      [tLat, tLon] = destination(r.latitude, r.longitude, brg, dist, R);
      out = { ...lt, distance: dist, bearingDeg: wrapDeg(brg / DEG), downRange: track !== null ? dist * Math.cos(brg - track) : 0, crossRange: track !== null ? dist * Math.sin(brg - track) : 0 };
    }
    const kind = predictedParam === 'none' ? null : predictedParam === 'impact' || predictedParam === 'entry' ? predictedParam : setup.impactRange !== undefined ? 'impact' : null;
    if (kind) {
      // Along the track (straight below without one): the impact the scene sets, else a few hundred km ahead.
      const range = track === null ? 0 : (setup.impactRange ?? (kind === 'entry' ? 2_000e3 : 300e3));
      const [pLat, pLon] = track === null ? [r.latitude, r.longitude] : destination(r.latitude, r.longitude, track, range, R);
      const eta = track === null ? r.altitudeRadar / Math.max(1, -r.verticalSpeed) : range / Math.max(1, r.horizontalSpeed);
      out = {
        ...out,
        predicted: { kind, ut: s.ut + eta, latitude: pLat, longitude: pLon, missDistance: gcDistance(tLat, tLon, pLat, pLon, R), missBearingDeg: wrapDeg(gcBearing(tLat, tLon, pLat, pLon) / DEG) },
      };
    }
    return out === lt ? s : { ...s, readouts: { ...r, landingTarget: out } };
  };

  const decorate = (raw: SimSnapshot): SimSnapshot => {
    let s = sceneState(realisticStages(tagLabVehicle(raw), setup.activeFill));
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
  const input = createInputSystem(canvas, { captureKeyboard: params.get('capture') === '1' });
  if (params.get('guard') === '1') installUnloadGuard(() => true);
  const controller = createFlightController({ notify: (m) => notifySink.fn(m) });
  const terrain: TerrainProvider = {
    heightAt: (bodyId) => LAB_GROUND[bodyId] ?? 0,
    normalAt: (_b, dir) => dir,
    surfaceKind: () => 'land',
    ensureLoaded: () => Promise.resolve(),
    prewarmCollision: () => 0,
    residency: () => ({ availableLevel: 0, finalLevel: 0, complete: true }) as unknown as ReturnType<TerrainProvider['residency']>,
    elevationRange: (bodyId) => ({ min: LAB_GROUND[bodyId] ?? 0, max: LAB_GROUND[bodyId] ?? 0 }),
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
    keyHelp: keyHelpEntries(input.bindings),
    keyFor,
    commands: () => sim.commands,
    // The lab's next steps after a failed mission: back to the pad, or this scene from its start.
    failureActions: [
      { label: 'Revert to launch', title: 'Start again from the pad', run: () => location.assign(`${location.pathname}?scene=pad`) },
      { label: 'Restart scene', title: 'Start this scene again', run: () => location.reload() },
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
  hud.setKeyboardLocked(input.keyboardLocked);
  input.onKeyboardLockChange((locked) => hud.setKeyboardLocked(locked));
  if (params.get('help') === '1') hud.toggleKeyHelp(true);
  const backdrop = createLabBackdrop(gpu, defs, () => labCylinders(defs, parts), { bright: params.get('backdrop') === 'bright' });

  // MFD showcase: 1024 x 768 pages scaled into a grid, or 512 x 384 pages shown 1 : 1 (mfd=native).
  const mfdEl = document.getElementById('mfd') as HTMLDivElement;
  const mfdNative = params.get('mfd') === 'native';
  const showMfd = params.get('mfd') === '1' || mfdNative;
  // The ORB page draws each body from its tile set's low-resolution albedo map, as the app would pass the one
  // it loads for its globe.
  const albedo = showMfd ? await loadAlbedoMaps(defs) : new Map<string, BodyAlbedoMap>();
  const painter = createMfdPainter({ bodyAlbedo: (id) => albedo.get(id) ?? null });
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
