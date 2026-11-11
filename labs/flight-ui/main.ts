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
 *   predicted=impact|entry     lab decoration: a predicted arrival point in the landing-target readout
 *   targetOffset=<m>,<deg>     lab decoration: landing target at that distance and compass bearing (down/cross-range
 *                              follow the readout rule: 0 without a ground track)
 *   failed=1, terrainPending=1, lockout=1   lab decorations: mission-failed banner, terrain-loading notice, staging lockout
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
 *   cabin=<url>                a still image (the cockpit package's render of the cabin from the seat) shown in
 *                              place of the lab backdrop, to judge the interior HUD layout over a real cabin
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
import type { TerrainProvider } from '@/core/contracts/terrain';
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
import { buildMfdPage, createHud, createMfdPainter, createNavballRenderer, MFD_PAGES, projectMarker, type NavballRendererImpl } from '@/ui';
import { createLabBackdrop, LAB_GROUND } from './backdrop';
import { createGpuBallast } from './ballast';
import { createGpuTimer } from './gpuTimer';
import { labCylinders, labVehicleParts, tagLabVehicle, withLabVehicle, type LabGroup } from './labVehicle';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'lowOrbit') as FakeScene;
const testApi = installTestApi({ kind: 'lab', name: 'flight-ui', scenarioId: `fake-${scene}` });

const STAGES = ['Launch', 'M-1 separation', 'Tower + fairing jettison', 'M-2 separation', 'M-3 separation', 'Landing gear', 'Lunar lift-off', 'Capsule separation', 'Drogues', 'Mains'];

/** The mission vehicle's stages (icon and action kinds as in meridian-lunar.json); dv / twr / burn for engine stages. */
const STAGE_TABLE: { icon: string; actions: string[]; engine: { dv: number; twr: number; burn: number } | null }[] = [
  { icon: 'engine', actions: ['igniteEngines', 'releaseClamps'], engine: { dv: 3150, twr: 1.32, burn: 158 } },
  { icon: 'decoupler', actions: ['shutdownEngines', 'fireSeparationMotors', 'decouple', 'igniteEngines'], engine: { dv: 4180, twr: 0.94, burn: 372 } },
  { icon: 'fairing', actions: ['fireSeparationMotors', 'jettisonLES', 'jettisonFairing'], engine: null },
  { icon: 'decoupler', actions: ['shutdownEngines', 'enableRcs', 'decouple', 'igniteEngines'], engine: { dv: 3240, twr: 0.62, burn: 468 } },
  { icon: 'decoupler', actions: ['shutdownEngines', 'enableRcs', 'decouple', 'fireSeparationMotors', 'igniteEngines'], engine: { dv: 2520, twr: 0.41, burn: 610 } },
  { icon: 'legs', actions: ['deployLegs'], engine: null },
  { icon: 'engine', actions: ['shutdownEngines', 'decouple', 'igniteEngines'], engine: { dv: 2210, twr: 2.15, burn: 412 } },
  { icon: 'decoupler', actions: ['shutdownEngines', 'decouple', 'enableRcs'], engine: null },
  { icon: 'chute', actions: ['decouple', 'deployParachute'], engine: null },
  { icon: 'chute', actions: ['cutParachute', 'deployParachute'], engine: null },
];

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

interface SceneSetup {
  groups: LabGroup[];
  fill: Partial<Record<LabGroup, number>>;
  fired: number;
  /** Propellant left in the active (burning) stage, as the sim would report it. */
  activeFill: number;
}
const SETUP: Record<FakeScene, SceneSetup> = {
  pad: { groups: ['booster', 'upper', 'lander', 'capsule'], fill: {}, fired: 0, activeFill: 1 },
  ascent: { groups: ['booster', 'upper', 'lander', 'capsule'], fill: { booster: 0.62 }, fired: 1, activeFill: 0.62 },
  lowOrbit: { groups: ['upper', 'lander', 'capsule'], fill: { upper: 0.34 }, fired: 4, activeFill: 0.34 },
  translunar: { groups: ['lander', 'capsule'], fill: { lander: 0.97 }, fired: 5, activeFill: 0.97 },
  lunarOrbit: { groups: ['lander', 'capsule'], fill: { lander: 0.81 }, fired: 5, activeFill: 0.81 },
  lunarSurface: { groups: ['lander', 'capsule'], fill: { lander: 0.22 }, fired: 6, activeFill: 0.22 },
  reentry: { groups: ['capsule'], fill: { capsule: 0.8 }, fired: 8, activeFill: 1 },
  chutes: { groups: ['capsule'], fill: { capsule: 0.55 }, fired: 9, activeFill: 1 },
};

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

  const predicted = params.get('predicted');
  const flightParam = params.get('flight')?.split(',').map(Number) ?? null;
  const attitudeParam = params.get('attitude')?.split(',').map(Number) ?? null;
  const doseParam = params.get('dose');
  const liftParam = params.get('lift');
  const decorate = (raw: SimSnapshot): SimSnapshot => {
    let s = realisticStages(tagLabVehicle(raw), setup.activeFill);
    if (flightParam) {
      const [thr, g] = flightParam as [number, number];
      s = { ...s, readouts: { ...s.readouts, throttle: thr, thrust: thr * 9.2e6, gLoad: g } };
    }
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
    if (params.get('failed') === '1') s = { ...s, mission: { failed: true, failureReason: 'Heat shield burned through at 61 km (lab decoration)', crewAlive: false } };
    if (params.get('terrainPending') === '1') s = { ...s, terrain: { ...s.terrain, pending: true, complete: false } };
    if (params.get('lockout') === '1') s = { ...s, staging: { ...s.staging, lockout: true } };
    const offset = params.get('targetOffset');
    if (offset && s.readouts.landingTarget) {
      const [dist, brg] = offset.split(',').map(Number) as [number, number];
      const tracked = s.readouts.horizontalSpeed >= 0.1;
      // Ground-track direction from the surface velocity is not modelled here: track = north for the decoration.
      const b = brg * DEG;
      s = { ...s, readouts: { ...s.readouts, landingTarget: { ...s.readouts.landingTarget, distance: dist, bearingDeg: brg, downRange: tracked ? dist * Math.cos(b) : 0, crossRange: tracked ? dist * Math.sin(b) : 0 } } };
    }
    const lt = s.readouts.landingTarget;
    if (lt && (predicted === 'impact' || predicted === 'entry')) {
      const target = s.surfaceTargets.find((t) => t.id === lt.targetId)!;
      s = {
        ...s,
        readouts: {
          ...s.readouts,
          landingTarget: { ...lt, predicted: { kind: predicted, ut: s.ut + 1260, latitude: target.latitude + 0.0021, longitude: target.longitude - 0.0034, missDistance: 6840, missBearingDeg: 238.4 } },
        },
      };
    }
    return s;
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
  });
  hud.mount(uiRoot);
  const cabinUrl = params.get('cabin');
  if (cabinUrl) {
    // Over the backdrop canvas, under the HUD.
    const img = document.createElement('img');
    img.id = 'cabin';
    img.alt = '';
    img.src = cabinUrl;
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
  const painter = createMfdPainter();
  const mfdNative = params.get('mfd') === 'native';
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
  const showMfd = params.get('mfd') === '1' || mfdNative;
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
