/**
 * The debris rules of a single clock and the record of what became of every vessel the session removed
 * (ARCHITECTURE 7.4 "Growth is bounded", 15.5): small uncontrollable fragments expire, and the count of
 * uncontrollable vessels is capped, the oldest outside the island going first. It is not hosting: the
 * expiry sweep and the debris budgets of `src/universe` take it over (MIGRATION_V2 section 5).
 */
import { DEFAULT_UNIVERSE_RULES } from '@/core/contracts/net';
import { padLocationOf } from '@/core/defs/sites';
import { quat } from '@/core/math/quat';
import { DEG, RAD } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { dirFromLatLon } from '../frames/bodyFrames';
import type { FarObject } from '../island';
import type { Vessel } from '../vessel';
import type { World } from './sim';

/** Uncontrollable vessels a session keeps. */
export const MAX_DEBRIS = 24;
/** Uncontrollable fragments lighter than this (kg) expire after FRAGMENT_LIFETIME seconds: the default rules' contact.fragmentMassLimit and fragmentLifetime (a session reads its own rules document). */
export const FRAGMENT_MASS = DEFAULT_UNIVERSE_RULES.contact.fragmentMassLimit;
export const FRAGMENT_LIFETIME = DEFAULT_UNIVERSE_RULES.contact.fragmentLifetime;

/** What became of a vessel the world removed. */
export interface DebrisFate {
  vesselId: string;
  name: string;
  ut: number;
  reason: 'burnedUp' | 'impact' | 'expired' | 'limit';
  bodyId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  /** Great-circle distance from the scenario's launch site, m (-1 when on another body). */
  distanceFromSite: number;
}

export class Debris {
  readonly fates: DebrisFate[] = [];

  constructor(
    private readonly w: World,
    private readonly startPad: string,
  ) {}

  /** The record of a vessel that is gone. `announce`: the removal has no event yet. */
  fate(v: Vessel, bodyId: string, reason: DebrisFate['reason'], ut: number, announce: boolean): void {
    const w = this.w;
    const body = w.frames.info(bodyId);
    const dirFixed = quat.rotateInv(w.frames.orientAt(bodyId, ut), v3.normalize(v.r));
    const site = w.defs.sites[w.scenario.site]!;
    const launchedFrom = padLocationOf(site, this.startPad);
    const siteDir = dirFromLatLon(launchedFrom.latDeg * DEG, launchedFrom.lonDeg * DEG);
    this.fates.push({
      vesselId: v.id,
      name: v.name,
      ut,
      reason,
      bodyId,
      latitudeDeg: Math.atan2(dirFixed.z, Math.hypot(dirFixed.x, dirFixed.y)) * RAD,
      longitudeDeg: Math.atan2(dirFixed.y, dirFixed.x) * RAD,
      distanceFromSite: site.bodyId === bodyId ? v3.angle(siteDir, dirFixed) * body.radius : -1,
    });
    if (announce) w.view.push({ type: 'vesselRemoved', ut, vesselId: v.id, reason });
    w.policy.drop(`vessel:${v.id}`);
  }

  /** An object outside the island is gone (the far set's report): out of the roster at the next control tick, with its fate and its event. */
  gone(v: Vessel, bodyId: string, reason: 'burnedUp' | 'impact', ut: number): void {
    this.w.gone.add(v);
    this.fate(v, bodyId, reason, ut, true);
  }

  /** Control-tick cadence: small fragments expire; the cap removes the oldest uncontrollable vessel outside the island. */
  sweep(): void {
    const w = this.w;
    const contact = w.rules.contact;
    let debris = 0;
    for (const v of w.roster.slice()) {
      if (w.gone.has(v) || v === w.active || w.controllable(v)) continue;
      debris++;
      if (v.mp.mass < contact.fragmentMassLimit && v.age > contact.fragmentLifetime) {
        this.expire(v, 'expired');
        debris--;
      }
    }
    while (debris > MAX_DEBRIS) {
      let oldest: FarObject | null = null;
      for (const o of w.far.objects) {
        if (o.removed || o.controllable) continue;
        if (!oldest || o.vessel.age > oldest.vessel.age) oldest = o;
      }
      if (!oldest) break;
      this.expire(oldest.vessel, 'limit');
      debris--;
    }
  }

  private expire(v: Vessel, reason: 'expired' | 'limit'): void {
    const w = this.w;
    const m = w.island.member(v.id);
    const o = m ? null : w.far.find(v.id);
    const bodyId = m ? w.island.bodyId : o!.bodyId;
    if (m) w.island.remove(v.id, 'removed');
    else o!.removed = true;
    this.fate(v, bodyId, reason, w.ut, true);
    w.gone.add(v);
  }
}
