/**
 * createVesselVisualFeature: draws every vessel of the snapshot (the active vehicle, spent stages, fairing
 * petals, launch clamps, debris) from its PartSnapshot poses and module states through the render core's
 * mesh system.
 *
 *  - One model set per part definition, generated once from data/defs/visuals/parts (generator registry).
 *  - Articulation comes from each part visual's `pose`: engine gimbal, leg deployment and stroke, fairing
 *    petals (`<id>#panel<k>`), clamp arms, antennas, lamps, hot nozzle sections, window panes.
 *  - History the snapshot does not carry (nozzle temperature after a burn, soot from firing, frost that
 *    sheds after lift-off, arm retraction) is kept per part instance and survives staging, because part
 *    instance ids do.
 *  - Every vessel instance is a MOVING shadow caster: it is submitted only to cascades that are re-rendered
 *    every frame (ARCHITECTURE 10.1). `stats.staggeredSubmissions` counts violations and stays 0.
 *  - A vessel that the simulation removes as expired is dither-faded over a second instead of popping.
 */
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import type { FrameContext, RenderContext, RenderFeature, ShadowCascadeView } from '@/core/contracts/render';
import type { ModuleState, PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat, v3, type Quat, type Vec3 } from '@/core/math';
import { coreOf, type MeshBatch, type MeshInstance, type ModelHandle } from '@/render/core';
import { generatePart } from './parts';
import { NEUTRAL_ANIM, type PartAnim, type PartVisual, type PoseInput, type PoseOpts } from './parts/types';

export interface VesselVisualOptions {
  /**
   * Draw the opaque outer panes of capsule windows while the camera is outside that vessel (default true).
   * Set false when a cockpit feature shows its interior through its own transparent glazing from outside.
   */
  exteriorGlass?: boolean;
  /** Seconds a removed (expired) vessel takes to fade out (default 1.2). */
  fadeSeconds?: number;
  /** Most local lights this feature registers per frame (default 4 of the core's 16). */
  maxLights?: number;
}

export interface VesselVisualStats {
  vessels: number;
  instances: number;
  /** Triangles submitted to the G-buffer / to shadow cascades in the last frame. */
  triangles: number;
  shadowTriangles: number;
  /** drawShadow calls for staggered cascades (nothing is submitted) and for every-frame cascades. */
  staggeredCascades: number;
  everyFrameCascades: number;
  /** Moving casters submitted to a staggered cascade: must stay 0. */
  staggeredSubmissions: number;
  ghosts: number;
  lights: number;
  /** CPU time of the last instance update, ms. */
  updateMs: number;
}

export interface VesselVisualFeature extends RenderFeature {
  readonly stats: VesselVisualStats;
  /** The generated visual of a part definition (undefined before init or for a part without one). */
  partVisual(defId: string): PartVisual | undefined;
  /** Presentation state of one part instance (labs and tests set it to show a history without waiting). */
  anim(vesselId: string, instanceId: string): PartAnim;
}

interface PartEntry {
  instanceId: string;
  def: PartDef;
  visual: PartVisual;
  handles: Record<string, ModelHandle>;
  anim: PartAnim;
  /** Anim states of the engines mounted on this part (their soot stains it). */
  engineAnims: PartAnim[];
  panel: number | null;
  input: PoseInput;
  seen: boolean;
}

interface VesselPlan {
  key: string;
  entries: PartEntry[];
}

interface Ghost {
  vessel: VesselSnapshot;
  plan: VesselPlan;
  ut0: number;
  t0: number;
}

const rootOf = (vesselId: string): string => {
  const i = vesselId.indexOf('~');
  return i < 0 ? vesselId : vesselId.slice(0, i);
};

const PANEL = /#panel(\d+)$/;

/** Temperature the radiatively cooled nozzle sections settle at for a throttle setting, K. */
export const nozzleEquilibrium = (throttle: number): number => 560 + 900 * Math.sqrt(Math.max(0, Math.min(1, throttle)));

/** One step of the nozzle temperature model: fast heating while firing, T^3-accelerated cooling after. */
export function stepNozzleTemp(T: number, firing: boolean, throttle: number, dt: number): number {
  const ambient = 260;
  if (dt <= 0) return T;
  if (firing) {
    const target = nozzleEquilibrium(throttle);
    return target + (Math.max(T, ambient) - target) * Math.exp(-dt / 2.5);
  }
  // Radiative cooling: time constant grows as the part cools (about 6 s at 1400 K, minutes near 600 K).
  let t = Math.max(T, ambient);
  let left = dt;
  while (left > 1e-6 && t > ambient + 1) {
    const tau = 6 * Math.pow(1400 / t, 3);
    const h = Math.min(left, tau * 0.25);
    t = ambient + (t - ambient) * Math.exp(-h / tau);
    left -= h;
  }
  return t;
}

export function createVesselVisualFeature(options: VesselVisualOptions = {}): VesselVisualFeature {
  const exteriorGlass = options.exteriorGlass ?? true;
  const fadeSeconds = options.fadeSeconds ?? 1.2;
  const maxLights = options.maxLights ?? 4;

  let ctx: RenderContext;
  let defs: DefLibrary;
  let batch: MeshBatch;
  const visuals = new Map<string, { visual: PartVisual; handles: Record<string, ModelHandle> }>();
  const anims = new Map<string, PartAnim>();
  const plans = new Map<string, VesselPlan>();
  const enginesOn = new Map<string, Map<string, string[]>>();
  const reported = new Set<string>();
  let ghosts: Ghost[] = [];
  let lastUt = Number.NaN;
  const stats: VesselVisualStats = {
    vessels: 0,
    instances: 0,
    triangles: 0,
    shadowTriangles: 0,
    staggeredCascades: 0,
    everyFrameCascades: 0,
    staggeredSubmissions: 0,
    ghosts: 0,
    lights: 0,
    updateMs: 0,
  };

  const visualOf = (defId: string): { visual: PartVisual; handles: Record<string, ModelHandle> } | null => {
    const hit = visuals.get(defId);
    if (hit) return hit;
    const def = defs.parts[defId];
    if (!def?.visual) {
      if (!reported.has(defId)) {
        reported.add(defId);
        coreOf(ctx).reportError(`vehicle: part "${defId}" has no visual definition`);
      }
      return null;
    }
    const visual = generatePart(defs, def);
    const handles: Record<string, ModelHandle> = {};
    const meshes = coreOf(ctx).meshes;
    for (const [name, model] of Object.entries(visual.models)) handles[name] = meshes.createModel(model, model.lodPixels ? { lodPixels: model.lodPixels } : {});
    const entry = { visual, handles };
    visuals.set(defId, entry);
    return entry;
  };

  /** Instance ids of the engine parts mounted on each part of a vehicle definition. */
  const engineChildren = (vehicle: VehicleDef | undefined): Map<string, string[]> => {
    if (!vehicle) return new Map();
    let m = enginesOn.get(vehicle.id);
    if (m) return m;
    m = new Map();
    for (const p of vehicle.parts) {
      if (p.parent === null) continue;
      const d = defs.parts[p.def];
      if (!d?.modules.some((x) => x.type === 'engine')) continue;
      const list = m.get(p.parent) ?? [];
      list.push(p.id);
      m.set(p.parent, list);
    }
    enginesOn.set(vehicle.id, m);
    return m;
  };

  const animOf = (root: string, instanceId: string): PartAnim => {
    const key = `${root}|${instanceId}`;
    let a = anims.get(key);
    if (!a) {
      a = { ...NEUTRAL_ANIM, frost: -1 };
      anims.set(key, a);
    }
    return a;
  };

  const planKey = (parts: readonly PartSnapshot[]): string => (parts.length === 0 ? '0' : `${parts.length}|${parts[0]!.instanceId}|${parts[parts.length - 1]!.instanceId}`);

  const buildPlan = (vessel: VesselSnapshot): VesselPlan => {
    const root = rootOf(vessel.id);
    const children = engineChildren(defs.vehicles[vessel.vehicleId]);
    const entries: PartEntry[] = [];
    for (const part of vessel.parts) {
      const v = visualOf(part.def);
      if (!v) continue;
      const def = defs.parts[part.def]!;
      const match = PANEL.exec(part.instanceId);
      const base = match ? part.instanceId.slice(0, match.index) : part.instanceId;
      const anim = animOf(root, part.instanceId);
      const engineAnims = (children.get(base) ?? []).map((id) => animOf(root, id));
      const panel = match ? Number(match[1]) : null;
      entries.push({ instanceId: part.instanceId, def, visual: v.visual, handles: v.handles, anim, engineAnims, panel, input: { def, modules: part.modules, panel, anim }, seen: false });
    }
    return { key: planKey(vessel.parts), entries };
  };

  /** Advance the presentation state of one part from its module states. */
  const updateAnim = (e: PartEntry, part: PartSnapshot, vessel: VesselSnapshot, dt: number): void => {
    const a = e.anim;
    const first = !e.seen && a.frost < 0;
    let firing = false;
    let throttle = 0;
    let hasEngine = false;
    let clampReleased: boolean | null = null;
    let antenna: boolean | null = null;
    let lamp: boolean | null = null;
    let char = 0;
    const modules: readonly ModuleState[] = part.modules;
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i]!;
      switch (m.type) {
        case 'engine':
          hasEngine = true;
          if (m.thrust > 0 || m.throttleActual > 0.02) {
            firing = true;
            throttle = Math.max(throttle, m.throttleActual);
          }
          break;
        case 'launchClamp':
          clampReleased = m.released;
          break;
        case 'antenna':
          antenna = m.deployed;
          break;
        case 'light':
          lamp = m.on;
          break;
        case 'heatShield':
          char = Math.max(char, Math.min(1, (1 - m.ablatorFraction) / 0.3));
          break;
        default:
          break;
      }
    }
    const prelaunch = vessel.situation === 'prelaunch';
    if (first) {
      // First sight: take the state as it is (no animation from a made-up past).
      a.frost = prelaunch ? 1 : 0;
      a.clamp = clampReleased ? 1 : 0;
      a.antenna = antenna ? 1 : 0;
      a.lamp = lamp ? 1 : 0;
    }
    e.seen = true;
    if (hasEngine) {
      a.nozzleTemp = stepNozzleTemp(a.nozzleTemp, firing, throttle, dt);
      if (firing) a.soot = Math.min(1, a.soot + (dt * (0.4 + 0.6 * throttle)) / 60);
    }
    for (const ea of e.engineAnims) if (ea.soot > a.soot) a.soot = ea.soot;
    // Aerodynamic heating scorches the skin for good.
    const heat = part.maxTemp > 0 ? (part.tempSkin / part.maxTemp - 0.5) / 0.4 : 0;
    const scorch = Math.max(char, Math.min(1, Math.max(0, heat)));
    if (scorch > a.soot) a.soot = scorch;
    const ease = (cur: number, target: number, seconds: number): number => {
      if (dt <= 0 || cur === target) return cur;
      const step = dt / seconds;
      return target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
    };
    // Frost sheds within about half a minute of leaving the pad (vibration, airflow, warming skin).
    a.frost = prelaunch ? ease(a.frost, 1, 30) : a.frost * Math.exp(-dt / 9);
    if (clampReleased !== null) a.clamp = ease(a.clamp, clampReleased ? 1 : 0, 1.4);
    if (antenna !== null) a.antenna = ease(a.antenna, antenna ? 1 : 0, 5);
    if (lamp !== null) a.lamp = ease(a.lamp, lamp ? 1 : 0, 0.2);
  };

  const tmpPos: Vec3 = v3.zero();
  const lightBudget = { n: 0 };

  const drawVessel = (frame: FrameContext, vessel: VesselSnapshot, plan: VesselPlan, parent: { originRelCam: Vec3; q: Quat; prevOriginRelCam: Vec3; prevQ: Quat }, fade: number, dt: number, live: boolean): void => {
    const showGlass = exteriorGlass && frame.camera.insideVesselId !== vessel.id;
    const parts = vessel.parts;
    let pi = 0;
    for (const e of plan.entries) {
      // Entries skip parts without a visual; find this entry's snapshot part.
      while (pi < parts.length && parts[pi]!.instanceId !== e.instanceId) pi++;
      const part = parts[pi];
      if (!part) break;
      pi++;
      e.input.modules = part.modules;
      if (live) updateAnim(e, part, vessel, dt);
      const a = e.anim;
      const localPos = part.localPos;
      const localRot = part.localRot;
      const identityRot = localRot.w === 1 || localRot.w === -1;
      e.visual.pose(e.input, (model, pos, rot, opts?: PoseOpts) => {
        if (model === 'glass' && !showGlass) return;
        const handle = e.handles[model];
        if (!handle) throw new Error(`vehicle: part "${e.def.id}" posed an unknown model "${model}"`);
        let p: Vec3 = localPos;
        if (pos) {
          tmpPos.x = pos[0];
          tmpPos.y = pos[1];
          tmpPos.z = pos[2];
          p = identityRot ? v3.add(localPos, tmpPos) : v3.add(localPos, quat.rotate(localRot, tmpPos));
        }
        let q: Quat | null = identityRot ? null : localRot;
        if (rot) {
          const r: Quat = { x: rot[0], y: rot[1], z: rot[2], w: rot[3] };
          q = q ? quat.mul(q, r) : r;
        }
        const inst: MeshInstance = {
          originRelCam: v3.add(parent.originRelCam, quat.rotate(parent.q, p)),
          q: q ? quat.mul(parent.q, q) : parent.q,
          prevOriginRelCam: v3.add(parent.prevOriginRelCam, quat.rotate(parent.prevQ, p)),
          prevQ: q ? quat.mul(parent.prevQ, q) : parent.prevQ,
          bodyFixed: false,
          temperature: Math.max(part.tempSkin, opts?.temperature ?? 0),
          soot: opts?.soot ?? a.soot,
          frost: opts?.frost ?? Math.max(0, a.frost),
          fade,
        };
        if (opts?.castShadow === false) inst.castShadow = false;
        if (opts?.emissive !== undefined) inst.emissiveScale = opts.emissive;
        if (opts?.scale) inst.scale = opts.scale;
        batch.add(handle, inst);
        stats.instances++;
      });
      if (live && a.lamp > 0.01 && e.visual.lights && lightBudget.n < maxLights) {
        for (const l of e.visual.lights(e.input)) {
          if (lightBudget.n >= maxLights) break;
          const pVes = v3.add(localPos, quat.rotate(localRot, v3.fromTuple(l.pos)));
          frame.lights.push({ kind: 'point', posRelCam: v3.add(parent.originRelCam, quat.rotate(parent.q, pVes)), intensity: [l.intensity[0] * a.lamp, l.intensity[1] * a.lamp, l.intensity[2] * a.lamp], range: l.range });
          lightBudget.n++;
        }
      }
    }
  };

  const collectGhosts = (frame: FrameContext, snapshot: SimSnapshot): void => {
    const prev = frame.prevSnapshot;
    if (prev === snapshot || prev.vessels.length === 0) return;
    const now = new Set(snapshot.vessels.map((v) => v.id));
    for (const v of prev.vessels) {
      if (now.has(v.id) || ghosts.some((g) => g.vessel.id === v.id)) continue;
      // Destroyed vessels (impact, burn-up) vanish in their own fireball; everything else fades.
      const removal = snapshot.events.find((ev) => ev.type === 'vesselRemoved' && ev.vesselId === v.id);
      if (removal && removal.type === 'vesselRemoved' && (removal.reason === 'impact' || removal.reason === 'burnedUp')) continue;
      const plan = plans.get(v.id);
      if (plan) ghosts.push({ vessel: v, plan, ut0: prev.ut, t0: frame.realTime });
    }
  };

  const feature: VesselVisualFeature = {
    id: 'vehicle',
    order: 0,
    stats,
    partVisual: (defId) => visuals.get(defId)?.visual,
    anim: (vesselId, instanceId) => animOf(rootOf(vesselId), instanceId),

    init(c) {
      ctx = c;
      defs = c.defs;
      batch = coreOf(c).meshes.createBatch('vehicle');
      // Generate the models of every part a vehicle definition uses, so staging never builds geometry.
      for (const vehicle of Object.values(defs.vehicles)) for (const p of vehicle.parts) visualOf(p.def);
    },

    prepare(frame) {
      const t0 = performance.now();
      ctx.perf.cpuBegin('vehicle.instances');
      const snapshot = frame.snapshot;
      const dt = Number.isFinite(lastUt) ? Math.max(0, Math.min(3600, snapshot.ut - lastUt)) : 0;
      lastUt = snapshot.ut;
      batch.begin(frame);
      stats.instances = 0;
      stats.vessels = 0;
      lightBudget.n = 0;
      collectGhosts(frame, snapshot);
      const alive = new Set<string>();
      for (const vessel of snapshot.vessels) {
        const pose = frame.vesselPose(vessel.id);
        if (!pose) continue;
        alive.add(vessel.id);
        let plan = plans.get(vessel.id);
        if (!plan || plan.key !== planKey(vessel.parts)) {
          plan = buildPlan(vessel);
          plans.set(vessel.id, plan);
        }
        drawVessel(frame, vessel, plan, pose, 1, dt, true);
        stats.vessels++;
      }
      // Expired vessels coast on their last velocity while they dither out.
      if (ghosts.length > 0) {
        const eye = frame.camera.positionRoot;
        const prevEye = frame.prevCamera.positionRoot;
        ghosts = ghosts.filter((g) => frame.realTime - g.t0 < fadeSeconds && !alive.has(g.vessel.id));
        for (const g of ghosts) {
          const age = snapshot.ut - g.ut0;
          const pos = v3.addScaled(g.vessel.rRoot, g.vessel.vRoot, age);
          const prevPos = v3.addScaled(g.vessel.rRoot, g.vessel.vRoot, age - dt);
          const parent = { originRelCam: v3.sub(pos, eye), q: g.vessel.q, prevOriginRelCam: v3.sub(prevPos, prevEye), prevQ: g.vessel.q };
          drawVessel(frame, g.vessel, g.plan, parent, 1 - (frame.realTime - g.t0) / fadeSeconds, 0, false);
        }
      }
      for (const id of plans.keys()) if (!alive.has(id) && !ghosts.some((g) => g.vessel.id === id)) plans.delete(id);
      batch.finish();
      stats.ghosts = ghosts.length;
      stats.lights = lightBudget.n;
      ctx.perf.cpuEnd('vehicle.instances');
      stats.updateMs = performance.now() - t0;
      ctx.perf.counter('vehicle.instances', stats.instances);
    },

    drawGBuffer(_frame, pass) {
      batch.drawGBuffer(pass);
      stats.triangles = batch.stats.triangles;
      ctx.perf.counter('vehicle.triangles', stats.triangles);
    },

    drawShadow(_frame, pass, cascade: ShadowCascadeView) {
      if (!cascade.everyFrame) {
        // Staggered cascades hold body-fixed casters only: a vessel never draws here.
        stats.staggeredCascades++;
        return;
      }
      stats.everyFrameCascades++;
      batch.drawShadow(pass, cascade);
      stats.shadowTriangles = batch.stats.shadowTriangles;
    },

    isIdle: () => coreOf(ctx).meshes.isIdle(),

    dispose() {
      batch.destroy();
      for (const v of visuals.values()) for (const h of Object.values(v.handles)) h.destroy();
      visuals.clear();
      plans.clear();
    },
  };
  return feature;
}
