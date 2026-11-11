/**
 * AudioFrame builders for the audio lab, its offline acceptance checks and the listen-proof clips.
 * A FakeSim scene provides a consistent snapshot (bodies, vessel, readouts); the lab overrides what the
 * FakeSim does not simulate (engine module states of real parts from labVehicle.ts, aero state, g-load,
 * events, surface contact) and places the listener. Pure TypeScript: also used by the vitest model tests.
 */
import type { AudioFrame, AudioListener } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ViewKind } from '@/core/contracts/render';
import type { PartSnapshot, Readouts, SimEvent, SimSnapshot, VesselAeroState, VesselSituation, VesselSnapshot, WarpState } from '@/core/contracts/sim';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { isFixedBurn, LabEngines, labStack, type LabStackId } from './labVehicle';

export const SEA_LEVEL = 101325;
/** Speed of sound the lab converts a scripted Mach number with (data/defs/audio/mix.json speedOfSound). */
export const LAB_SOUND_SPEED = 340;

export interface SceneState {
  parts: PartSnapshot[];
  aero: Partial<VesselAeroState>;
  /**
   * Air-relative velocity of the vessel in its own VES axes, m/s. When omitted and `aero.mach` is given,
   * the vessel flies nose first (+Y) at mach x LAB_SOUND_SPEED; otherwise the FakeSim's value is kept.
   */
  airVelocityVes: Vec3;
  gLoad: number;
  sunVisibility: number;
  situation: VesselSituation;
  /** 0..1 submerged volume fraction (floating after splashdown). */
  waterSubmersion: number;
  events: SimEvent[];
  readouts: Partial<Readouts>;
  mission: Partial<SimSnapshot['mission']>;
  warp: Partial<WarpState>;
  boundingRadius: number;
  /** Centre of mass in VES (the FakeSim's is the origin). */
  comLocal: Vec3;
  extraVessels: VesselSnapshot[];
}

export function baseSnapshot(lib: DefLibrary, scene: FakeScene): SimSnapshot {
  return createFakeSim(lib, { scene }).snapshot();
}

/** A copy of `base` with the lab's overrides applied to the active vessel. */
export function compose(base: SimSnapshot, s: Partial<SceneState>, t: number, tick: number): SimSnapshot {
  const v = base.vessels[0]!;
  const aero: VesselAeroState = { ...v.aero, ...s.aero };
  if (s.airVelocityVes) aero.airVelocity = quat.rotate(v.q, s.airVelocityVes);
  else if (s.aero?.mach !== undefined) aero.airVelocity = quat.rotate(v.q, { x: 0, y: s.aero.mach * LAB_SOUND_SPEED, z: 0 });
  const vessel: VesselSnapshot = {
    ...v,
    parts: s.parts ?? v.parts,
    aero,
    gLoad: s.gLoad ?? v.gLoad,
    sunVisibility: s.sunVisibility ?? v.sunVisibility,
    situation: s.situation ?? v.situation,
    contact: { ...v.contact, waterSubmersion: s.waterSubmersion ?? v.contact.waterSubmersion },
    boundingRadius: s.boundingRadius ?? v.boundingRadius,
    comLocal: s.comLocal ?? v3.zero(),
  };
  return {
    ...base,
    ut: base.ut + t,
    simUt: base.ut + t,
    tick,
    vessels: [vessel, ...(s.extraVessels ?? [])],
    events: s.events ?? [],
    readouts: { ...base.readouts, ...s.readouts, gLoad: s.gLoad ?? base.readouts.gLoad },
    mission: { ...base.mission, ...s.mission },
    warp: { ...base.warp, onRails: false, ...s.warp },
  };
}

export interface ListenerSpec {
  kind: ViewKind;
  mode: string;
  /** Position in VES. */
  position: Vec3;
  /** Point the listener looks at (external) - the interior listener looks along +Y with +Z up. */
  lookAt?: Vec3;
  pressure: number;
  insideVesselId?: string | null;
  /** External listeners: the vessel the camera follows. Default: the active vessel for mode 'chase' and unknown flight rigs, none for kind 'map'; pass null for a ground-fixed camera. */
  attachedVesselId?: string | null;
}

export function listener(spec: ListenerSpec, activeVesselId: string): AudioListener {
  if (spec.kind === 'interior') {
    return { mode: spec.mode, kind: 'interior', insideVesselId: spec.insideVesselId ?? activeVesselId, attachedVesselId: null, positionVes: spec.position, forwardVes: v3.unitY(), upVes: v3.unitZ(), ambientPressure: spec.pressure };
  }
  const target = spec.lookAt ?? v3.zero();
  let fwd = v3.sub(target, spec.position);
  fwd = v3.len(fwd) < 1e-6 ? v3.unitY() : v3.normalize(fwd);
  let up = v3.reject(v3.unitY(), fwd);
  up = v3.len(up) < 1e-6 ? v3.unitZ() : v3.normalize(up);
  const attachedVesselId = spec.attachedVesselId !== undefined ? spec.attachedVesselId : spec.kind === 'external' ? activeVesselId : null;
  return { mode: spec.mode, kind: spec.kind, insideVesselId: spec.insideVesselId ?? null, attachedVesselId, positionVes: spec.position, forwardVes: fwd, upVes: up, ambientPressure: spec.pressure };
}

/** External listener `distance` m from the stack's engine plane, at height `height`, on azimuth `az` (rad). */
export function externalAt(distance: number, opts: { height?: number; az?: number; mode?: string; kind?: ViewKind; pressure?: number; lookY?: number } = {}): ListenerSpec {
  const az = opts.az ?? 0.6;
  const h = opts.height ?? 2;
  const horizontal = Math.sqrt(Math.max(0, distance * distance - h * h));
  return {
    kind: opts.kind ?? 'external',
    mode: opts.mode ?? 'chase',
    position: { x: horizontal * Math.sin(az), y: h, z: horizontal * Math.cos(az) },
    lookAt: { x: 0, y: opts.lookY ?? 20, z: 0 },
    pressure: opts.pressure ?? SEA_LEVEL,
  };
}

export function seatOf(lib: DefLibrary, stack: LabStackId): Vec3 {
  return labStack(lib, stack).seat;
}

/** A lab stack's engines (real part definitions), synthesised every frame. */
export function labEngines(lib: DefLibrary, stack: LabStackId): LabEngines {
  return new LabEngines(labStack(lib, stack).parts, lib.parts);
}

/**
 * Throttleable engines already running steadily at a throttle LEVER (no transient): staged, then spooled
 * for 10 s through the sim's law, so throttleActual = minThrottle + (1 - minThrottle) lever. Fixed-burn
 * solids stay unlit.
 */
export function steadyEngines(lib: DefLibrary, stack: LabStackId, lever: number, filter: (instanceId: string, def: string) => boolean = () => true): LabEngines {
  const e = labEngines(lib, stack);
  e.activate((p) => filter(p.instanceId, p.def) && !isFixedBurn(lib, p.def));
  for (let i = 0; i < 600; i++) e.step(1 / 60, lever);
  return e;
}

export type FrameFn = (t: number, dt: number) => AudioFrame;

export interface Script {
  name: string;
  duration: number;
  frame: FrameFn;
}

interface FrameOpts {
  base: SimSnapshot;
  listen: (t: number) => ListenerSpec;
  state: (t: number, dt: number) => Partial<SceneState>;
  warpFactor?: (t: number) => number;
  paused?: (t: number) => boolean;
}

export function frames(o: FrameOpts): FrameFn {
  let tick = 0;
  return (t, dt) => {
    const snapshot = compose(o.base, o.state(t, dt), t, tick++);
    return { snapshot, listener: listener(o.listen(t), snapshot.activeVesselId), realDt: dt, warpFactor: o.warpFactor?.(t) ?? 1, paused: o.paused?.(t) ?? false };
  };
}

/** An event of the given type for the active vessel, with plausible payload fields. */
export function makeEvent(type: SimEvent['type'], ut: number, vesselId: string, base: SimSnapshot, extra: Record<string, unknown> = {}): SimEvent {
  const partId = (extra['partId'] as string | undefined) ?? 'capsule';
  const common = { ut, vesselId };
  const v = base.vessels[0]!;
  const e: Record<string, unknown> = { ...common, type, partId };
  switch (type) {
    case 'stageFired':
      Object.assign(e, { stageIndex: 0, label: 'Lab stage' });
      break;
    case 'decoupled':
    case 'fairingJettisoned':
      Object.assign(e, { newVesselIds: [] });
      break;
    case 'legsToggled':
      Object.assign(e, { deployed: true });
      break;
    case 'chuteDeployed':
      Object.assign(e, { mode: 'drogue' });
      break;
    case 'touchdown':
      Object.assign(e, { speed: 3, surface: 'land' });
      break;
    case 'splash':
      Object.assign(e, { speed: 8 });
      break;
    case 'partDestroyed':
      Object.assign(e, { cause: 'overstress', posVes: { x: 0, y: 1, z: 0 } });
      break;
    case 'explosion':
      Object.assign(e, { posRoot: v3.add(v.rRoot, quat.rotate(v.q, { x: 0, y: 1, z: 0 })), energy: 1e9 });
      break;
    case 'engineShutdown':
      Object.assign(e, { flameout: false });
      break;
    default:
      break;
  }
  Object.assign(e, extra);
  return e as unknown as SimEvent;
}
