/**
 * The flight menu's "If you leave now" (ARCHITECTURE 23, U16; frontend-ux 5.16), computed from the snapshot and
 * the rules in force. What U16 does on an explicit leave: the throttle is closed at the leave tick; then a
 * quiescent vessel becomes passive at its head, and any other is flown to rest by an unattended run with no
 * invented input (no stage fired, no chute opened); a private clock holds. The lines say which of these
 * applies to the craft as it is now, and for how long the ship is kept (`expiry.craftRetention`).
 *
 * Also the page's leave-guard rule (`shouldGuardUnload`): only a flight under way arms the browser's "leave
 * this page?" question; a session without an active vessel (the menu, a lobby) never does.
 */
import type { UniverseRules } from '@/core/contracts/net';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { NumberFormat } from './format';
import { formatSpan, isNever } from './rulesView';

export interface LeaveOutcome {
  /** The craft's state in one line ("ENGINES FIRING 64 % · SAS PROGRADE"), for the menu's header. */
  status: string;
  /** What happens if the player leaves now, one sentence per effect, most important first. */
  lines: string[];
  /** 'calm' when nothing is lost by leaving now; 'caution' when the craft is under power, in an atmosphere or on an impact course. */
  tone: 'calm' | 'caution';
}

const activeOf = (s: SimSnapshot): VesselSnapshot | null => (s.activeVesselId === null ? null : (s.vessels.find((v) => v.id === s.activeVesselId) ?? null));

/** The page's leave guard: true only while a flight is under way (an active vessel that has left the pad or started elsewhere, and is not lost). */
export function shouldGuardUnload(s: SimSnapshot): boolean {
  if (s.activeVesselId === null || s.mission.failed) return false;
  if (s.staging.nextStage > 0) return true;
  // A session started from a scenario that does not begin on a pad is a flight from its first frame; a session
  // without a scenario (a lobby) has a flight under way once its vessel has fired a stage (above).
  return s.scenario !== null && s.scenario.startKind !== 'pad';
}

export function leaveOutcome(s: SimSnapshot, rules: UniverseRules, fmt: Pick<NumberFormat, 'apsis' | 'duration'>): LeaveOutcome | null {
  const formatApsis = fmt.apsis;
  const formatDuration = fmt.duration;
  const v = activeOf(s);
  if (!v) return null;
  const r = s.readouts;
  const name = v.name;
  const powered = r.throttle > 0 && r.thrust > 0;
  const lines: string[] = [];
  let caution = false;
  const statusParts: string[] = [];
  if (powered) statusParts.push(`ENGINES FIRING ${Math.round(r.throttle * 100)} %`);
  if (r.sasEnabled) statusParts.push(`SAS ${r.sasMode.replace(/([A-Z])/g, ' $1').toUpperCase()}`);

  if (powered) {
    caution = true;
    lines.push(`The throttle closes the moment you leave (it is at ${Math.round(r.throttle * 100)} %).`);
  }
  const impact = s.patches.current.find((p) => p.endReason === 'impact');
  switch (v.situation) {
    case 'prelaunch':
      statusParts.unshift('ON THE PAD');
      lines.push(`${name} is rolled back from the pad and the pad is released.`);
      break;
    case 'landed':
    case 'splashed':
      statusParts.unshift(v.situation === 'landed' ? 'LANDED' : 'SPLASHED DOWN');
      lines.push(`${name} stays where it is.`);
      break;
    case 'orbiting':
      statusParts.unshift(`ORBITING · ${formatApsis(r.apoapsisAltitude)} × ${formatApsis(r.periapsisAltitude)}`);
      lines.push(`${name} stays in its orbit (periapsis ${formatApsis(r.periapsisAltitude)}).`);
      break;
    case 'escaping':
      statusParts.unshift('ESCAPING');
      lines.push(`${name} coasts on along its escape path.`);
      break;
    case 'flying':
    case 'suborbital': {
      caution = true;
      statusParts.unshift(v.situation === 'flying' ? 'IN THE ATMOSPHERE' : 'SUBORBITAL');
      if (impact) lines.push(`${name} is on a course to the ground and reaches it in ${formatDuration(impact.tEnd - s.ut)}: nobody fires a stage or opens a parachute for you.`);
      else lines.push(`${name} flies on unattended until it comes to rest: nobody fires a stage or opens a parachute for you.`);
      break;
    }
  }
  if (v.crafts.length > 1) {
    lines.push(`The assembly stays docked; the helm passes as the docking rules say (after ${formatSpan(rules.docking.helmRequestTimeout)} without input).`);
  }
  if (s.time.clockKind === 'private' && s.time.relation !== 'live') lines.push('Its private clock holds where it is; nothing runs on while you are away.');
  lines.push(isNever(rules.expiry.craftRetention) ? 'Your ship is kept.' : `Your ship is kept for ${formatSpan(rules.expiry.craftRetention)} after you last fly it.`);
  return { status: statusParts.join(' · '), lines, tone: caution ? 'caution' : 'calm' };
}
