/**
 * Plume clusters: everything that is drawn as an exhaust jet volume, gathered from a vessel snapshot.
 * Pure (no GPU): engines of one part type and plume look on a vessel form one cluster (a nine-engine
 * booster is one volume with nine jets that merge downstream); every firing RCS thruster is a small
 * cluster of its own.
 */
import type { DefLibrary, ModuleDef, PartDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat, v3, type Vec3 } from '@/core/math';
import type { PlumeLookDef, VfxData } from './data';
import { DEFAULT_VISIBLE_FRACTION, engineEmissionState, jetBoundaryRadius, jetBulkRadius, jetShape, type JetShape, type NozzleGeometry } from './plumeModel';

/** Jets marched per cluster volume (larger groups are split). */
export const MAX_CLUSTER_NOZZLES = 12;
/** RCS thrusters drawn per vessel (the strongest first). */
export const MAX_RCS_PER_VESSEL = 24;

type EngineModule = Extract<ModuleDef, { type: 'engine' }>;
type EngineState = Extract<ModuleState, { type: 'engine' }>;

export interface NozzleInstance {
  /** Exit centre and unit exhaust direction in the vessel frame (gimbal applied). */
  posVes: Vec3;
  dirVes: Vec3;
  exitRadius: number;
  shape: JetShape;
  /** Emission state: throttle 0..1, distance of the start-up front (m), start-up flash gain, residual flame 0..1. */
  throttle: number;
  front: number;
  flash: number;
  residual: number;
  /** Thrust of this nozzle, N. */
  thrust: number;
  seed: number;
}

export interface PlumeCluster {
  /** Stable id: vessel, look, part type and chunk. */
  key: string;
  kind: 'engine' | 'rcs';
  vesselId: string;
  lookId: string;
  look: PlumeLookDef;
  nozzles: NozzleInstance[];
  /** Totals of the cluster. */
  thrust: number;
  massFlow: number;
  ambientPressure: number;
  /** Centroid of the exits and mean unit exhaust direction, vessel frame. */
  centreVes: Vec3;
  axisVes: Vec3;
  /** Extent of the volume in the cluster frame (origin = centroid, +X = axis): x in [xMin, length], radius about X. */
  xMin: number;
  length: number;
  radius: number;
  /** A cone about +X that holds everything visible: radius coneR0 + coneSlope x (tighter than the box; clips the march). */
  coneR0: number;
  coneSlope: number;
  /** The jets of a cluster merge into one: distance along the axis where that begins, and the merged jet (null for a single jet or diverging jets). */
  mergeDistance: number;
  merged: { shape: JetShape; exitRadius: number; scale: number } | null;
}

const isEngine = (m: ModuleDef | undefined): m is EngineModule => m?.type === 'engine';

function partToVes(part: PartSnapshot, p: Vec3): Vec3 {
  return v3.add(quat.rotate(part.localRot, p), part.localPos);
}

/** Deflect a part-frame vector by the gimbal angles about the part's X and Z axes (as the simulation does). */
function gimbal(v: Vec3, gx: number, gz: number): Vec3 {
  if (gx === 0 && gz === 0) return v;
  // v + gx (X x v) + gz (Z x v)
  return { x: v.x - gz * v.y, y: v.y - gx * v.z + gz * v.x, z: v.z + gx * v.y };
}

function finishCluster(c: PlumeCluster, geometry: NozzleGeometry, visibleFraction: number): void {
  const n = c.nozzles.length;
  let centre = v3.zero();
  let axis = v3.zero();
  for (const nz of c.nozzles) {
    centre = v3.add(centre, nz.posVes);
    axis = v3.add(axis, nz.dirVes);
  }
  c.centreVes = v3.scale(centre, 1 / n);
  c.axisVes = v3.lenSq(axis) > 1e-12 ? v3.normalize(axis) : v3.clone(c.nozzles[0]!.dirVes);

  let length = 0;
  let radius = 0;
  let xMin = 0;
  let ringRadius = 0;
  let divergence = 0;
  let reMax = 0;
  for (const nz of c.nozzles) {
    const d = v3.sub(nz.posVes, c.centreVes);
    const along = v3.dot(d, c.axisVes);
    const lateral = v3.len(v3.addScaled(d, c.axisVes, -along));
    const cosA = Math.min(1, v3.dot(nz.dirVes, c.axisVes));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    length = Math.max(length, along + nz.shape.visibleLength * cosA + nz.shape.visibleRadius * sinA);
    radius = Math.max(radius, lateral + nz.shape.visibleLength * sinA + nz.shape.visibleRadius);
    xMin = Math.min(xMin, along - 0.6 * nz.exitRadius - nz.shape.visibleRadius * sinA);
    ringRadius = Math.max(ringRadius, lateral);
    divergence = Math.max(divergence, sinA);
    reMax = Math.max(reMax, nz.exitRadius);
  }

  c.mergeDistance = Infinity;
  c.merged = null;
  if (n >= 2 && divergence < 0.12) {
    // Mean distance from each exit to its nearest neighbour.
    let spacing = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let j = 0; j < n; j++) if (j !== i) best = Math.min(best, v3.dist(c.nozzles[i]!.posVes, c.nozzles[j]!.posVes));
      spacing += best / n;
    }
    const first = c.nozzles[0]!;
    // Where neighbouring jet boundaries meet (at least two exit radii, at most 30).
    let xm = 30 * reMax;
    for (let k = 1; k <= 60; k++) {
      const x = (k / 60) * 30 * reMax;
      if (2 * jetBoundaryRadius(first.shape, first.exitRadius, x) >= spacing * 1.15) {
        xm = x;
        break;
      }
    }
    c.mergeDistance = Math.max(2 * reMax, xm);
    const exitRadius = ringRadius + reMax;
    const throttle = c.nozzles.reduce((s, nz) => s + Math.max(nz.throttle, 0.12 * nz.residual), 0) / n;
    const shape = jetShape(c.look, { ...geometry, exitRadius }, throttle, c.ambientPressure, { lengthRadius: reMax * Math.sqrt(n), visibleFraction });
    // The merged jet carries what the n jets carry: n re^2 = scale x R^2.
    c.merged = { shape, exitRadius, scale: (n * reMax * reMax) / (exitRadius * exitRadius) };
    length = Math.max(length, shape.visibleLength);
    radius = Math.max(radius, shape.visibleRadius);
  }
  c.length = length;
  c.radius = radius;
  c.xMin = xMin;

  // Bounding cone: the largest radius anything visible reaches at 24 stations along the axis.
  const need = (x: number): number => {
    let r = 0;
    for (const nz of c.nozzles) {
      const d = v3.sub(nz.posVes, c.centreVes);
      const along = v3.dot(d, c.axisVes);
      const lateral = v3.len(v3.addScaled(d, c.axisVes, -along));
      const cosA = Math.max(0.2, Math.min(1, v3.dot(nz.dirVes, c.axisVes)));
      const xi = Math.max(0, (x - along) / cosA);
      const rb = jetBoundaryRadius(nz.shape, nz.exitRadius, xi);
      const core = 2.6 * c.look.core.radius * jetBulkRadius(nz.shape, nz.exitRadius, xi);
      const burn = nz.shape.oxygen > 0.002 ? 1.9 * rb + nz.exitRadius : 0;
      r = Math.max(r, lateral + xi * Math.sqrt(1 - cosA * cosA) + Math.max(core, burn, 1.5 * nz.exitRadius));
    }
    if (c.merged) {
      const m = c.merged;
      const rb = jetBoundaryRadius(m.shape, m.exitRadius, x);
      r = Math.max(r, 2.6 * c.look.core.radius * jetBulkRadius(m.shape, m.exitRadius, x), m.shape.oxygen > 0.002 ? 1.9 * rb + reMax : 0);
    }
    return Math.min(r, radius);
  };
  c.coneR0 = need(0) * 1.05;
  let slope = 0;
  for (let i = 1; i <= 24; i++) {
    const x = (length * i) / 24;
    slope = Math.max(slope, (need(x) - c.coneR0) / x);
  }
  c.coneSlope = slope;
}

/** All exhaust jets of one vessel: engine clusters first, then firing RCS thrusters. */
export function gatherPlumeClusters(defs: DefLibrary, data: VfxData, vessel: VesselSnapshot, exposure = 0): PlumeCluster[] {
  // What is visible depends on the exposure: 0.002 in the pre-exposed image is the cut-off.
  const fractionOf = (look: PlumeLookDef): number => (exposure > 0 ? 0.002 / (exposure * Math.max(look.core.luminance, 1)) : DEFAULT_VISIBLE_FRACTION);
  const out: PlumeCluster[] = [];
  const open = new Map<string, { cluster: PlumeCluster; geometry: NozzleGeometry; chunk: number }>();
  const rcs: { cluster: PlumeCluster; geometry: NozzleGeometry; level: number }[] = [];
  const rcsLook = data.plumes[data.rcs.plume]!;

  for (const part of vessel.parts) {
    const def: PartDef | undefined = defs.parts[part.def];
    if (!def) continue;
    for (let mi = 0; mi < part.modules.length; mi++) {
      const state = part.modules[mi]!;
      const mdef = def.modules[mi];
      if (state.type === 'engine' && isEngine(mdef)) {
        const look = data.plumes[mdef.plume];
        if (!look) continue;
        const es = engineEmissionState(look, state as EngineState);
        if (es.throttle <= 0 && es.residual <= 0) continue;
        const groupKey = `${mdef.plume}|${part.def}|${mi}`;
        for (let ni = 0; ni < mdef.nozzles.length; ni++) {
          const nd = mdef.nozzles[ni]!;
          const geometry: NozzleGeometry = { exitRadius: nd.exitDiameter / 2, exitPressure: nd.exitPressure, chamberPressure: mdef.chamberPressure };
          let entry = open.get(groupKey);
          if (!entry || entry.cluster.nozzles.length >= MAX_CLUSTER_NOZZLES) {
            const chunk = entry ? entry.chunk + 1 : 0;
            if (entry) finishCluster(entry.cluster, entry.geometry, fractionOf(look));
            const cluster: PlumeCluster = {
              key: `${vessel.id}|${groupKey}|${chunk}`,
              kind: 'engine',
              vesselId: vessel.id,
              lookId: mdef.plume,
              look,
              nozzles: [],
              thrust: 0,
              massFlow: 0,
              ambientPressure: state.ambientPressure,
              centreVes: v3.zero(),
              axisVes: v3.unitY(),
              xMin: 0,
              length: 0,
              radius: 0,
              coneR0: 0,
              coneSlope: 0,
              mergeDistance: Infinity,
              merged: null,
            };
            entry = { cluster, geometry, chunk };
            open.set(groupKey, entry);
            out.push(cluster);
          }
          const drawThrottle = Math.max(es.throttle, 0.12 * es.residual);
          const g = state.gimbal;
          entry.cluster.nozzles.push({
            posVes: partToVes(part, gimbal(v3.fromTuple(nd.pos), g[0], g[1])),
            dirVes: v3.normalize(quat.rotate(part.localRot, gimbal(v3.fromTuple(nd.dir), g[0], g[1]))),
            exitRadius: geometry.exitRadius,
            shape: jetShape(look, geometry, drawThrottle, state.ambientPressure, { visibleFraction: fractionOf(look) }),
            throttle: es.throttle,
            front: es.front,
            flash: es.flash,
            residual: es.residual,
            thrust: state.thrust / mdef.nozzles.length,
            seed: (out.length * 31 + entry.cluster.nozzles.length * 7 + ni) % 97,
          });
          entry.cluster.thrust += state.thrust / mdef.nozzles.length;
          entry.cluster.massFlow += state.massFlow / mdef.nozzles.length;
        }
      } else if (state.type === 'rcs' && mdef?.type === 'rcs' && state.enabled) {
        for (let ti = 0; ti < mdef.thrusters.length; ti++) {
          const level = state.levels[ti] ?? 0;
          if (level < data.rcs.minLevel) continue;
          const td = mdef.thrusters[ti]!;
          const geometry: NozzleGeometry = {
            exitRadius: 0.5 * data.rcs.exitDiameterPerSqrtNewton * Math.sqrt(td.thrust),
            exitPressure: data.rcs.exitPressure,
            chamberPressure: data.rcs.chamberPressure,
          };
          const cluster: PlumeCluster = {
            key: `${vessel.id}|rcs|${part.instanceId}|${mi}|${ti}`,
            kind: 'rcs',
            vesselId: vessel.id,
            lookId: data.rcs.plume,
            look: rcsLook,
            nozzles: [
              {
                posVes: partToVes(part, v3.fromTuple(td.pos)),
                dirVes: v3.normalize(quat.rotate(part.localRot, v3.fromTuple(td.dir))),
                exitRadius: geometry.exitRadius,
                shape: jetShape(rcsLook, geometry, level, vessel.aero.pressure, { visibleFraction: fractionOf(rcsLook) }),
                throttle: level,
                front: 1e9,
                flash: 0,
                residual: 0,
                thrust: td.thrust * level,
                seed: (ti * 13 + mi * 5) % 97,
              },
            ],
            thrust: td.thrust * level,
            massFlow: (td.thrust * level) / (mdef.isp * 9.80665),
            ambientPressure: vessel.aero.pressure,
            centreVes: v3.zero(),
            axisVes: v3.unitY(),
            xMin: 0,
            length: 0,
            radius: 0,
            coneR0: 0,
            coneSlope: 0,
            mergeDistance: Infinity,
            merged: null,
          };
          rcs.push({ cluster, geometry, level });
        }
      }
    }
  }
  for (const entry of open.values()) finishCluster(entry.cluster, entry.geometry, fractionOf(entry.cluster.look));
  rcs.sort((a, b) => b.level - a.level);
  for (const r of rcs.slice(0, MAX_RCS_PER_VESSEL)) {
    finishCluster(r.cluster, r.geometry, fractionOf(rcsLook));
    out.push(r.cluster);
  }
  return out;
}
