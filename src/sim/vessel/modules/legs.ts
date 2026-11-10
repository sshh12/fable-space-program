/**
 * Landing legs (sim-design 9.2): deployment animation state and the foot-pad probe geometry. The
 * telescoping strut force law is evaluated with the contact model (dynamics/contact.ts).
 */
import { legFootLocal, partPoint, type Structure } from '../structure';
import type { Vessel } from '../types';

/** Deployment fraction above which the pads take load. */
export const LEG_LOCKED = 0.999;
/** Stiffness of a bottomed-out strut, N/m. */
export const LEG_BOTTOM_STIFFNESS = 4e6;
/** A strut pushed this far past its stroke collapses, m. */
export const LEG_OVERSTROKE = 0.08;
/** Lateral touchdown speed limit of a pad as a fraction of its normal crash tolerance (2.5 of 4.0 m/s). */
export const LEG_LATERAL_TOLERANCE_RATIO = 0.625;

/** Advance the deploy animation and place the foot probes. */
export function updateLegs(vessel: Vessel, st: Structure, dt: number): void {
  for (let i = 0; i < st.legs.length; i++) {
    const ref = st.legs[i]!;
    const s = ref.state;
    const target = ref.rt.target;
    if (s.deploy !== target) {
      const step = ref.def.deployTime > 0 ? dt / ref.def.deployTime : 1;
      s.deploy = target > s.deploy ? Math.min(target, s.deploy + step) : Math.max(target, s.deploy - step);
    }
    const part = vessel.parts[ref.part]!;
    const locked = s.deploy >= LEG_LOCKED;
    for (let l = 0; l < ref.probes.length; l++) {
      const pr = ref.probes[l]!;
      if (!locked || s.broken[l]) {
        if (pr.inContact) {
          pr.inContact = false;
          pr.hasAnchor = false;
        }
        s.contact[l] = false;
        s.compression[l] = 0;
        continue;
      }
      const p = partPoint(part, legFootLocal(ref.def, l, 1));
      pr.x = p.x;
      pr.y = p.y;
      pr.z = p.z;
    }
  }
}

/** True while any leg is between its end positions. */
export function legsMoving(vessel: Vessel): boolean {
  for (const p of vessel.parts) {
    for (let m = 0; m < p.modules.length; m++) {
      const ms = p.modules[m]!;
      const rt = p.rt[m]!;
      if (ms.type === 'legs' && rt.type === 'legs' && ms.deploy !== rt.target) return true;
    }
  }
  return false;
}
