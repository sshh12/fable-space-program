/**
 * FakeSim: a kinematic stand-in for the real simulation, for developing and testing consumers of
 * SimSnapshot (HUD, navball, map view, audio, renderer features, cameras) before src/sim exists and in
 * lab pages afterwards. It implements the full `Sim` interface with plausible, internally consistent
 * numbers, but it is NOT physics: the vessel follows a circular orbit or sits on the surface, attitude
 * follows the inputs directly, nothing consumes propellant and nothing can fail.
 *
 * Never use it in the shipped app, in mission tests, or to judge flight behaviour.
 */
import { NEUTRAL_CONTROLS, type CommandResult, type ControlInputs, type NavballMode, type NodeEdit, type PlayerCommands, type SasMode } from '../contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, PHYSICS_DT, WARP_LEVELS, type BodyDef, type DefLibrary, type ScenarioDef } from '../contracts/defs';
import type {
  BodySnapshot,
  ManeuverNode,
  Marker,
  ModuleState,
  NavballMarkers,
  PartSnapshot,
  Patch,
  Readouts,
  Sim,
  SimDebug,
  SimEvent,
  SimSnapshot,
  StageInfo,
  SurfaceTarget,
  VesselSnapshot,
} from '../contracts/sim';
import { dirToLatLon, latLonToDir } from '../geo/cubeSphere';
import { conicApsides, conicFromState, conicPosition, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '../math/conic';
import { quat, type Quat } from '../math/quat';
import { clamp, DEG, G0, TWO_PI } from '../math/scalar';
import { v3, type Vec3 } from '../math/vec3';

export type FakeScene = 'pad' | 'ascent' | 'lowOrbit' | 'translunar' | 'lunarOrbit' | 'lunarSurface' | 'reentry' | 'chutes';

export interface FakeSimOptions {
  scene: FakeScene;
  /** Start time, seconds since J2000 (default: 2028-03-01 roughly). */
  ut?: number;
  /** Parts of the active vessel (e.g. from the real vessel assembler). Engine module states follow the throttle. */
  parts?: PartSnapshot[];
  /**
   * Vehicle definition the active vessel is published as (`VesselSnapshot.vehicleId`, `scenario.vehicle`): the
   * one `parts` were assembled from. Default '': the placeholder vessel belongs to no vehicle, and features
   * that look the vehicle up (cockpit layout, engine children) find none.
   */
  vehicleId?: string;
  /** Site used by the surface scenes (default: first site in the library). */
  siteId?: string;
  /**
   * Put a surface scene ('pad', 'ascent', 'lunarSurface', 'chutes') at this point instead of its own (labs: a
   * launch under an overcast sky, a landing at the scenario's target). The site definition itself, and what
   * the snapshot says about it, is unchanged.
   */
  location?: { latDeg: number; lonDeg: number };
  /**
   * Altitude of the vessel origin above the reference radius at the start of a surface scene, m (default: the
   * scene's own; 'ascent' 9,000 climbing, 'chutes' 2,500 sinking). A standing scene with `ground` ignores it.
   */
  altitude?: number;
  /**
   * The real ground under a surface scene (labs that draw the baked terrain; the default is a body without
   * relief): `height` = terrain or sea surface above the reference radius under the vessel, `originHeight` =
   * height of the vessel origin above the vessel's lowest point (both m). `readouts.altitudeRadar` is then
   * the height of the lowest point above that ground, a descent ends with the lowest point on it, and the
   * scenes that stand ('pad', 'lunarSurface') start with the lowest point `clearance` metres above it
   * (default 0: standing; a launch mount's clamp height; a hover height).
   */
  ground?: { height: number; originHeight: number; clearance?: number };
  /** Stage labels for the staging stack (default: a generic 4-entry stack). */
  stageLabels?: string[];
}

const OBLIQUITY = 23.4392911 * DEG;
/** Start time of a FakeSim that is given none, seconds since J2000. */
export const FAKE_SIM_DEFAULT_UT = 8.89e8;
const DEFAULT_UT = FAKE_SIM_DEFAULT_UT;

interface SceneSpec {
  bodyId: string;
  kind: 'surface' | 'orbit';
  altitude: number;
  inclinationDeg?: number;
  latDeg?: number;
  lonDeg?: number;
  climbRate?: number;
  plasma?: number;
  chutes?: boolean;
}

function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
}

function sunRoot(ut: number): Vec3 {
  const d = ut / 86400;
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870700;
  return { x: R * Math.cos(lambda), y: R * Math.cos(eps) * Math.sin(lambda), z: R * Math.sin(eps) * Math.sin(lambda) };
}

export class FakeSim implements Sim {
  readonly defs: DefLibrary;
  readonly scenario: ScenarioDef;
  readonly commands: PlayerCommands;
  readonly debug: SimDebug;
  readonly ready: Promise<void> = Promise.resolve();
  cheatCounter = 0;

  private ut: number;
  private readonly ut0: number;
  private tick = 0;
  private readonly spec: SceneSpec;
  private readonly ground: { height: number; originHeight: number; clearance?: number } | null;
  private controls: ControlInputs = { ...NEUTRAL_CONTROLS, translate: v3.zero() };
  private q: Quat = quat.identity();
  private w: Vec3 = v3.zero();
  private sasEnabled = true;
  private sasMode: SasMode = 'stability';
  private rcsEnabled = false;
  private fineControl = false;
  private legsDeployed = false;
  private lightsOn = false;
  private navballMode: NavballMode;
  private warpIndex = 0;
  private targetBodyId: string | null = null;
  private nextStage = 0;
  private readonly stageLabels: string[];
  private nodes: ManeuverNode[] = [];
  private nodeSeq = 0;
  private events: SimEvent[] = [];
  private readonly parts: PartSnapshot[];
  private throttleActual = 0;
  /** The staged engines burn (throttle above 2 %); time since they last lit and since they last went out, s (-1: never / burning). */
  private enginesLit = false;
  private ignitionAge = -1;
  private shutdownAge = -1;
  private readonly orbitPhase0: number;
  private readonly siteDir: Vec3;

  constructor(defs: DefLibrary, opts: FakeSimOptions) {
    this.defs = defs;
    this.ut0 = this.ut = opts.ut ?? DEFAULT_UT;
    const site = defs.sites[opts.siteId ?? Object.keys(defs.sites)[0] ?? ''];
    const siteLat = opts.location?.latDeg ?? site?.location.latDeg ?? 19.1;
    const siteLon = opts.location?.lonDeg ?? site?.location.lonDeg ?? -155.5;
    const root = defs.rootBodyId;
    const moon = Object.values(defs.bodies).find((b) => b.parent === root && b.gravityRole === 'attractor')?.id ?? root;
    const specs: Record<FakeScene, SceneSpec> = {
      pad: { bodyId: root, kind: 'surface', altitude: 60, latDeg: siteLat, lonDeg: siteLon },
      ascent: { bodyId: root, kind: 'surface', altitude: 9000, latDeg: siteLat, lonDeg: siteLon, climbRate: 350 },
      lowOrbit: { bodyId: root, kind: 'orbit', altitude: 200e3, inclinationDeg: Math.abs(siteLat) },
      translunar: { bodyId: root, kind: 'orbit', altitude: 180e6, inclinationDeg: 21 },
      lunarOrbit: { bodyId: moon, kind: 'orbit', altitude: 100e3, inclinationDeg: 4 },
      lunarSurface: { bodyId: moon, kind: 'surface', altitude: 4, latDeg: 0.674, lonDeg: 23.473 },
      reentry: { bodyId: root, kind: 'orbit', altitude: 68e3, inclinationDeg: 21, plasma: 0.85 },
      chutes: { bodyId: root, kind: 'surface', altitude: 2500, latDeg: 8, lonDeg: -146, climbRate: -8, chutes: true },
    };
    this.spec = specs[opts.scene];
    if (opts.location && this.spec.kind === 'surface') this.spec = { ...this.spec, latDeg: opts.location.latDeg, lonDeg: opts.location.lonDeg };
    if (opts.altitude !== undefined && this.spec.kind === 'surface') this.spec = { ...this.spec, altitude: opts.altitude };
    this.ground = opts.ground ?? null;
    this.siteDir = latLonToDir((this.spec.latDeg ?? 0) * DEG, (this.spec.lonDeg ?? 0) * DEG);
    this.orbitPhase0 = 0.6;
    this.navballMode = this.spec.kind === 'orbit' ? 'orbit' : 'surface';
    this.parts = opts.parts ?? [];
    this.stageLabels = opts.stageLabels ?? ['Launch', 'Stage separation', 'Fairing jettison', 'Parachutes'];
    this.scenario = {
      id: `fake-${opts.scene}`,
      name: `Fake scene: ${opts.scene}`,
      vehicle: opts.vehicleId ?? '',
      site: site?.id ?? '',
      startUt: this.ut0,
      start: { kind: 'state', bodyId: this.spec.bodyId, r: [0, 0, 0], v: [0, 0, 0] },
      stagesAlreadyFired: 0,
      target: null,
      suggestedLanding: this.spec.bodyId === moon && moon !== root ? { bodyId: moon, latDeg: 0.674, lonDeg: 23.473, name: 'Tranquility Base' } : null,
      milestones: [],
    };
    this.q = this.initialAttitude();
    const ok = (): CommandResult => ({ ok: true });
    this.commands = {
      stage: () => {
        if (this.nextStage >= this.stageLabels.length) return { ok: false, reason: 'No stages left' };
        const stageIndex = this.nextStage++;
        this.events.push({ type: 'stageFired', ut: this.ut, vesselId: 'fake-vessel', stageIndex, label: this.stageLabels[stageIndex]! });
        return ok();
      },
      abort: ok,
      setSasEnabled: (on) => ((this.sasEnabled = on), ok()),
      setSasMode: (mode) => {
        if (mode === 'maneuver' && this.nodes.length === 0) return { ok: false, reason: 'No maneuver node' };
        this.sasMode = mode;
        return ok();
      },
      setRcsEnabled: (on) => ((this.rcsEnabled = on), ok()),
      toggleLegs: () => {
        this.legsDeployed = !this.legsDeployed;
        this.events.push({ type: 'legsToggled', ut: this.ut, vesselId: 'fake-vessel', deployed: this.legsDeployed });
        return ok();
      },
      toggleLights: () => ((this.lightsOn = !this.lightsOn), ok()),
      setFineControl: (on) => ((this.fineControl = on), ok()),
      setNavballMode: (mode) => ((this.navballMode = mode), ok()),
      setWarpLevel: (index) => {
        const max = this.maxWarpIndex();
        const next = clamp(Math.round(index), 0, WARP_LEVELS.length - 1);
        this.warpIndex = Math.min(next, max);
        this.events.push({ type: 'warpChanged', ut: this.ut, vesselId: 'fake-vessel', index: this.warpIndex, factor: WARP_LEVELS[this.warpIndex]!, reason: next > max ? 'Cannot warp faster here' : null });
        return next > max ? { ok: false, reason: 'Cannot warp faster here' } : ok();
      },
      addNode: (ut) => {
        const id = `node-${++this.nodeSeq}`;
        this.nodes.push({ id, ut, dv: { prograde: 0, normal: 0, radial: 0 } });
        this.nodes.sort((a, b) => a.ut - b.ut);
        return id;
      },
      setNode: (id, edit: NodeEdit) => {
        const n = this.nodes.find((x) => x.id === id);
        if (!n) return { ok: false, reason: 'Unknown node' };
        if (edit.ut !== undefined) n.ut = edit.ut;
        if (edit.dv) Object.assign(n.dv, edit.dv);
        return ok();
      },
      removeNode: (id) => {
        const before = this.nodes.length;
        this.nodes = this.nodes.filter((x) => x.id !== id);
        return before === this.nodes.length ? { ok: false, reason: 'Unknown node' } : ok();
      },
      setTarget: (bodyId) => ((this.targetBodyId = bodyId), ok()),
      cycleActiveVessel: () => ({ ok: false, reason: 'No other controllable vessel' }),
    };
    const cheat = (): void => {
      this.cheatCounter++;
    };
    this.debug = { setVesselState: cheat, setResource: cheat, setUt: cheat };
  }

  get needsIntegration(): boolean {
    return this.controls.throttle > 0 || (this.spec.kind === 'surface' && (this.spec.climbRate ?? 0) !== 0) || this.spec.plasma !== undefined;
  }

  get nextEventUt(): number {
    return this.nodes[0]?.ut ?? Infinity;
  }

  terrainPending(): Promise<void> | null {
    return null;
  }

  setControls(inputs: ControlInputs): void {
    this.controls = { ...inputs, translate: v3.clone(inputs.translate), throttle: clamp(inputs.throttle, 0, 1) };
  }

  advance(realDt: number, onControlTick?: () => void): void {
    onControlTick?.();
    const dt = clamp(realDt, 0, 0.1) * WARP_LEVELS[this.warpIndex]!;
    this.integrate(dt, clamp(realDt, 0, 0.1));
  }

  step(): void {
    this.integrate(PHYSICS_DT, PHYSICS_DT);
  }

  advanceRails(targetUt: number): number {
    const t = Math.min(targetUt, this.nextEventUt);
    if (t > this.ut) this.integrate(t - this.ut, 0);
    return this.ut;
  }

  stateHash(): string {
    return `${this.ut.toFixed(6)}|${this.q.x.toFixed(9)},${this.q.y.toFixed(9)},${this.q.z.toFixed(9)},${this.q.w.toFixed(9)}|${this.nextStage}`;
  }

  // -------------------------------------------------------------------------------------------- kinematics

  private maxWarpIndex(): number {
    return this.needsIntegration ? MAX_PHYSICS_WARP_INDEX : WARP_LEVELS.length - 1;
  }

  private integrate(simDt: number, attitudeDt: number): void {
    this.ut += simDt;
    this.tick++;
    if (this.warpIndex > this.maxWarpIndex()) this.warpIndex = this.maxWarpIndex();
    const tau = this.controls.throttle > this.throttleActual ? 0.8 : 0.3;
    this.throttleActual += (this.controls.throttle - this.throttleActual) * Math.min(1, attitudeDt / tau);
    // Engine clocks, as the real engine module keeps them: 0 on the step the engines light, counting while
    // they burn; the shutdown clock starts at 0 on the step they go out and counts while they are off.
    const lit = this.throttleActual > 0.02;
    if (lit && !this.enginesLit) {
      this.ignitionAge = 0;
      this.shutdownAge = -1;
    } else if (lit) this.ignitionAge += simDt;
    else if (this.enginesLit) this.shutdownAge = 0;
    else if (this.shutdownAge >= 0) this.shutdownAge += simDt;
    this.enginesLit = lit;
    const rate = (this.fineControl ? 6 : 20) * DEG;
    const c = this.controls;
    // pitch up = +X rotation, yaw right = -Z rotation, roll right = +Y rotation (VES frame)
    this.w = { x: c.pitch * rate, y: c.roll * rate, z: -c.yaw * rate };
    if (attitudeDt > 0) {
      this.q = quat.normalize(quat.mul(this.q, quat.fromRotVec(v3.scale(this.w, attitudeDt))));
      if (this.sasEnabled && this.sasMode !== 'stability' && c.pitch === 0 && c.yaw === 0) {
        const target = this.holdDirection(this.sasMode);
        if (target) {
          const nose = quat.rotate(this.q, v3.unitY());
          const fix = quat.fromTo(nose, target);
          this.q = quat.normalize(quat.mul(quat.slerp(quat.identity(), fix, Math.min(1, attitudeDt * 1.5)), this.q));
        }
      }
    }
    this.nodes = this.nodes.filter((n) => n.ut > this.ut - 1);
  }

  private body(id: string): BodyDef {
    const b = this.defs.bodies[id];
    if (!b) throw new Error(`FakeSim: unknown body ${id}`);
    return b;
  }

  private bodyStateRoot(id: string, ut: number): { r: Vec3; v: Vec3; conic: ConicElements | null } {
    const b = this.body(id);
    if (b.parent === null || !b.orbit) return { r: v3.zero(), v: v3.zero(), conic: null };
    if (b.orbit.kind === 'sunLowPrecision') {
      const r = sunRoot(ut);
      const r2 = sunRoot(ut + 1);
      return { r, v: v3.sub(r2, r), conic: null };
    }
    // Circular approximation of the Kepler orbit (fake!): same plane and period, zero eccentricity.
    const o = b.orbit;
    const parent = this.body(b.parent);
    const n = Math.sqrt((parent.mu + b.mu) / o.a ** 3);
    const theta = (o.argPeDeg + o.meanAnomalyDeg) * DEG + n * (ut - o.epochUt);
    const inc = o.iDeg * DEG;
    const lan = o.lanDeg * DEG;
    const basis = (th: number): Vec3 => {
      const x = Math.cos(th);
      const y = Math.sin(th);
      let p: Vec3 = {
        x: Math.cos(lan) * x - Math.sin(lan) * Math.cos(inc) * y,
        y: Math.sin(lan) * x + Math.cos(lan) * Math.cos(inc) * y,
        z: Math.sin(inc) * y,
      };
      if (o.frame === 'ecliptic') p = rotX(p, OBLIQUITY);
      return p;
    };
    const r = v3.scale(basis(theta), o.a);
    const v = v3.scale(basis(theta + Math.PI / 2), o.a * n);
    const parentState = this.bodyStateRoot(b.parent, ut);
    return { r: v3.add(parentState.r, r), v: v3.add(parentState.v, v), conic: conicFromState(parent.mu + b.mu, r, v, ut) };
  }

  /** BCBF -> ROOT orientation and spin vector (fake: spin about ROOT +Z for fixedRate, orbit-locked otherwise). */
  private bodyOrientation(id: string, ut: number): { q: Quat; spin: Vec3 } {
    const b = this.body(id);
    if (b.rotation.mode === 'fixedRate') {
      const rate = (b.rotation.rateDegPerDay * DEG) / 86400;
      const angle = (90 + b.rotation.w0Deg) * DEG + rate * (ut - b.rotation.epochUt);
      return { q: quat.fromAxisAngle(v3.unitZ(), angle % TWO_PI), spin: v3.new(0, 0, rate) };
    }
    if (b.rotation.mode === 'tidalLock' && b.parent) {
      const s = this.bodyStateRoot(id, ut);
      const p = this.bodyStateRoot(b.parent, ut);
      const rel = v3.sub(s.r, p.r);
      const x = v3.normalize(v3.neg(rel));
      const z = v3.normalize(v3.cross(rel, v3.sub(s.v, p.v)));
      const y = v3.cross(z, x);
      const period = s.conic?.period ?? Infinity;
      return { q: quat.fromBasis(x, y, z), spin: v3.scale(z, TWO_PI / period) };
    }
    return { q: quat.identity(), spin: v3.zero() };
  }

  /** Vessel state in BCI of the scene body. */
  private vesselState(ut: number): { r: Vec3; v: Vec3; altitude: number } {
    const b = this.body(this.spec.bodyId);
    const t = ut - this.ut0;
    if (this.spec.kind === 'surface') {
      const { q, spin } = this.bodyOrientation(b.id, ut);
      const climb = this.spec.climbRate ?? 0;
      // On real ground a standing scene starts on it (plus its clearance) and nothing sinks below it.
      const g = this.ground;
      const floor = g ? g.height + g.originHeight : 30;
      const start = g && climb === 0 ? floor + (g.clearance ?? 0) : this.spec.altitude;
      const altitude = clamp(start + climb * t, floor, 150e3);
      const r = v3.scale(quat.rotate(q, this.siteDir), b.radius + altitude);
      const moving = altitude > floor && altitude < 150e3;
      const v = v3.add(v3.cross(spin, r), v3.scale(v3.normalize(r), moving ? climb : 0));
      return { r, v, altitude };
    }
    const radius = b.radius + this.spec.altitude;
    const n = Math.sqrt(b.mu / radius ** 3);
    const th = this.orbitPhase0 + n * t;
    const inc = (this.spec.inclinationDeg ?? 0) * DEG;
    const at = (a: number): Vec3 => ({ x: Math.cos(a), y: Math.sin(a) * Math.cos(inc), z: Math.sin(a) * Math.sin(inc) });
    return { r: v3.scale(at(th), radius), v: v3.scale(at(th + Math.PI / 2), radius * n), altitude: this.spec.altitude };
  }

  private surfaceVelocity(ut: number): Vec3 {
    const s = this.vesselState(ut);
    const { spin } = this.bodyOrientation(this.spec.bodyId, ut);
    return v3.sub(s.v, v3.cross(spin, s.r));
  }

  private frameDirs(ut: number): { prograde: Vec3; normal: Vec3; radialOut: Vec3 } {
    const s = this.vesselState(ut);
    const useSurface = this.navballMode === 'surface';
    let vel = useSurface ? this.surfaceVelocity(ut) : s.v;
    if (v3.len(vel) < 0.05) vel = v3.normalize(s.r);
    const prograde = v3.normalize(vel);
    // Unit vectors first: crossing the raw position with a near-parallel velocity loses all precision.
    let normal = v3.cross(v3.normalize(s.r), prograde);
    normal = v3.len(normal) < 1e-6 ? v3.anyOrthogonal(prograde) : v3.normalize(normal);
    return { prograde, normal, radialOut: v3.cross(prograde, normal) };
  }

  private holdDirection(mode: SasMode): Vec3 | null {
    const f = this.frameDirs(this.ut);
    switch (mode) {
      case 'prograde':
        return f.prograde;
      case 'retrograde':
        return v3.neg(f.prograde);
      case 'normal':
        return f.normal;
      case 'antinormal':
        return v3.neg(f.normal);
      case 'radialOut':
        return f.radialOut;
      case 'radialIn':
        return v3.neg(f.radialOut);
      case 'maneuver':
        return this.nodeDvRoot(this.nodes[0]) ?? null;
      default:
        return null;
    }
  }

  private nodeDvRoot(node: ManeuverNode | undefined): Vec3 | null {
    if (!node || this.spec.kind !== 'orbit') return null;
    const s = this.vesselState(node.ut);
    const p = v3.normalize(s.v);
    const n = v3.normalize(v3.cross(s.r, s.v));
    const ro = v3.cross(p, n);
    const dv = v3.add(v3.add(v3.scale(p, node.dv.prograde), v3.scale(n, node.dv.normal)), v3.scale(ro, node.dv.radial));
    return v3.len(dv) > 1e-6 ? v3.normalize(dv) : null;
  }

  private enu(ut: number): { e: Vec3; n: Vec3; u: Vec3 } {
    const s = this.vesselState(ut);
    const u = v3.normalize(s.r);
    let e = v3.cross(v3.unitZ(), u);
    e = v3.len(e) < 1e-9 ? v3.unitY() : v3.normalize(e);
    return { e, n: v3.cross(u, e), u };
  }

  private initialAttitude(): Quat {
    const { e, u } = this.enu(this.ut);
    if (this.spec.kind === 'surface') {
      // Nose up (also under parachutes: the lines leave at the apex and the heat shield faces the ground),
      // ventral (-Z) facing east; X = Y x Z keeps the frame right-handed.
      const y = u;
      const z = v3.neg(e);
      return quat.fromBasis(v3.cross(y, z), y, z);
    }
    const f = this.frameDirs(this.ut);
    const y = this.spec.plasma !== undefined ? v3.neg(f.prograde) : f.prograde;
    const z = v3.normalize(v3.reject(u, y));
    return quat.fromBasis(v3.cross(y, z), y, z);
  }

  // ---------------------------------------------------------------------------------------------- snapshot

  private patchFor(conic: ConicElements, bodyId: string, tStart: number, rStart: Vec3, afterNodeId?: string): Patch {
    const body = this.body(bodyId);
    const nuStart = conicTrueAnomaly(conic, rStart);
    const closed = conic.period !== null;
    const tEnd = closed ? tStart + conic.period! : tStart + 5 * 86400;
    const { rp, ra } = conicApsides(conic);
    const markers: Marker[] = [];
    const tPe = tStart + (closed ? this.timeToNu(conic, nuStart, 0) : 0);
    if (closed) {
      markers.push({ kind: 'periapsis', ut: tPe, bodyId, r: conicPosition(conic, 0), altitude: rp - body.radius });
      markers.push({ kind: 'apoapsis', ut: tStart + this.timeToNu(conic, nuStart, Math.PI), bodyId, r: conicPosition(conic, Math.PI), altitude: ra - body.radius });
    }
    return {
      bodyId,
      conic,
      tStart,
      tEnd,
      nuStart,
      nuEnd: closed ? nuStart + TWO_PI : nuStart + 2,
      endReason: closed ? 'closed' : 'horizon',
      afterNodeId,
      bodyPosAtEnd: this.bodyStateRoot(bodyId, tEnd).r,
      markers,
    };
  }

  private timeToNu(conic: ConicElements, nuFrom: number, nuTo: number): number {
    let dt = timeSincePeriapsis(conic, nuTo) - timeSincePeriapsis(conic, nuFrom);
    if (conic.period !== null) dt = ((dt % conic.period) + conic.period) % conic.period;
    return dt;
  }

  /** Scenario landing target, the site and its recovery zones as SurfaceTargets. */
  private surfaceTargets(): SurfaceTarget[] {
    const out: SurfaceTarget[] = [];
    const l = this.scenario.suggestedLanding;
    if (l) out.push({ id: 'landing', name: l.name, bodyId: l.bodyId, kind: 'landing', latitude: l.latDeg * DEG, longitude: l.lonDeg * DEG, radius: 0 });
    const site = this.defs.sites[this.scenario.site];
    if (site) {
      out.push({ id: `site:${site.id}`, name: site.name, bodyId: site.bodyId, kind: 'site', latitude: site.location.latDeg * DEG, longitude: site.location.lonDeg * DEG, radius: site.pad.flatRadius });
      site.recoveryZones.forEach((z, i) =>
        out.push({ id: `recovery:${i}`, name: z.name, bodyId: site.bodyId, kind: 'recovery', latitude: z.latDeg * DEG, longitude: z.lonDeg * DEG, radius: z.radiusKm * 1000 }),
      );
    }
    return out;
  }

  /** Range/bearing from the sub-point to the nearest landing or recovery target on the scene body (no prediction: fake). */
  private landingTargetReadout(targets: SurfaceTarget[], subDir: Vec3, groundTrackDir: Vec3 | null, radius: number): Readouts['landingTarget'] {
    let best: { t: SurfaceTarget; angle: number; dir: Vec3 } | null = null;
    for (const t of targets) {
      if (t.bodyId !== this.spec.bodyId || t.kind === 'site') continue;
      const dir = latLonToDir(t.latitude, t.longitude);
      const angle = v3.angle(subDir, dir);
      if (!best || angle < best.angle) best = { t, angle, dir };
    }
    if (!best) return null;
    // Local east/north at the sub-point in the body-fixed frame.
    let east = v3.cross(v3.unitZ(), subDir);
    east = v3.len(east) < 1e-9 ? v3.unitY() : v3.normalize(east);
    const north = v3.cross(subDir, east);
    const toTarget = v3.reject(best.dir, subDir);
    const hasDir = v3.len(toTarget) > 1e-12;
    const tHat = hasDir ? v3.normalize(toTarget) : north;
    const bearingDeg = ((Math.atan2(v3.dot(tHat, east), v3.dot(tHat, north)) / DEG) + 360) % 360;
    const distance = best.angle * radius;
    let downRange = 0;
    let crossRange = 0;
    if (groundTrackDir && hasDir) {
      const right = v3.cross(groundTrackDir, subDir);
      downRange = distance * v3.dot(tHat, groundTrackDir);
      crossRange = distance * v3.dot(tHat, right);
    }
    return { targetId: best.t.id, distance, bearingDeg, downRange, crossRange, predicted: null };
  }

  private buildParts(pressure: number): PartSnapshot[] {
    return this.parts.map((p) => {
      const def = this.defs.parts[p.def];
      const modules = p.modules.map((m, i): ModuleState => {
        const md = def?.modules[i];
        if (m.type === 'engine' && md?.type === 'engine') {
          const thr = m.active ? this.throttleActual : 0;
          const isp = md.ispVac - (md.ispVac - md.ispSL) * (pressure / 101325);
          const massFlow = (thr * md.thrustVac) / (md.ispVac * G0);
          return {
            ...m,
            throttleActual: thr,
            massFlow,
            thrust: Math.max(0, massFlow * G0 * isp),
            ambientPressure: pressure,
            pressureRatio: Math.min(1e6, (md.nozzles[0]?.exitPressure ?? 1e4) / Math.max(pressure, 1e-3)),
            // Engines that staging has not activated keep the clocks they were given.
            ...(m.active ? { ignitionAge: this.ignitionAge, shutdownAge: this.shutdownAge } : {}),
          };
        }
        if (m.type === 'legs') return { ...m, deploy: this.legsDeployed ? 1 : 0 };
        if (m.type === 'light') return { ...m, on: this.lightsOn };
        return m;
      });
      return { ...p, modules };
    });
  }

  snapshot(): SimSnapshot {
    const snap = this.peek();
    this.events = [];
    return snap;
  }

  peek(): SimSnapshot {
    const ut = this.ut;
    const root = this.defs.rootBodyId;
    const star = Object.values(this.defs.bodies).find((b) => b.emission !== null);
    const starPos = star ? this.bodyStateRoot(star.id, ut).r : v3.new(1.5e11, 0, 0);
    const bodies: BodySnapshot[] = Object.values(this.defs.bodies).map((b) => {
      const s = this.bodyStateRoot(b.id, ut);
      const o = this.bodyOrientation(b.id, ut);
      const toSun = v3.sub(starPos, s.r);
      return {
        id: b.id,
        rRoot: s.r,
        vRoot: s.v,
        qFixedToRoot: o.q,
        spinRoot: o.spin,
        sunDir: b.id === star?.id ? v3.unitX() : v3.normalize(toSun),
        sunDistance: v3.len(toSun),
        orbit: b.orbit?.kind === 'kepler' ? s.conic : null,
        soiRadius: typeof b.soiRadius === 'number' ? b.soiRadius : null,
      };
    });

    const body = this.body(this.spec.bodyId);
    const bodyState = this.bodyStateRoot(body.id, ut);
    const st = this.vesselState(ut);
    const vSurf = this.surfaceVelocity(ut);
    const { e, n, u } = this.enu(ut);
    const hasAir = body.atmosphere !== null && st.altitude < body.atmosphere.simTop;
    const pressure = hasAir ? 101325 * Math.exp(-st.altitude / 7200) : 0;
    const density = hasAir ? 1.225 * Math.exp(-st.altitude / 7200) : 0;
    const speedSurf = v3.len(vSurf);
    const q = 0.5 * density * speedSurf * speedSurf;
    const parts = this.buildParts(pressure);
    let thrust = 0;
    for (const p of parts) for (const m of p.modules) if (m.type === 'engine') thrust += m.thrust;
    if (parts.length === 0) thrust = this.throttleActual * 2.0e6;
    const mass = 50000;
    const landed = this.spec.kind === 'surface' && (this.spec.climbRate ?? 0) === 0;
    const nose = quat.rotate(this.q, v3.unitY());

    const frame = this.frameDirs(ut);
    const toVes = (d: Vec3): Vec3 => quat.rotateInv(this.q, d);
    const maneuverDir = this.nodeDvRoot(this.nodes[0]);
    const targetDir = this.targetBodyId && this.defs.bodies[this.targetBodyId] ? v3.normalize(v3.sub(this.bodyStateRoot(this.targetBodyId, ut).r, v3.add(bodyState.r, st.r))) : null;
    const markers: NavballMarkers = {
      prograde: toVes(frame.prograde),
      retrograde: toVes(v3.neg(frame.prograde)),
      normal: toVes(frame.normal),
      antinormal: toVes(v3.neg(frame.normal)),
      radialOut: toVes(frame.radialOut),
      radialIn: toVes(v3.neg(frame.radialOut)),
      maneuver: maneuverDir ? toVes(maneuverDir) : null,
      target: targetDir ? toVes(targetDir) : null,
      antiTarget: targetDir ? toVes(v3.neg(targetDir)) : null,
      liftVector: this.spec.plasma !== undefined ? v3.unitZ() : null,
    };
    const qHorizonToRoot = quat.fromBasis(e, n, u);
    const qVesselToHorizon = quat.mul(quat.conj(qHorizonToRoot), this.q);
    // Angle conventions of NavballState (contracts/sim.ts), the same as the real navball's.
    const sinPitch = clamp(v3.dot(nose, u), -1, 1);
    const pitchDeg = Math.asin(sinPitch) / DEG;
    const dorsal = quat.rotate(this.q, v3.unitZ());
    let horiz = v3.reject(nose, u);
    let upRef: Vec3;
    if (v3.len(horiz) > 1e-9) {
      upRef = v3.normalize(v3.reject(u, nose));
    } else {
      // Nose vertical: the heading is that of the ventral side and the roll is 0.
      horiz = v3.reject(sinPitch >= 0 ? v3.neg(dorsal) : dorsal, u);
      upRef = dorsal;
    }
    const headingDeg = ((Math.atan2(v3.dot(horiz, e), v3.dot(horiz, n)) / DEG) + 360) % 360;
    // Positive roll = rotation about +Y (the nose): the dorsal side tips toward starboard = cross(nose, upRef).
    const rollDeg = Math.atan2(v3.dot(dorsal, v3.cross(nose, upRef)), v3.dot(dorsal, upRef)) / DEG;

    const conic = landed ? null : conicFromState(body.mu, st.r, st.v, ut);
    const aps = conic ? conicApsides(conic) : { rp: body.radius, ra: body.radius };
    const current: Patch[] = conic && this.spec.kind === 'orbit' ? [this.patchFor(conic, body.id, ut, st.r)] : [];
    const planned: Patch[] = [];
    const node = this.nodes[0];
    if (node && this.spec.kind === 'orbit') {
      const ns = this.vesselState(node.ut);
      const p = v3.normalize(ns.v);
      const nn = v3.normalize(v3.cross(ns.r, ns.v));
      const ro = v3.cross(p, nn);
      const v2 = v3.add(ns.v, v3.add(v3.add(v3.scale(p, node.dv.prograde), v3.scale(nn, node.dv.normal)), v3.scale(ro, node.dv.radial)));
      planned.push(this.patchFor(conicFromState(body.mu, ns.r, v2, node.ut), body.id, node.ut, ns.r, node.id));
      current[0]?.markers.push({ kind: 'maneuverNode', ut: node.ut, bodyId: body.id, r: ns.r, nodeId: node.id });
    }
    const dvMag = node ? Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial) : 0;

    const verticalSpeed = v3.dot(vSurf, u);
    const gLocal = body.mu / v3.lenSq(st.r);
    const qFixedToRoot = this.bodyOrientation(body.id, ut).q;
    const subDir = quat.rotateInv(qFixedToRoot, u);
    const subLatLon = dirToLatLon(subDir);
    const vHorizontal = v3.reject(vSurf, u);
    const groundTrackDir = v3.len(vHorizontal) > 0.1 ? quat.rotateInv(qFixedToRoot, v3.normalize(vHorizontal)) : null;
    const surfaceTargets = this.surfaceTargets();
    const readouts: Readouts = {
      met: Math.max(0, ut - this.ut0),
      altitudeAsl: st.altitude,
      altitudeRadar: this.ground && this.spec.kind === 'surface' ? st.altitude - this.ground.originHeight - this.ground.height : st.altitude,
      latitude: subLatLon.lat,
      longitude: subLatLon.lon,
      speedOrbital: v3.len(st.v),
      speedSurface: speedSurf,
      verticalSpeed,
      horizontalSpeed: Math.sqrt(Math.max(0, speedSurf * speedSurf - verticalSpeed * verticalSpeed)),
      apoapsisAltitude: aps.ra - body.radius,
      periapsisAltitude: aps.rp - body.radius,
      timeToApoapsis: conic?.period ? this.timeToNu(conic, conicTrueAnomaly(conic, st.r), Math.PI) : null,
      timeToPeriapsis: conic?.period ? this.timeToNu(conic, conicTrueAnomaly(conic, st.r), 0) : null,
      inclination: conic?.inc ?? 0,
      eccentricity: conic?.e ?? 0,
      period: conic?.period ?? null,
      throttle: this.controls.throttle,
      thrust,
      twr: thrust / (mass * gLocal),
      mass,
      gLoad: landed ? gLocal / G0 : thrust / (mass * G0) + (this.spec.plasma !== undefined ? 4.5 : 0),
      gDose: 0,
      gDoseLimit: 15,
      dynamicPressure: q,
      mach: hasAir ? speedSurf / 300 : 0,
      angleOfAttack: speedSurf > 1 ? v3.angle(nose, vSurf) : 0,
      heatFlux: (this.spec.plasma ?? 0) * 2.5e6,
      ablatorFraction: this.spec.plasma !== undefined ? 0.8 : null,
      maxTempFraction: this.spec.plasma !== undefined ? 0.55 : 0.15,
      sasEnabled: this.sasEnabled,
      sasMode: this.sasMode,
      sasModesAvailable: ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', ...(node ? (['maneuver'] as SasMode[]) : [])],
      rcsEnabled: this.rcsEnabled,
      fineControl: this.fineControl,
      legsDeployed: this.legsDeployed,
      lightsOn: this.lightsOn,
      chuteEnvelope: this.spec.chutes ? 'safe' : null,
      rcsFraction: 0.9,
      deltaVTotal: 3000,
      targetBodyId: this.targetBodyId,
      targetRelativeInclination: this.targetBodyId ? 0.01 : null,
      targetClosestApproach: null,
      launchWindow: landed && body.id === root && this.targetBodyId ? { timeToPlaneCrossing: 600 - ((ut - this.ut0) % 600), launchAzimuthDeg: 81 } : null,
      nodeBurn: node ? { nodeId: node.id, dvRemaining: v3.scale(maneuverDir ?? v3.unitX(), dvMag), dvRemainingMag: dvMag, burnTime: dvMag / 10, timeToBurnStart: node.ut - ut - dvMag / 20, timeToNode: node.ut - ut, insufficientDeltaV: false } : null,
      liftVectorUp: this.spec.plasma !== undefined ? v3.dot(dorsal, u) > 0 : null,
      tiltFromVertical: v3.angle(nose, u),
      landingTarget: this.landingTargetReadout(surfaceTargets, subDir, groundTrackDir, body.radius),
    };

    const stages: StageInfo[] = this.stageLabels.map((label, i) => ({
      label,
      icon: i === this.stageLabels.length - 1 ? 'parachute' : 'engine',
      fired: i < this.nextStage,
      deltaVVac: 3000,
      deltaVNow: 2800,
      twr: 1.3,
      burnTime: 160,
      propellantFraction: i < this.nextStage ? 1 - this.throttleActual * 0.5 : 1,
      actionKinds: ['engine'],
    }));

    const vessel: VesselSnapshot = {
      id: 'fake-vessel',
      name: 'Fake vessel',
      vehicleId: this.scenario.vehicle,
      controllable: true,
      tier: 'full',
      situation: landed ? (body.id === root && this.nextStage === 0 ? 'prelaunch' : 'landed') : this.spec.kind === 'orbit' && !hasAir ? 'orbiting' : 'flying',
      translationMode: landed ? 'landed' : this.needsIntegration ? 'integrated' : 'rails',
      bodyId: body.id,
      r: st.r,
      v: st.v,
      rRoot: v3.add(bodyState.r, st.r),
      vRoot: v3.add(bodyState.v, st.v),
      q: quat.clone(this.q),
      w: v3.clone(this.w),
      mass,
      comLocal: v3.zero(),
      boundingRadius: 55,
      parts,
      aero: {
        q,
        mach: readouts.mach,
        aoa: readouts.angleOfAttack,
        airDensity: density,
        pressure,
        temperature: hasAir ? 250 : 4,
        airVelocity: vSurf,
        heatFlux: readouts.heatFlux,
        plasmaIntensity: this.spec.plasma ?? 0,
      },
      gLoad: readouts.gLoad,
      properAccel: v3.new(0, thrust / mass, 0),
      contact: { anyContact: landed, maxForce: landed ? mass * gLocal : 0, waterSubmersion: 0 },
      sunVisibility: 1,
      thrust,
      age: ut - this.ut0,
    };

    const events = this.events.slice();
    return {
      ut,
      simUt: ut,
      tick: this.tick,
      warp: { index: this.warpIndex, factor: WARP_LEVELS[this.warpIndex]!, maxIndex: this.maxWarpIndex(), limitedBy: this.needsIntegration ? 'under acceleration or in atmosphere' : null, onRails: !this.needsIntegration },
      scenario: { id: this.scenario.id, startKind: this.scenario.start.kind, stagesAlreadyFired: 0 },
      surfaceTargets,
      terrain: { complete: true, pending: false, incompleteQueries: 0 },
      bodies,
      starId: star?.id ?? root,
      vessels: [vessel],
      activeVesselId: vessel.id,
      appliedControls: { ...this.controls, translate: v3.clone(this.controls.translate) },
      navball: { mode: this.navballMode, qVesselToHorizon, markers, pitchDeg, headingDeg, rollDeg },
      readouts,
      staging: { nextStage: this.nextStage, stages, lockout: false },
      patches: { current, planned },
      nodes: this.nodes.map((x) => ({ id: x.id, ut: x.ut, dv: { ...x.dv } })),
      events,
      milestones: [],
      mission: { failed: false, failureReason: null, crewAlive: true },
      cheatCounter: this.cheatCounter,
    };
  }
}

export const createFakeSim = (defs: DefLibrary, opts: FakeSimOptions): Sim => new FakeSim(defs, opts);
