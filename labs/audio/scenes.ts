/**
 * AudioFrame builders for the audio lab, its offline acceptance checks and the listen-proof clips.
 * A FakeSim scene provides a consistent snapshot (bodies, vessel, readouts); the lab overrides what the
 * FakeSim cannot know yet (engine parts from labVehicle.ts, aero state, g-load, events) and places the
 * listener. Pure TypeScript: also used by the vitest model tests.
 */
import type { AudioFrame, AudioListener } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ViewKind } from '@/core/contracts/render';
import type { PartSnapshot, Readouts, SimEvent, SimSnapshot, VesselAeroState, VesselSnapshot, WarpState } from '@/core/contracts/sim';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { LAB_PART_DEFS, LabEngines, labStack, type LabStackId } from './labVehicle';

export const SEA_LEVEL = 101325;

export interface SceneState {
  parts: PartSnapshot[];
  aero: Partial<VesselAeroState>;
  gLoad: number;
  sunVisibility: number;
  events: SimEvent[];
  readouts: Partial<Readouts>;
  mission: Partial<SimSnapshot['mission']>;
  warp: Partial<WarpState>;
  boundingRadius: number;
  extraVessels: VesselSnapshot[];
}

export function baseSnapshot(lib: DefLibrary, scene: FakeScene): SimSnapshot {
  return createFakeSim(lib, { scene }).snapshot();
}

/** A copy of `base` with the lab's overrides applied to the active vessel. */
export function compose(base: SimSnapshot, s: Partial<SceneState>, t: number, tick: number): SimSnapshot {
  const v = base.vessels[0]!;
  const vessel: VesselSnapshot = {
    ...v,
    parts: s.parts ?? v.parts,
    aero: { ...v.aero, ...s.aero },
    gLoad: s.gLoad ?? v.gLoad,
    sunVisibility: s.sunVisibility ?? v.sunVisibility,
    boundingRadius: s.boundingRadius ?? v.boundingRadius,
    comLocal: v3.zero(),
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
}

export function listener(spec: ListenerSpec, activeVesselId: string): AudioListener {
  if (spec.kind === 'interior') {
    return { mode: spec.mode, kind: 'interior', insideVesselId: spec.insideVesselId ?? activeVesselId, positionVes: spec.position, forwardVes: v3.unitY(), upVes: v3.unitZ(), ambientPressure: spec.pressure };
  }
  const target = spec.lookAt ?? v3.zero();
  let fwd = v3.sub(target, spec.position);
  fwd = v3.len(fwd) < 1e-6 ? v3.unitY() : v3.normalize(fwd);
  let up = v3.reject(v3.unitY(), fwd);
  up = v3.len(up) < 1e-6 ? v3.unitZ() : v3.normalize(up);
  return { mode: spec.mode, kind: spec.kind, insideVesselId: spec.insideVesselId ?? null, positionVes: spec.position, forwardVes: fwd, upVes: up, ambientPressure: spec.pressure };
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

export function seatOf(stack: LabStackId): Vec3 {
  return labStack(stack).seat;
}

/** A lab stack's engines, synthesised every frame. */
export function labEngines(stack: LabStackId): LabEngines {
  return new LabEngines(labStack(stack).parts, LAB_PART_DEFS);
}

/** Engines already running steadily at `throttle` (no ignition transient). */
export function steadyEngines(stack: LabStackId, throttle: number, filter: (instanceId: string, def: string) => boolean = () => true): LabEngines {
  const e = labEngines(stack);
  e.activate((p) => filter(p.instanceId, p.def) && p.def !== 'lab-les-motor' && p.def !== 'lab-sep-motor');
  for (let i = 0; i < 600; i++) e.step(1 / 60, throttle);
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
