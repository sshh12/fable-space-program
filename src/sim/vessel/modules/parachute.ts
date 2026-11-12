/**
 * Parachutes (sim-design 10.4): reefing stages, safe / destroy envelopes, canopy line direction.
 * The drag force itself is evaluated with the aerodynamics (dynamics/aero.ts) from `inflation`.
 */
import type { ParachuteEnvelope } from '@/core/contracts/defs';
import type { ChuteEnvelope, SimEvent } from '@/core/contracts/sim';
import { eventPartId } from '../ids';
import type { Structure } from '../structure';
import type { ParachuteDef, Vessel } from '../types';

const smooth = (x: number): number => {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

/** Longest ramp from one reefing stage to the next, s (line stretch and disreef are quick). */
const REEF_RAMP_MAX = 1.0;

/** Drag-area fraction (0..1 of the fully open canopy) `age` seconds after deployment. */
export function inflationAt(def: ParachuteDef, age: number): number {
  let t = age;
  let prev = 0;
  for (const st of def.reefStages) {
    if (t < st.duration) {
      const ramp = Math.min(st.duration / 2, def.fullInflateTime / 2, REEF_RAMP_MAX);
      return prev + (st.fraction - prev) * smooth(ramp > 0 ? t / ramp : 1);
    }
    t -= st.duration;
    prev = st.fraction;
  }
  return prev + (1 - prev) * smooth(def.fullInflateTime > 0 ? t / def.fullInflateTime : 1);
}

/** Seconds from deployment to the fully open canopy. */
export function timeToFull(def: ParachuteDef): number {
  let t = def.fullInflateTime;
  for (const st of def.reefStages) t += st.duration;
  return t;
}

function inside(env: ParachuteEnvelope, altitude: number, mach: number, speed: number, q: number): boolean {
  if (env.maxAlt !== undefined && altitude > env.maxAlt) return false;
  if (env.maxMach !== undefined && mach > env.maxMach) return false;
  if (env.maxSpeed !== undefined && speed > env.maxSpeed) return false;
  return q <= env.maxQ;
}

/** Envelope light for deploying (or riding) this chute in the given conditions. */
export function chuteEnvelope(def: ParachuteDef, altitude: number, mach: number, speed: number, q: number): ChuteEnvelope {
  if (!inside(def.destroy, altitude, mach, speed, q)) return 'unsafe';
  return inside(def.safe, altitude, mach, speed, q) ? 'safe' : 'risky';
}

/**
 * Advance the parachute state machines. (hx, hy, hz): unit direction of travel through the air in VES.
 */
export function updateParachutes(vessel: Vessel, st: Structure, altitude: number, mach: number, speed: number, q: number, hx: number, hy: number, hz: number, dt: number, ut: number, events: SimEvent[]): void {
  for (let i = 0; i < st.chutes.length; i++) {
    const c = st.chutes[i]!;
    const s = c.state;
    s.envelope = chuteEnvelope(c.def, altitude, mach, speed, q);
    if (s.state !== 'reefed' && s.state !== 'full') continue;
    const partId = eventPartId(vessel, vessel.parts[c.part]!);
    if (s.envelope === 'unsafe') {
      s.state = 'failed';
      s.inflation = 0;
      c.rt.canopies = 0;
      events.push({ type: 'chuteFailed', ut, vesselId: vessel.id, partId });
      continue;
    }
    s.deployAge += dt;
    s.inflation = inflationAt(c.def, s.deployAge);
    if (s.state === 'reefed' && s.deployAge >= timeToFull(c.def)) {
      s.state = 'full';
      s.inflation = 1;
      events.push({ type: 'chuteInflated', ut, vesselId: vessel.id, partId });
    }
    // The canopy trails the airflow; in still air it stays where it was.
    if (speed > 1) {
      const k = Math.min(1, dt * 4);
      const lx = s.lineDir.x + (-hx - s.lineDir.x) * k;
      const ly = s.lineDir.y + (-hy - s.lineDir.y) * k;
      const lz = s.lineDir.z + (-hz - s.lineDir.z) * k;
      const l = Math.hypot(lx, ly, lz);
      if (l > 1e-9) {
        s.lineDir.x = lx / l;
        s.lineDir.y = ly / l;
        s.lineDir.z = lz / l;
      }
    }
  }
}

export function anyChuteDeployed(vessel: Vessel): boolean {
  for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'parachute' && (m.state === 'reefed' || m.state === 'full')) return true;
  return false;
}
