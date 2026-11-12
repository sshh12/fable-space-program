/**
 * The mission's entry as an audio timeline: the real Sim's capsule on the nominal lunar return, entry
 * interface to splashdown, recorded twice a second by tools/audio/entryProfile.ts (entryProfile.json: aero
 * state, g-load, radar altitude, parachutes, events). `missionEntryScript` plays any stretch of it at real
 * time through the lab's frame builder, for a cabin listener or a chase camera riding with the capsule.
 * Pure TypeScript: the offline acceptance spec renders it in Chrome, tests/unit/audio/entryProfile.test.ts
 * runs the sound model over it in vitest.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent, SimEventType } from '@/core/contracts/sim';
import profileJson from './entryProfile.json';
import { baseSnapshot, frames, labEngines, makeEvent, seatOf, type ListenerSpec, type Script } from './scenes';

export interface EntryProfile {
  perigeeKm: number;
  /** Seconds between samples. */
  step: number;
  fields: string[];
  samples: number[][];
  events: { t: number; type: string; mode?: string; speed?: number }[];
  /** Seconds since the first sample of ENTRY (122 km), DROGUES, MAINS, SPLASHDOWN. */
  marks: Record<string, number>;
  vehicle: string;
  boundingRadius: number;
}

export const ENTRY_PROFILE = profileJson as EntryProfile;

export interface EntryState {
  t: number;
  altitude: number;
  radar: number;
  speed: number;
  mach: number;
  q: number;
  pressure: number;
  density: number;
  plasma: number;
  heatFlux: number;
  gLoad: number;
  /** Air-relative velocity in VES axes, m/s. */
  air: { x: number; y: number; z: number };
  /** 0 none, 1 drogues, 2 mains. */
  chute: number;
}

/** The profile at `t` seconds after its first sample (linear between samples, held at the ends). */
export function entryStateAt(p: EntryProfile, t: number): EntryState {
  const n = p.samples.length;
  const x = Math.min(n - 1, Math.max(0, t / p.step));
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const a = p.samples[i]!;
  const b = p.samples[i + 1]!;
  const at = (k: number): number => a[k]! + (b[k]! - a[k]!) * f;
  return { t, altitude: at(1), radar: at(2), speed: at(3), mach: at(4), q: at(5), pressure: at(6), density: at(7), plasma: at(8), heatFlux: at(9), gLoad: at(10), air: { x: at(11), y: at(12), z: at(13) }, chute: a[14]! };
}

/** Events of the profile that have a sound (the rest is bookkeeping of the simulation). */
const SOUNDING: readonly string[] = ['rcsPulse', 'stageFired', 'decoupled', 'chuteDeployed', 'chuteInflated', 'chuteCut', 'splash', 'touchdown'];

/** Where the chase camera of the entry timeline rides: 15 m from the capsule, trailing it off to one side (VES, m). */
export const ENTRY_CHASE_POSITION = { x: 6.8, y: 9.3, z: 9.6 };

export interface EntryScriptOptions {
  /** Seconds after the first sample of the profile at which the script starts, and how long it runs. */
  from: number;
  duration: number;
  kind: 'interior' | 'external';
}

export function missionEntryScript(lib: DefLibrary, o: EntryScriptOptions, profile: EntryProfile = ENTRY_PROFILE): Script {
  const base = baseSnapshot(lib, 'reentry');
  const e = labEngines(lib, 'capsule');
  const splashAt = profile.marks['SPLASHDOWN'] ?? Infinity;
  const pulses = profile.events.filter((x) => x.type === 'rcsPulse').map((x) => x.t);
  let prev = o.from;
  const listen = (t: number): ListenerSpec => {
    const s = entryStateAt(profile, o.from + t);
    if (o.kind === 'interior') return { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: s.pressure };
    return { kind: 'external', mode: 'chase', position: ENTRY_CHASE_POSITION, lookAt: { x: 0, y: 0, z: 0 }, pressure: s.pressure };
  };
  return {
    name: `mission-entry-${o.kind}-${o.from}`,
    duration: o.duration,
    frame: frames({
      base,
      listen,
      state: (t) => {
        const now = o.from + t;
        const s = entryStateAt(profile, now);
        const events: SimEvent[] = profile.events
          .filter((x) => x.t > prev && x.t <= now && SOUNDING.includes(x.type))
          .map((x) => makeEvent(x.type as SimEventType, base.ut + x.t, base.activeVesselId, base, { ...(x.mode ? { mode: x.mode } : {}), ...(x.speed !== undefined ? { speed: x.speed } : {}) }));
        prev = now;
        // A thruster pulse of the pilot lasts about a quarter of a second.
        e.rcsLevels = pulses.some((p) => now >= p && now < p + 0.25) ? [0, 1, 1, 0] : [];
        const splashed = now >= splashAt;
        return {
          parts: e.parts(s.pressure),
          aero: { q: s.q, mach: s.mach, pressure: s.pressure, airDensity: s.density, plasmaIntensity: s.plasma, heatFlux: s.heatFlux },
          airVelocityVes: s.air,
          gLoad: s.gLoad,
          situation: splashed ? 'splashed' : 'flying',
          waterSubmersion: splashed ? 0.4 : 0,
          readouts: { altitudeRadar: s.radar, altitudeAsl: s.altitude },
          events,
          boundingRadius: profile.boundingRadius,
        };
      },
    }),
  };
}
