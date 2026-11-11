/**
 * Timelines rendered offline by the audio lab: the listen-proof clips (out/audio/*.wav) and the cases the
 * acceptance spec measures. Every script is a pure function of time built on a FakeSim base snapshot,
 * with the real part definitions driven through the sim's engine law (labVehicle.ts).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { PartSnapshot, SimEvent, SimEventType, VesselSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { isFixedBurn, LAB_PARTS, LabEngines, labStack, type LabPlacement, type LabStackId } from './labVehicle';
import { SEA_LEVEL, baseSnapshot, externalAt, frames, labEngines, makeEvent, seatOf, steadyEngines, type ListenerSpec, type Script } from './scenes';

/** US76-like pressure for the clip scenes, Pa. */
const pressureAt = (h: number): number => SEA_LEVEL * Math.exp(-h / 7400);

function stepEngines(e: LabEngines, last: { t: number }, t: number, lever: number): void {
  const dt = t - last.t;
  if (dt > 0) e.step(dt, lever);
  last.t = t;
}

function eventsBetween(list: { t: number; type: SimEventType; extra?: Record<string, unknown> }[], t0: number, t1: number, ut0: number, vesselId: string, base: ReturnType<typeof baseSnapshot>): SimEvent[] {
  return list.filter((e) => e.t > t0 && e.t <= t1).map((e) => makeEvent(e.type, ut0 + e.t, vesselId, base, e.extra));
}

const isBoosterEngine = (p: { def: string }): boolean => p.def === LAB_PARTS.booster;

// --------------------------------------------------------------------------------------------- clips

export function clipScripts(lib: DefLibrary): Script[] {
  return [liftoff(lib, 'liftoff-pad'), liftoff(lib, 'liftoff-cabin'), maxQ(lib), staging(lib), vacuumBurn(lib), reentry(lib), chuteDeploy(lib), splashdown(lib)];
}

function liftoff(lib: DefLibrary, name: 'liftoff-pad' | 'liftoff-cabin', mode = 'pad-camera', padPosition: Vec3 = { x: 330, y: 4, z: 300 }): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = labEngines(lib, 'booster');
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
        if (name === 'liftoff-cabin') return { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: pressureAt(h) };
        // The pad camera stands on the ground; any other mode is a rig that follows the vehicle.
        return { kind: 'external', mode, attachedVesselId: mode === 'pad-camera' ? null : base.activeVesselId, position: v3.sub(pad, { x: 0, y: h, z: 0 }), lookAt: { x: 0, y: 30, z: 0 }, pressure: SEA_LEVEL };
      },
      state: (t) => {
        if (t >= ignite && prev < ignite) e.activate(isBoosterEngine);
        stepEngines(e, last, t, t >= ignite ? 1 : 0);
        const evs = eventsBetween([{ t: release, type: 'clampsReleased' }], prev, t, base.ut, base.activeVesselId, base);
        prev = t;
        const h = height(t);
        const v = t > release ? 3 * (t - release) : 0;
        return {
          parts: e.parts(pressureAt(h)),
          aero: { pressure: pressureAt(h), q: 0.5 * 1.225 * v * v, mach: v / 340 },
          airVelocityVes: { x: 0, y: v, z: 0 },
          gLoad: t > ignite ? 1 + 0.3 * Math.min(1, (t - ignite) / 3) : 1,
          situation: t > release ? 'flying' : 'prelaunch',
          readouts: { altitudeRadar: h },
          events: evs,
          boundingRadius: 55,
        };
      },
    }),
  };
}

function maxQ(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'ascent');
  const e = steadyEngines(lib, 'booster', 0.4, (_, def) => def === LAB_PARTS.booster);
  const last = { t: 0 };
  const p = pressureAt(11000);
  return {
    name: 'max-q',
    duration: 10,
    frame: frames({
      base,
      // A chase camera trailing behind and below the stack: inside the Mach cone, so it keeps hearing it.
      listen: () => ({ kind: 'external', mode: 'chase', position: { x: 22, y: -88, z: 34 }, lookAt: { x: 0, y: 30, z: 0 }, pressure: p }),
      state: (t) => {
        // Throttled down through max-Q (lever 0.4), back to full after it.
        stepEngines(e, last, t, t < 6 ? 0.4 : 1);
        const mach = 0.95 + 0.04 * t;
        return { parts: e.parts(p), aero: { pressure: p, q: 33000 - 150 * (t - 5) ** 2, mach }, gLoad: 1.7 + (t > 6 ? 0.3 : 0), readouts: { altitudeRadar: 11000 }, boundingRadius: 55 };
      },
    }),
  };
}

/** Booster engines placed under the upper stack (VES of the upper stack) for the staging clip. */
function boosterUnderUpper(lib: DefLibrary): LabPlacement[] {
  return labStack(lib, 'booster')
    .parts.filter(isBoosterEngine)
    .map((p) => ({ ...p, pos: { x: p.pos.x, y: p.pos.y - 47, z: p.pos.z } }));
}

function staging(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'ascent');
  const upper = labStack(lib, 'upper').parts;
  const booster = boosterUnderUpper(lib);
  const stack = [...booster, ...upper];
  const e = new LabEngines(stack, lib.parts);
  e.activate(isBoosterEngine);
  for (let i = 0; i < 600; i++) e.step(1 / 60, 1);
  const last = { t: 0 };
  const p = pressureAt(62000);
  const shutdown = 1.8;
  const sep = 2.3;
  const ignite = 3.8;
  let prev = 0;
  const spent: VesselSnapshot = { ...base.vessels[0]!, id: 'spent-booster', name: 'Spent booster', parts: [] };
  const speed = 6.5 * 300;
  return {
    name: 'staging',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'upper'), pressure: p }),
      state: (t) => {
        if (t >= shutdown && prev < shutdown) e.shutdown(isBoosterEngine);
        if (t >= sep && prev < sep) e.activate((x) => x.def === LAB_PARTS.ullage);
        if (t >= ignite && prev < ignite) e.activate((x) => x.def === LAB_PARTS.upper);
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
        let parts = all;
        const extra: VesselSnapshot[] = [];
        const airVelocityVes = { x: 0, y: speed, z: 0 };
        if (t >= sep) {
          parts = all.filter((x) => !isBoosterEngine(x));
          // The spent stage falls behind: 0.5 * 12 m/s^2 * dt^2 below the upper stack, in its own frame.
          const drop = 0.5 * 12 * (t - sep) ** 2;
          const a = base.vessels[0]!;
          const offsetVes = { x: 0, y: -47 - drop, z: 0 };
          const spentAero = { ...a.aero, airVelocity: quat.rotate(a.q, { x: 0, y: speed - 12 * (t - sep), z: 0 }) };
          extra.push({ ...spent, rRoot: v3.add(a.rRoot, quat.rotate(a.q, offsetVes)), q: a.q, aero: spentAero, parts: all.filter(isBoosterEngine).map((x) => ({ ...x, localPos: { ...x.localPos, y: x.localPos.y + 47 } })) });
        }
        const g = t < shutdown ? 3.6 : t < ignite ? 0.05 : 0.05 + 0.75 * Math.min(1, (t - ignite) / 1.2);
        return { parts, aero: { pressure: p, q: 120, mach: 6.5 }, airVelocityVes, gLoad: g, readouts: { altitudeRadar: 62000 }, events: evs, boundingRadius: 40, extraVessels: extra };
      },
    }),
  };
}

function vacuumBurn(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'lowOrbit');
  const e = labEngines(lib, 'tli');
  const last = { t: 0 };
  let prev = 0;
  return {
    name: 'vacuum-burn-cabin',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'tli'), pressure: 0 }),
      state: (t) => {
        if (t >= 0.8 && prev < 0.8) e.activate((p) => p.def === LAB_PARTS.tli);
        stepEngines(e, last, t, t >= 0.8 && t < 8.6 ? 1 : 0);
        if (t >= 8.6 && prev < 8.6) e.shutdown((p) => p.def === LAB_PARTS.tli);
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
  const e = labEngines(lib, 'capsule');
  let prev = 0;
  return {
    name: 'reentry',
    duration: 10,
    frame: frames({
      base,
      listen: (t) => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: 3 + 8 * t }),
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
        const mach = 30 - t;
        // Heat shield first: the capsule moves along its -Y axis.
        return { parts: e.parts(3 + 8 * t), aero: { pressure: 3 + 8 * t, q: 2000 + 1200 * t, mach, plasmaIntensity: plasma }, airVelocityVes: { x: 0, y: -mach * 300, z: 0 }, gLoad: 0.5 + 5 * Math.min(1, t / 7), readouts: { altitudeRadar: 70000 }, events: evs, boundingRadius: 5 };
      },
    }),
  };
}

function chuteDeploy(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'chutes');
  const e = labEngines(lib, 'capsule');
  let prev = 0;
  const p = pressureAt(7000);
  return {
    name: 'chute-deploy',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: p }),
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
        return { parts: e.parts(p), aero: { pressure: p, q, mach: speed / 312 }, airVelocityVes: { x: 0, y: -speed, z: 0 }, gLoad: g, readouts: { altitudeRadar: 7000 - 100 * t }, events: evs, boundingRadius: 5 };
      },
    }),
  };
}

function splashdown(lib: DefLibrary): Script {
  const base = baseSnapshot(lib, 'chutes');
  const e = labEngines(lib, 'capsule');
  let prev = 0;
  const impact = 4;
  return {
    name: 'splashdown',
    duration: 10,
    frame: frames({
      base,
      listen: () => ({ kind: 'external', mode: 'chase', position: { x: 26, y: 8, z: 22 }, lookAt: { x: 0, y: 1, z: 0 }, pressure: SEA_LEVEL }),
      state: (t) => {
        const evs = eventsBetween([{ t: impact, type: 'splash', extra: { speed: 8.6 } }], prev, t, base.ut, base.activeVesselId, base);
        prev = t;
        const afloat = t >= impact;
        const speed = afloat ? 0.5 : 8.6;
        return {
          parts: e.parts(SEA_LEVEL),
          aero: { pressure: SEA_LEVEL, q: 0.5 * 1.225 * speed * speed + (afloat ? 0 : 30), mach: speed / 340 },
          airVelocityVes: { x: 0, y: afloat ? 0 : -speed, z: 0 },
          situation: afloat ? 'splashed' : 'flying',
          waterSubmersion: afloat ? 0.45 : 0,
          readouts: { altitudeRadar: afloat ? 0 : 8.6 * (impact - t) },
          gLoad: t >= impact && t < impact + 0.3 ? 4 : 1,
          events: evs,
          boundingRadius: 5,
        };
      },
    }),
  };
}

// ----------------------------------------------------------------------------------- acceptance cases

/** Lift-off heard by an external camera 120 m away whose rig reports `mode` (e.g. an unknown EVA rig). */
export function modeScript(lib: DefLibrary, mode: string): Script {
  return { ...liftoff(lib, 'liftoff-pad', mode, { x: 70, y: 6, z: 95 }), name: `mode-${mode}`, duration: 6 };
}

export interface SteadyCase {
  stack: LabStackId;
  /** The throttle LEVER (0..1); each engine's throttleActual follows the sim's law from its minThrottle. */
  throttle: number;
  listener: ListenerSpec;
  /** Ambient pressure at the nozzles. */
  nozzlePressure: number;
  duration?: number;
  warpFactor?: (t: number) => number;
  /** Only engines of these part defs run. */
  engineDefs?: string[];
}

/** Engines already running steadily (spooled through the sim's lever law, no transient), stack at rest. */
export function steadyScript(lib: DefLibrary, c: SteadyCase): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = steadyEngines(lib, c.stack, c.throttle, (_, def) => (c.engineDefs ? c.engineDefs.includes(def) : true));
  const parts = e.parts(c.nozzlePressure);
  return {
    name: `steady-${c.stack}-${c.throttle}`,
    duration: c.duration ?? 3,
    frame: frames({ base, listen: () => c.listener, state: () => ({ parts, aero: { pressure: c.listener.pressure }, airVelocityVes: v3.zero(), boundingRadius: 10 }), warpFactor: c.warpFactor }),
  };
}

/** Ignition at t = `at` heard by an external listener at `distance` m (sea level). */
export function ignitionScript(lib: DefLibrary, stack: LabStackId, distance: number, at = 0.3, duration = 8): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = labEngines(lib, stack);
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
        if (t >= at && prev < at) e.activate((p) => !isFixedBurn(lib, p.def));
        prev = t;
        stepEngines(e, last, t, t >= at ? 1 : 0);
        return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero(), boundingRadius: 10 };
      },
    }),
  };
}

/** Reentry at a constant plasma intensity (cabin or chase listener). */
export function plasmaScript(lib: DefLibrary, plasma: number, kind: 'interior' | 'external'): Script {
  const base = baseSnapshot(lib, 'reentry');
  const l: ListenerSpec = kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: 8 } : externalAt(40, { pressure: 8 });
  return {
    name: `plasma-${kind}-${plasma}`,
    duration: 2.5,
    frame: frames({ base, listen: () => l, state: () => ({ parts: [], aero: { pressure: 8, q: 9000, mach: 25, plasmaIntensity: plasma }, airVelocityVes: { x: 0, y: -25 * 300, z: 0 }, gLoad: 4, readouts: { altitudeRadar: 75000 }, boundingRadius: 5 }) }),
  };
}

/** Every event type that has a sound, fired one after another; returns the schedule. */
export function eventsScript(lib: DefLibrary, types: SimEventType[], spacing = 1.0): Script & { schedule: { type: SimEventType; t: number }[] } {
  const base = baseSnapshot(lib, 'pad');
  const schedule = types.map((type, i) => ({ type, t: 0.25 + i * spacing }));
  const e = labEngines(lib, 'capsule');
  let prev = -1;
  return {
    name: 'events',
    duration: 0.25 + types.length * spacing + 0.5,
    schedule,
    frame: frames({
      base,
      listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: SEA_LEVEL }),
      state: (t) => {
        const evs = schedule.filter((s) => s.t > prev && s.t <= t).map((s) => makeEvent(s.type, base.ut + s.t, base.activeVesselId, base));
        prev = t;
        return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero(), events: evs, boundingRadius: 5 };
      },
    }),
  };
}

/** The event types fired together by the loud cases (the loudest one-shots, all at once). */
export const LOUD_EVENTS: SimEventType[] = ['explosion', 'decoupled', 'splash', 'touchdown', 'partDestroyed', 'fairingJettisoned', 'lesFired', 'chuteInflated', 'clampsReleased', 'jointBroken'];

/**
 * Everything at once at maximum, for the clipping check: the booster cluster at full thrust (25 m outside,
 * or the cabin on top of it), every loud event at the same instant (explosion energy 1e12 J), q 60 kPa at
 * Mach 1, plasma 1, 9 g creaks and the master alarm. The stack is held at rest in the air (the aero values
 * are forced) so nothing is lost to the Mach cone.
 */
export function maximumScript(lib: DefLibrary, kind: 'interior' | 'external'): Script {
  const base = baseSnapshot(lib, 'pad');
  const e = steadyEngines(lib, 'booster', 1);
  e.activate(() => true);
  let prev = -1;
  const l: ListenerSpec = kind === 'interior' ? { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: SEA_LEVEL } : externalAt(25, { height: 3 });
  return {
    name: `maximum-${kind}`,
    duration: 4,
    frame: frames({
      base,
      listen: () => l,
      state: (t) => {
        e.step(t - Math.max(0, prev), 1);
        const evs = t >= 1 && prev < 1 ? LOUD_EVENTS.map((type) => makeEvent(type, base.ut + t, base.activeVesselId, base, { speed: 30, energy: 1e12, partId: 'atlas-c' })) : [];
        prev = t;
        return {
          parts: e.parts(SEA_LEVEL),
          aero: { pressure: SEA_LEVEL, q: 60000, mach: 1.0, plasmaIntensity: 1 },
          airVelocityVes: v3.zero(),
          gLoad: 9,
          events: evs,
          boundingRadius: 55,
          readouts: { maxTempFraction: 0.99, altitudeRadar: 0 },
        };
      },
    }),
  };
}

/**
 * The loudest realistic scenes, whose buses must stay below full scale: the booster cluster at full thrust
 * heard from 25 m and 50 m outside and from the cabin on top of it, its ignition from 25 m, and every loud
 * event at once (25 m outside, and in the cabin).
 */
export function loudScripts(lib: DefLibrary): Script[] {
  const booster = (name: string, l: ListenerSpec): Script => ({ ...steadyScript(lib, { stack: 'booster', throttle: 1, nozzlePressure: SEA_LEVEL, duration: 4, listener: l }), name });
  const events = (name: string, l: ListenerSpec): Script => {
    const base = baseSnapshot(lib, 'pad');
    const e = labEngines(lib, 'booster');
    let prev = -1;
    return {
      name,
      duration: 4,
      frame: frames({
        base,
        listen: () => l,
        state: (t) => {
          const evs = t >= 0.5 && prev < 0.5 ? LOUD_EVENTS.map((type) => makeEvent(type, base.ut + t, base.activeVesselId, base, { speed: 30, energy: 1e12, partId: 'atlas-c' })) : [];
          prev = t;
          return { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero(), events: evs, boundingRadius: 55 };
        },
      }),
    };
  };
  return [
    booster('booster-25m', externalAt(25, { height: 3 })),
    booster('booster-50m', externalAt(50, { height: 3 })),
    { ...ignitionScript(lib, 'booster', 25, 0.3, 4), name: 'ignition-25m' },
    booster('booster-cabin', { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: SEA_LEVEL }),
    events('events-25m', externalAt(25, { height: 3 })),
    events('events-cabin', { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: SEA_LEVEL }),
  ];
}

export { pressureAt };
