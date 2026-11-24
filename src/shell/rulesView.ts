/**
 * "How this universe works" (ARCHITECTURE 23; frontend-ux 5.13): the rules screen's text, built from the rules
 * document in force (`UniverseRules`). Every number on it is a field of the document, read here and written
 * with the formatters below; none is a literal, so a universe with other rules (staging, local) renders its
 * own numbers with no code change. A duration a document states as the largest exact number ("nothing expires"
 * in the local rules) reads as "never".
 */
import type { UniverseRules } from '@/core/contracts/net';
import type { NumberFormat } from './format';

export interface RuleLine {
  /** The rules field the line states (dotted path into `UniverseRules`), for tests and the "changed" mark. */
  field: string;
  text: string;
}

export interface RuleSection {
  id: 'shared' | 'time' | 'ships' | 'collisions' | 'docking' | 'pads' | 'leaving' | 'fairPlay';
  title: string;
  lines: RuleLine[];
}

export interface RulesView {
  /** "Rules default · version 3" and when it took effect. */
  heading: string;
  effective: string;
  sections: RuleSection[];
}

const NBSP = ' ';

/** True for a duration that a document states as "never" (local rules: the largest number a double carries exactly). */
export const isNever = (seconds: number): boolean => !Number.isFinite(seconds) || seconds >= Number.MAX_SAFE_INTEGER;

/** A number with at most two significant decimals and no trailing zeros, grouped by thousands ("1,500", "2.5", "0.04"). */
const trim = (x: number): string => {
  const d = Math.abs(x) >= 10 ? 0 : Math.abs(x) >= 1 ? 1 : 2;
  const fixed = Math.abs(x).toFixed(d);
  const [int, frac] = fixed.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac !== undefined && Number(frac) !== 0 ? `${grouped}.${frac.replace(/0+$/, '')}` : grouped;
  return `${x < 0 && Number(fixed) !== 0 ? '−' : ''}${body}`;
};

/** A span of time in words: "45 s", "15 min", "2 h", "14 days", "250 years"; "never" for a document's never. */
export function formatSpan(seconds: number): string {
  if (isNever(seconds)) return 'never';
  const a = Math.abs(seconds);
  if (a < 120) return `${trim(seconds)}${NBSP}s`;
  if (a < 2 * 3600) return `${trim(seconds / 60)}${NBSP}min`;
  if (a < 2 * 86400) return `${trim(seconds / 3600)}${NBSP}h`;
  if (a < 2 * 365.25 * 86400) return `${trim(seconds / 86400)}${NBSP}days`;
  return `${trim(seconds / (365.25 * 86400))}${NBSP}years`;
}

/** A distance in words: "50 m", "1.5 km", "100 AU" above a light-hour. */
export function formatReach(m: number): string {
  const AU = 149_597_870_700;
  if (m >= 0.01 * AU) return `${trim(m / AU)}${NBSP}AU`;
  if (m >= 1000) return `${trim(m / 1000)}${NBSP}km`;
  return `${trim(m)}${NBSP}m`;
}

const metres = (m: number): string => `${trim(m)}${NBSP}m`;
const speed = (mps: number): string => `${trim(mps)}${NBSP}m/s`;

const line = (field: string, text: string): RuleLine => ({ field, text });

export function rulesView(rules: UniverseRules, fmt: Pick<NumberFormat, 'number'>, formatWallDate: (wallMs: number) => string): RulesView {
  const formatNumber = (x: number): string => fmt.number(x);
  const tonnes = (kg: number): string => `${fmt.number(kg / 1000)}${NBSP}t`;
  const t = rules.time;
  const e = rules.expiry;
  const p = rules.pads;
  const d = rules.disconnect;
  const c = rules.contact;
  const k = rules.docking;
  const l = rules.limits;
  const kept = (s: number): string => (isNever(s) ? 'kept for ever' : `kept ${formatSpan(s)}`);
  return {
    heading: `Rules ${rules.id} · version ${rules.version}`,
    effective: rules.effectiveWallMs > 0 ? `In force since ${formatWallDate(rules.effectiveWallMs)}` : 'In force since this universe began',
    sections: [
      {
        id: 'shared',
        title: 'One shared universe',
        lines: [
          line('', 'The server simulates everything: what you see is what everyone sees. No outcome is decided on your machine.'),
          line('expiry.lobbyObjectCap', `A universe holds at most ${formatNumber(e.lobbyObjectCap)} stored objects.`),
        ],
      },
      {
        id: 'time',
        title: 'Time',
        lines: [
          line('time.physicsWarpMax', `Every clock runs at 1x near other craft. While anything on a clock is under power or in an atmosphere, warp is held to ${trim(t.physicsWarpMax)}x.`),
          line('time.launchRangeRadius', `Within ${formatReach(t.launchRangeRadius)} of a launch site and below ${formatReach(t.launchRangeAltitude)} a clock runs at 1x.`),
          line('time.readyCheckTime', `Warp on a shared clock is a proposal: everyone on it has ${formatSpan(t.readyCheckTime)} to agree.`),
          line('time.encounterLeadTime', `A clock is back at 1x ${formatSpan(t.encounterLeadTime)} before a predicted encounter closer than ${metres(t.encounterMargin)}.`),
          line('time.advanceLimitDefault', `You may take your craft at most ${formatSpan(t.advanceLimitDefault)} ahead of the live clock (${formatSpan(t.advanceLimitStation)} for a station module); no clock runs more than ${formatSpan(t.leadCap)} ahead.`),
          line('time.cohortBucket', `When the pads are busy you may start on a cohort clock: buckets of ${formatSpan(t.cohortBucket)}, offered up to ${formatSpan(t.cohortHorizon)} ahead, from a wait of ${formatSpan(t.cohortOfferWait)}.`),
        ],
      },
      {
        id: 'ships',
        title: 'Your ships stay',
        lines: [
          line('expiry.craftRetention', `A ship is ${kept(e.craftRetention)} after you last fly it. You may keep ${formatNumber(e.shipSlots)} ships.`),
          line('expiry.unownedAssemblyRetention', `An assembly with no owner left is ${kept(e.unownedAssemblyRetention)}; an abandoned craft is ${kept(e.unownedCraftRetention)}.`),
          line('expiry.debrisRetention', `Debris is ${kept(e.debrisRetention)} after it leaves every encounter (at most ${formatNumber(e.debrisPerAccount)} pieces per player); a wreck on the ground is ${kept(e.wreckRetention)}.`),
          line('expiry.lostDistance', `A craft further than ${formatReach(e.lostDistance)} from the centre of the system is lost.`),
          line('expiry.outageExtensionThreshold', `An outage longer than ${formatSpan(e.outageExtensionThreshold)} extends every deadline by its length.`),
          line('expiry.accountRetention', `An account with no ships is ${isNever(e.accountRetention) ? 'kept for ever' : `deleted ${formatSpan(e.accountRetention)} after its last session`}.`),
        ],
      },
      {
        id: 'collisions',
        title: 'Collisions are real',
        lines: [
          line('contact.defaultCrashTolerance', `Craft collide with each other. A part without a stated tolerance breaks in a contact faster than ${speed(c.defaultCrashTolerance)}.`),
          line('contact.hypervelocitySpeed', `Above ${speed(c.hypervelocitySpeed)} of closing speed both craft are destroyed.`),
          line('contact.fragmentLifetime', `A collision makes at most ${formatNumber(c.maxFragmentsPerCollision)} new pieces; fragments under ${trim(c.fragmentMassLimit)}${NBSP}kg last ${formatSpan(c.fragmentLifetime)}.`),
          line('', 'Blocking a player hides their name and messages; their craft stays physical.'),
        ],
      },
      {
        id: 'docking',
        title: 'Docking and shared control',
        lines: [
          line('docking.hardDockDwell', `A soft capture becomes a hard dock after ${formatSpan(k.hardDockDwell)} within ${trim(k.hardDockOffset * 1000)}${NBSP}mm, ${trim(k.hardDockAngleDeg)}° and ${trim(k.hardDockSpeed * 1000)}${NBSP}mm/s.`),
          line('docking.helmRequestTimeout', `The helm passes on acceptance, or after ${formatSpan(k.helmRequestTimeout)} without input from the pilot who holds it.`),
          line('docking.maxCraftPerAssembly', `An assembly holds at most ${formatNumber(k.maxCraftPerAssembly)} craft and ${formatNumber(k.maxPartsPerAssembly)} parts.`),
          line('docking.portCooldownTime', `After an undock both ports refuse each other for ${formatSpan(k.portCooldownTime)} or until ${metres(k.portCooldownDistance)} apart.`),
        ],
      },
      {
        id: 'pads',
        title: 'Pads',
        lines: [
          line('pads.reservationHold', `A pad is held for you for ${formatSpan(p.reservationHold)} through the briefing and the flight down.`),
          line('pads.maxStay', `You may stay on a pad for ${formatSpan(p.maxStay)} (${formatSpan(p.stayExtension)} more while engines run).`),
          line('pads.disconnectGrace', `Lose the connection on the pad and the vehicle is rolled back after ${formatSpan(p.disconnectGrace)}.`),
          line('pads.clearAltitude', `The pad is clear once you are above ${formatReach(p.clearAltitude)} and ${formatReach(p.clearDistance)} away; it is made safe in ${formatSpan(p.safingTime)}.`),
          line('pads.classLimits', `Heavy pads take ${tonnes(p.classLimits.heavy.maxLiftoffMass)} and ${metres(p.classLimits.heavy.maxDiameter)}, medium ${tonnes(p.classLimits.medium.maxLiftoffMass)} and ${metres(p.classLimits.medium.maxDiameter)}, light ${tonnes(p.classLimits.light.maxLiftoffMass)} and ${metres(p.classLimits.light.maxDiameter)}. A pad hosts its class and anything smaller.`),
          line('pads.rangeSafetyAltitude', `Below ${formatReach(p.rangeSafetyAltitude)} a vehicle heading into another pad's keep-out zone is destroyed by the range.`),
          line('', 'When every pad of your class is taken you wait in a visible queue: your place and an estimate, and you may leave it.'),
        ],
      },
      {
        id: 'leaving',
        title: 'Leaving and losing the connection',
        lines: [
          line('disconnect.lossTimeout', `A connection is lost after ${formatSpan(d.lossTimeout)} without a message.`),
          line('disconnect.soloLatchTime', `Flying alone, your controls stay as they were for ${formatSpan(d.soloLatchTime)}, then rotation stops and the throttle closes.`),
          line('disconnect.sharedThrottleLatch', `Near another player's craft the throttle closes after ${formatSpan(d.sharedThrottleLatch)}.`),
          line('disconnect.reconnectGrace', `The server carries your flight for ${formatSpan(d.reconnectGrace)}. After that, or when you leave, the throttle closes and the craft flies on unattended to rest; no stage fires and no parachute opens for you.`),
        ],
      },
      {
        id: 'fairPlay',
        title: 'Fair play',
        lines: [
          line('limits.commandsPerSecond', `No cheats exist: the server decides outcomes. Each connection may send ${formatNumber(l.commandsPerSecond)} commands and ${formatNumber(l.inputsPerSecond)} inputs a second.`),
          line('limits.accountsPerAddressPerHour', `At most ${formatNumber(l.accountsPerAddressPerHour)} new accounts per address per hour.`),
        ],
      },
    ],
  };
}
