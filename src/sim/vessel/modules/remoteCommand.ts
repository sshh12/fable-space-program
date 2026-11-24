/**
 * Command authority (docs/ARCHITECTURE.md 9.1, 7.2; docs/research/v2/fleet-docking.md 2.1): who can fly a
 * craft. A command part gives authority when crew are aboard and alive, or when its `command` module is
 * flagged `remote` (an uncrewed craft: a probe bus, an avionics ring, a habitat launched empty). A crewed
 * capsule whose crew are lost, or a cabin launched empty without remote avionics, has none.
 *
 * Pure functions of the vessel's parts. What follows from them (whether a craft takes the pilot's inputs,
 * whether it counts as controllable) is the island's rule; these say which parts can give the authority.
 */
import type { PartRuntime, Vessel } from '../types';

/** Whether part `part` gives command authority now: a command module with living crew aboard, or flagged remote. */
export function givesCommandAuthority(part: PartRuntime): boolean {
  for (let m = 0; m < part.def.modules.length; m++) {
    const md = part.def.modules[m]!;
    const ms = part.modules[m]!;
    if (md.type !== 'command' || ms.type !== 'command') continue;
    if (md.remote === true) return true;
    if (ms.crew > 0 && ms.crewAlive) return true;
  }
  return false;
}

/** The parts of craft `craft` (index into `vessel.crafts`) that give command authority now, by part index. */
export function commandAuthorityParts(vessel: Vessel, craft?: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < vessel.parts.length; i++) {
    const p = vessel.parts[i]!;
    if (craft !== undefined && p.craft !== craft) continue;
    if (givesCommandAuthority(p)) out.push(i);
  }
  return out;
}

/** Whether any part of the vessel (or of craft `craft`) gives command authority now. */
export function hasCommandAuthority(vessel: Vessel, craft?: number): boolean {
  return commandAuthorityParts(vessel, craft).length > 0;
}

/** Whether a command part can fly without crew at all (its module is flagged remote), whatever is aboard now. */
export function isRemoteCapable(part: PartRuntime): boolean {
  return part.def.modules.some((m) => m.type === 'command' && m.remote === true);
}
