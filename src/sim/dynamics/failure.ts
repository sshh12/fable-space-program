/**
 * Structural failure (sim-design 10.2, 10.3): part destruction with explosion impulses, joints broken by
 * over-acceleration or q-alpha, crew g-dose.
 */
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { computeMassProps } from '../vessel/massProps';
import { eventPartId } from '../vessel/ids';
import { applyImpulse, separateVessel } from '../vessel/split';
import { partPoint, structureOf } from '../vessel/structure';
import { G_DOSE_LIMIT, type StepContext, type Vessel } from '../vessel/types';

export type DestroyCause = 'impact' | 'overheat' | 'overstress' | 'explosion';

/**
 * Blast of an exploding tank: total radial impulse carried by the expanding gas over the whole sphere per
 * kg of propellant left, N s / kg (about a tenth of the propellant mass in TNT at close range). A piece
 * receives the share its mean presented area cuts out of the sphere at its distance, so the push falls
 * off with the square of the distance and light fragments are not handed the impulse meant for a stage.
 */
export const EXPLOSION_IMPULSE_PER_KG = 150;
/** No piece gains more than this from one blast, m/s. */
export const EXPLOSION_MAX_DELTA_V = 60;
/** Chemical energy reported with the explosion event per kg of propellant, J / kg. */
export const EXPLOSION_ENERGY_PER_KG = 4.0e6;
export const EXPLOSION_MIN_FILL = 0.05;
export const JOINT_OVERSTRESS_TIME = 0.2;
export const G_DOSE_THRESHOLD = 10;
export const G_DOSE_RECOVERY_BELOW = 6;
export const G_DOSE_RECOVERY_RATE = 0.5;
/** Resources that some engine or thruster of the vessel burns: only those explode with their tank. */
function propellantIds(vessel: Vessel): Set<string> {
  const ids = new Set<string>();
  for (const p of vessel.parts) {
    for (const md of p.def.modules) {
      if (md.type === 'engine') for (const pr of md.propellants) ids.add(pr.resource);
      else if (md.type === 'rcs') ids.add(md.resource);
    }
  }
  return ids;
}

/**
 * Mean presented area of a vessel seen from a random direction, m^2: a quarter of its outer surface - the
 * side walls of its exposed part envelopes plus one pair of end faces of the widest part (the faces
 * between stacked parts are mated, parts inside a fairing are hidden).
 */
export function presentedArea(vessel: Vessel): number {
  let area = 0;
  let widest = 0;
  for (const p of vessel.parts) {
    if (p.shielded) continue;
    const b = p.def.bounds;
    const side = (Math.PI * b.radius * (b.yMax - b.yMin)) / 2;
    area += p.panel ? side / p.panel.count : side;
    if (!p.panel && b.radius > widest) widest = b.radius;
  }
  return area + (Math.PI * widest * widest) / 2;
}

/**
 * Destroy the given parts: events, explosions of tanks that still hold propellant, and separation of
 * whatever they held together. `vessel` keeps its identity as described in separateVessel.
 */
export function destroyParts(vessel: Vessel, indices: readonly number[], cause: DestroyCause, ctx: StepContext): void {
  if (indices.length === 0) return;
  const vesselId = vessel.id;
  const blasts: { pos: { x: number; y: number; z: number }; impulse: number }[] = [];
  let crewLost = false;
  const burnable = propellantIds(vessel);
  for (const i of indices) {
    const p = vessel.parts[i];
    if (!p) continue;
    const b = p.def.bounds;
    const centreVes = partPoint(p, [0, (b.yMin + b.yMax) / 2, 0]);
    ctx.events.push({ type: 'partDestroyed', ut: ctx.ut, vesselId, partId: eventPartId(vessel, p), cause, posVes: centreVes });
    let propellant = 0;
    let capacity = 0;
    const res = p.def.resources ?? [];
    for (let k = 0; k < res.length; k++) {
      if (!burnable.has(res[k]!.resource)) continue;
      propellant += p.resources[k]!;
      capacity += res[k]!.capacity;
    }
    const centre = v3.add(vessel.r, quat.rotate(vessel.q, centreVes));
    if (capacity > 0 && propellant > EXPLOSION_MIN_FILL * capacity) {
      ctx.events.push({ type: 'explosion', ut: ctx.ut, vesselId, posRoot: centre, energy: propellant * EXPLOSION_ENERGY_PER_KG });
      blasts.push({ pos: centre, impulse: propellant * EXPLOSION_IMPULSE_PER_KG });
    }
    for (const m of p.modules) {
      if (m.type === 'command' && m.crew > 0 && m.crewAlive) {
        m.crewAlive = false;
        crewLost = true;
      }
    }
  }
  if (crewLost) {
    vessel.crewAlive = false;
    ctx.events.push({ type: 'crewLost', ut: ctx.ut, vesselId, cause: cause === 'impact' ? 'Impact' : cause === 'overheat' ? 'Burned up' : 'Vehicle break-up' });
  }
  const hadHold = vessel.hold;
  const created = separateVessel(vessel, [], indices, ctx);
  const pieces = vessel.destroyed ? created : [vessel, ...created];
  for (const v of pieces) {
    if (hadHold === 'clamps') {
      const clamped = v.parts.some((p) => p.modules.some((m) => m.type === 'launchClamp' && !m.released));
      v.hold = clamped ? 'clamps' : null;
      if (!clamped) v.surface = 'none';
      v.anchor = null;
    } else if (hadHold === 'asleep') {
      v.hold = null;
      v.anchor = null;
    }
    if (v.parts.length > 0 && v.mp.mass <= 0) computeMassProps(v);
    // Radial blast on every surviving piece.
    if (blasts.length === 0 || v.hold !== null || !(v.mp.mass > 0)) continue;
    const area = presentedArea(v);
    const reach = Math.sqrt(area / Math.PI);
    const com = v3.add(v.r, quat.rotate(v.q, v.mp.com));
    for (const bl of blasts) {
      const d = v3.sub(com, bl.pos);
      const l = v3.len(d);
      const dir = l > 1e-6 ? v3.scale(d, 1 / l) : quat.rotate(v.q, { x: 0, y: 1, z: 0 });
      // Share of the sphere the piece covers; a piece right at the blast still catches a quarter at most.
      const dist = Math.max(l, reach);
      const impulse = Math.min((bl.impulse * area) / (4 * Math.PI * dist * dist), EXPLOSION_MAX_DELTA_V * v.mp.mass);
      applyImpulse(v, dir.x * impulse, dir.y * impulse, dir.z * impulse);
    }
  }
}

/**
 * Crew dose and joint over-stress from the filtered g-load, and the q-alpha limit of the exposed joints.
 * Breaking a joint splits the vessel.
 */
export function checkLoads(vessel: Vessel, dt: number, ctx: StepContext): void {
  const st = structureOf(vessel);
  const g = vessel.gLoad;
  // Crew.
  if (st.crew > 0 && vessel.crewAlive) {
    if (g > G_DOSE_THRESHOLD) vessel.gDose += (g - G_DOSE_THRESHOLD) * dt;
    else if (g < G_DOSE_RECOVERY_BELOW && vessel.gDose > 0) vessel.gDose = Math.max(0, vessel.gDose - G_DOSE_RECOVERY_RATE * dt);
    if (vessel.gDose > G_DOSE_LIMIT) {
      vessel.crewAlive = false;
      for (const p of vessel.parts) for (const m of p.modules) if (m.type === 'command') m.crewAlive = false;
      vessel.struct = null;
      ctx.events.push({ type: 'crewLost', ut: ctx.ut, vesselId: vessel.id, cause: 'G-LOC / fatal deceleration' });
    }
  }
  const qAlpha = vessel.aero.q * vessel.aero.aoa;
  const overG = g > st.minJointG;
  const overQ = st.anyQAlpha && qAlpha > 0;
  if (!overG && !overQ) {
    return;
  }
  let broken: number[] | null = null;
  const parts = vessel.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.parent < 0) continue;
    const j = p.def.joint;
    const over = g > j.maxAccelG || (j.maxQAlpha !== undefined && !p.shielded && qAlpha > j.maxQAlpha);
    if (over) {
      p.stress += dt;
      if (p.stress > JOINT_OVERSTRESS_TIME) (broken ??= []).push(i);
    } else if (p.stress > 0) {
      p.stress = Math.max(0, p.stress - dt);
    }
  }
  if (broken) {
    // Break the weakest over-stressed joint first (lowest limit); the pieces are re-evaluated next step.
    let worst = broken[0]!;
    for (const i of broken) {
      const a = parts[i]!.def.joint;
      const w = parts[worst]!.def.joint;
      if ((a.maxQAlpha ?? Infinity) < (w.maxQAlpha ?? Infinity) || a.maxAccelG < w.maxAccelG) worst = i;
    }
    const id = eventPartId(vessel, parts[worst]!);
    parts[worst]!.stress = 0;
    const hadHold = vessel.hold;
    const created = separateVessel(vessel, [worst], [], ctx);
    for (const v of [vessel, ...created]) {
      if (hadHold === 'asleep') {
        v.hold = null;
        v.anchor = null;
      }
    }
    ctx.events.push({ type: 'jointBroken', ut: ctx.ut, vesselId: vessel.id, partId: id });
  }
}

/** Mark collapsed legs (probe list from the contact model) and emit one jointBroken per leg part. */
export function collapseLegs(vessel: Vessel, legs: readonly { probe: { legs: { part: number; state: { broken: boolean[]; contact: boolean[]; compression: number[] } } | null; leg: number } }[], ctx: StepContext): void {
  for (const c of legs) {
    const lg = c.probe.legs;
    if (!lg || lg.state.broken[c.probe.leg]) continue;
    lg.state.broken[c.probe.leg] = true;
    lg.state.contact[c.probe.leg] = false;
    lg.state.compression[c.probe.leg] = 0;
    ctx.events.push({ type: 'jointBroken', ut: ctx.ut, vesselId: vessel.id, partId: eventPartId(vessel, vessel.parts[lg.part]!) });
  }
}

