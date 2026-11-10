/**
 * Timelines rendered offline by the audio lab: the listen-proof clips (out/audio/*.wav) and the cases the
 * acceptance spec measures. Every script is a pure function of time built on a FakeSim base snapshot.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { PartSnapshot, SimEvent, SimEventType, VesselSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { LAB_PART_DEFS, LabEngines, labStack, type LabPlacement, type LabStackId } from './labVehicle';
import { SEA_LEVEL, baseSnapshot, externalAt, frames, labEngines, makeEvent, seatOf, steadyEngines, type ListenerSpec, type Script } from './scenes';

/** US76-like pressure for the clip scenes, Pa. */
const pressureAt = (h: number): number => SEA_LEVEL * Math.exp(-h / 7400);

function stepEngines(e: LabEngines, last: { t: number }, t: number, throttle: number): void {
  const dt = t - last.t;
  if (dt > 0) e.step(dt, throttle);
  last.t = t;
}

function eventsBetween(list: { t: number; type: SimEventType; extra?: Record<string, unknown> }[], t0: number, t1: number, ut0: number, vesselId: string, base: ReturnType<typeof baseSnapshot>): SimEvent[] {
  return list.filter((e) => e.t > t0 && e.t <= t1).map((e) => makeEvent(e.type, ut0 + e.t, vesselId, base, e.extra));
}

// --------------------------------------------------------------------------------------------- clips

export function clipScripts(lib: DefLibrary): Script[] {
  return [liftoff(lib, 'liftoff-pad'), liftoff(lib, 'liftoff-cabin'), maxQ(lib), staging(lib), vacuumBurn(lib), reentry(lib), chuteDeploy(lib), splashdown(lib)];
}

function liftoff(lib: DefLibrary, name: 'liftoff-pad' | 'liftoff-cabin', mode = 'pad-camera', padPosition: Vec3 = { x: 330, y: 4, z: 300 }): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = labEngines('booster');
  const last = { t: 0 };
  let prev = 0;
  const ignite = 0.6;
  const release = 3.6;
  const height = (t: number): number => (t > release ? 0.5 * 3.0 * (t - release) ** 2 : 0);
  const pad = padPosition;
  return {
    name,
    duration: 10,
    frame: frames({
      base,
      listen: (t): ListenerSpec => {
        const h = height(t);
        if (name === 'liftoff-cabin') return { kind: 'interior', mode: 'cockpit', position: seatOf('booster'), pressure: pressureAt(h) };
        return { kind: 'external', mode, position: v3.sub(pad, { x: 0, y: h, z: 0 }), lookAt: { x: 0, y: 30, z: 0 }, pressure: SEA_LEVEL };
      },
      state: (t) => {
        if (t >= ignite && prev < ignite) e.activate((p) => p.def === 'lab-atlas-9m');
        stepEngines(e, last, t, t >= ignite ? 1 : 0);
        const evs = eventsBetween([{ t: release, type: 'clampsReleased' }], prev, t, base.ut, base.activeVesselId, base);
        prev = t;
        const h = height(t);
        const v = t > release ? 3 * (t - release) : 0;
        return { parts: e.parts(pressureAt(h)), aero: { pressure: pressureAt(h), q: 0.5 * 1.225 * v * v, mach: v / 340 }, gLoad: t > ignite ? 1 + 0.3 * Math.min(1, (t - ignite) / 3) : 1, events: evs, boundingRadius: 55 };
      },
    }),
  };
}

function maxQ(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'ascent');
  const e = steadyEngines('booster', 0.72, (_, def) => def === 'lab-atlas-9m');
  const last = { t: 0 };
  const p = pressureAt(11000);
  return {
    name: 'max-q',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'external', mode: 'chase', position: { x: 28, y: -45, z: 62 }, lookAt: { x: 0, y: 30, z: 0 }, pressure: p }),
      state: (t) => {
        stepEngines(e, last, t, t < 6 ? 0.72 : 1);
        const mach = 0.95 + 0.04 * t;
        return { parts: e.parts(p), aero: { pressure: p, q: 33000 - 150 * (t - 5) ** 2, mach }, gLoad: 1.7 + (t > 6 ? 0.3 : 0), boundingRadius: 55 };
      },
    }),
  };
}

/** Booster engines placed under the upper stack (VES of the upper stack) for the staging clip. */
function boosterUnderUpper(): LabPlacement[] {
  return labStack('booster')
    .parts.filter((p) => p.def === 'lab-atlas-9m')
    .map((p) => ({ ...p, pos: { x: p.pos.x, y: p.pos.y - 47, z: p.pos.z } }));
}

function staging(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'ascent');
  const upper = labStack('upper').parts;
  const booster = boosterUnderUpper();
  const stack = [...booster, ...upper];
  const e = new LabEngines(stack, LAB_PART_DEFS);
  e.activate((p) => p.def === 'lab-atlas-9m');
  for (let i = 0; i < 600; i++) e.step(1 / 60, 1);
  const last = { t: 0 };
  const p = pressureAt(62000);
  const shutdown = 1.8;
  const sep = 2.3;
  const ignite = 3.8;
  let prev = 0;
  const spent: VesselSnapshot = { ...base.vessels[0]!, id: 'spent-booster', name: 'Spent booster', parts: [] };
  return {
    name: 'staging',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf('upper'), pressure: p }),
      state: (t) => {
        if (t >= shutdown && prev < shutdown) e.shutdown((x) => x.def === 'lab-atlas-9m');
        if (t >= sep && prev < sep) e.activate((x) => x.def === 'lab-sep-motor');
        if (t >= ignite && prev < ignite) e.activate((x) => x.def === 'lab-vela-2');
        stepEngines(e, last, t, 1);
        const evs = eventsBetween(
          [
            { t: sep - 0.02, type: 'stageFired' },
            { t: sep, type: 'decoupled', extra: { partId: 'capsule' } },
          ],
          prev,
          t,
          base.ut,
          base.activeVesselId,
          base,
        );
        prev = t;
        const all = e.parts(p);
        const isBooster = (x: PartSnapshot): boolean => x.def === 'lab-atlas-9m';
        let parts = all;
        const extra: VesselSnapshot[] = [];
        if (t >= sep) {
          parts = all.filter((x) => !isBooster(x));
          // The spent stage falls behind: 0.5 * 12 m/s^2 * dt^2 below the upper stack, in its own frame.
          const drop = 0.5 * 12 * (t - sep) ** 2;
          const a = base.vessels[0]!;
          const offsetVes = { x: 0, y: -47 - drop, z: 0 };
          extra.push({ ...spent, rRoot: v3.add(a.rRoot, quat.rotate(a.q, offsetVes)), q: a.q, parts: all.filter(isBooster).map((x) => ({ ...x, localPos: { ...x.localPos, y: x.localPos.y + 47 } })) });
        }
        const g = t < shutdown ? 3.6 : t < ignite ? 0.05 : 0.05 + 0.75 * Math.min(1, (t - ignite) / 1.2);
        return { parts, aero: { pressure: p, q: 120, mach: 6.5 }, gLoad: g, events: evs, boundingRadius: 40, extraVessels: extra };
      },
    }),
  };
}

function vacuumBurn(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'lowOrbit');
  const e = labEngines('tli');
  const last = { t: 0 };
  let prev = 0;
  return {
    name: 'vacuum-burn-cabin',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf('tli'), pressure: 0 }),
      state: (t) => {
        if (t >= 0.8 && prev < 0.8) e.activate((p) => p.def === 'lab-vela-2v');
        stepEngines(e, last, t, t >= 0.8 && t < 8.6 ? 1 : 0);
        if (t >= 8.6 && prev < 8.6) e.shutdown((p) => p.def === 'lab-vela-2v');
        e.rcsLevels = t > 5 && t < 5.15 ? [1, 0, 0, 1] : [];
        const evs = eventsBetween(
          [
            { t: 5, type: 'rcsPulse' },
            { t: 5.07, type: 'rcsPulse' },
          ],
          prev,
          t,
          base.ut,
          base.activeVesselId,
          base,
        );
        prev = t;
        const running = t > 1.2 && t < 8.6;
        return { parts: e.parts(0), aero: { pressure: 0, q: 0, mach: 0 }, gLoad: running ? 0.62 + 0.004 * t : 0, events: evs, boundingRadius: 15, readouts: { sasMode: t > 6.5 ? 'prograde' : 'stability' } };
      },
    }),
  };
}

function reentry(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'reentry');
  const e = labEngines('capsule');
  let prev = 0;
  return {
    name: 'reentry',
    duration: 10,
    frame: frames({
      base,
      listen: (t) => ({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: 3 + 8 * t }),
      state: (t) => {
        const plasma = t < 6 ? 0.15 + 0.8 * (t / 6) : 0.95 - 0.08 * (t - 6);
        e.rcsLevels = t > 7 && t < 7.3 ? [0, 1, 1, 0] : [];
        const evs = eventsBetween(
          [
            { t: 7, type: 'rcsPulse' },
            { t: 7.12, type: 'rcsPulse' },
          ],
          prev,
          t,
          base.ut,
          base.activeVesselId,
          base,
        );
        prev = t;
        return { parts: e.parts(3 + 8 * t), aero: { pressure: 3 + 8 * t, q: 2000 + 1200 * t, mach: 30 - t, plasmaIntensity: plasma }, gLoad: 0.5 + 5 * Math.min(1, t / 7), events: evs, boundingRadius: 5 };
      },
    }),
  };
}

function chuteDeploy(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'chutes');
  const e = labEngines('capsule');
  let prev = 0;
  const p = pressureAt(7000);
  return {
    name: 'chute-deploy',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: p }),
      state: (t) => {
        const evs = eventsBetween(
          [
            { t: 1.0, type: 'stageFired' },
            { t: 1.05, type: 'chuteDeployed', extra: { mode: 'drogue' } },
            { t: 1.8, type: 'chuteInflated' },
            { t: 6.0, type: 'stageFired' },
            { t: 6.02, type: 'chuteCut' },
            { t: 6.05, type: 'chuteDeployed', extra: { mode: 'main' } },
            { t: 7.6, type: 'chuteInflated' },
          ],
          prev,
          t,
          base.ut,
          base.activeVesselId,
          base,
        );
        prev = t;
        const speed = t < 1.8 ? 170 : t < 6 ? 170 - 70 * Math.min(1, (t - 1.8) / 2) : t < 7.6 ? 100 : 100 - 60 * Math.min(1, (t - 7.6) / 1.5);
        const q = 0.5 * 0.59 * speed * speed;
        const g = 1 + (t > 1.8 && t < 2.6 ? 2.4 : 0) + (t > 7.6 && t < 8.4 ? 1.8 : 0);
        return { parts: e.parts(p), aero: { pressure: p, q, mach: speed / 312 }, gLoad: g, events: evs, boundingRadius: 5 };
      },
    }),
  };
}

function splashdown(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'chutes');
  const e = labEngines('capsule');
  let prev = 0;
  return {
    name: 'splashdown',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'external', mode: 'chase', position: { x: 26, y: 8, z: 22 }, lookAt: { x: 0, y: 1, z: 0 }, pressure: SEA_LEVEL }),
      state: (t) => {
        const evs = eventsBetween([{ t: 4, type: 'splash', extra: { speed: 8.6 } }], prev, t, base.ut, base.activeVesselId, base);
        prev = t;
        const speed = t < 4 ? 8.6 : 0.5;
        return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL, q: 0.5 * 1.225 * speed * speed + (t < 4 ? 30 : 0), mach: speed / 340 }, gLoad: t >= 4 && t < 4.3 ? 4 : 1, events: evs, boundingRadius: 5 };
      },
    }),
  };
}

// ----------------------------------------------------------------------------------- acceptance cases

/** Lift-off heard by an external camera 120 m away whose rig reports  (e.g. an unknown EVA rig). */
export function modeScript(lib: DefLibrary, mode: string): Script {
  return { ...liftoff(lib, 'liftoff-pad', mode, { x: 70, y: 6, z: 95 }), name: `mode-${mode}`, duration: 6 };
}

export interface SteadyCase {
  stack: LabStackId;
  throttle: number;
  listener: ListenerSpec;
  /** Ambient pressure at the nozzles. */
  nozzlePressure: number;
  duration?: number;
  warpFactor?: (t: number) => number;
  /** Only engines of these part defs run. */
  engineDefs?: string[];
}

/** Engines already running steadily (spooled, no transient); the throttle is the spooled ModuleState throttleActual. */
export function steadyScript(lib: DefLibrary, c: SteadyCase): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = steadyEngines(c.stack, 1, (_, def) => (c.engineDefs ? c.engineDefs.includes(def) : true));
  const parts = e.parts(c.nozzlePressure).map((p) => ({
    ...p,
    modules: p.modules.map((m) => (m.type === 'engine' && m.thrust > 0 ? { ...m, throttleActual: c.throttle, thrust: m.thrust * c.throttle, massFlow: m.massFlow * c.throttle } : m)),
  }));
  return {
    name: `steady-${c.stack}-${c.throttle}`,
    duration: c.duration ?? 3,
    frame: frames({ base, listen: () => c.listener, state: () => ({ parts, aero: { pressure: c.listener.pressure }, boundingRadius: 10 }), warpFactor: c.warpFactor }),
  };
}

/** Ignition at t = `at` heard by an external listener at `distance` m (sea level). */
export function ignitionScript(lib: DefLibrary, stack: LabStackId, distance: number, at = 0.3, duration = 8): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = labEngines(stack);
  const last = { t: 0 };
  let prev = 0;
  const l = externalAt(distance, { height: 2, lookY: 10 });
  return {
    name: `ignition-${stack}-${distance}`,
    duration,
    frame: frames({
      base,
      listen: () => l,
      state: (t) => {
        if (t >= at && prev < at) e.activate((p) => p.def !== 'lab-les-motor' && p.def !== 'lab-sep-motor');
        prev = t;
        stepEngines(e, last, t, t >= at ? 1 : 0);
        return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, boundingRadius: 10 };
      },
    }),
  };
}

/** Reentry at a constant plasma intensity (cabin or chase listener). */
export function plasmaScript(lib: DefLibrary, plasma: number, kind: 'interior' | 'external'): Script {
  const base = baseSnapshot(lib, 'reentry');
  const l: ListenerSpec = kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: 8 } : externalAt(40, { pressure: 8 });
  return { name: `plasma-${kind}-${plasma}`, duration: 2.5, frame: frames({ base, listen: () => l, state: () => ({ parts: [], aero: { pressure: 8, q: 9000, mach: 25, plasmaIntensity: plasma }, gLoad: 4, boundingRadius: 5 }) }) };
}

/** Every event type that has a sound, fired one after another; returns the schedule. */
export function eventsScript(lib: DefLibrary, types: SimEventType[], spacing = 1.0): Script & { schedule: { type: SimEventType; t: number }[] } {
  const base = baseSnapshot(lib, 'pad');
  const schedule = types.map((type, i) => ({ type, t: 0.25 + i * spacing }));
  const e = labEngines('capsule');
  let prev = -1;
  return {
    name: 'events',
    duration: 0.25 + types.length * spacing + 0.5,
    schedule,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: SEA_LEVEL }),
      state: (t) => {
        const evs = schedule.filter((s) => s.t > prev && s.t <= t).map((s) => makeEvent(s.type, base.ut + s.t, base.activeVesselId, base));
        prev = t;
        return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, events: evs, boundingRadius: 5 };
      },
    }),
  };
}

/** Everything at once at maximum: for the clipping check. */
export function maximumScript(lib: DefLibrary, kind: 'interior' | 'external'): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = steadyEngines('booster', 1);
  e.activate(() => true);
  const all: SimEventType[] = ['explosion', 'decoupled', 'splash', 'touchdown', 'partDestroyed', 'fairingJettisoned', 'lesFired', 'chuteInflated', 'clampsReleased', 'jointBroken'];
  let prev = -1;
  const l: ListenerSpec = kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: seatOf('booster'), pressure: SEA_LEVEL } : externalAt(25, { height: 3 });
  return {
    name: `maximum-${kind}`,
    duration: 4,
    frame: frames({
      base,
      listen: () => l,
      state: (t) => {
        e.step(t - Math.max(0, prev), 1);
        const evs = t >= 1 && prev < 1 ? all.map((type) => makeEvent(type, base.ut + t, base.activeVesselId, base, { speed: 30, energy: 1e12, partId: 'atlas-c' })) : [];
        prev = t;
        return {
          parts: e.parts(SEA_LEVEL),
          aero: { pressure: SEA_LEVEL, q: 60000, mach: 1.0, plasmaIntensity: 1 },
          gLoad: 9,
          events: evs,
          boundingRadius: 55,
          readouts: { maxTempFraction: 0.99 },
        };
      },
    }),
  };
}

export { pressureAt };
