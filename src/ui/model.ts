/**
 * Display models built from a SimSnapshot: the exact strings the HUD panels and the MFD pages show. Both
 * render from these functions, so a number can never read differently on the two.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import {
  formatAltitude,
  formatBearing,
  formatCountdown,
  formatDeltaV,
  formatDistance,
  formatDuration,
  formatLatLon,
  formatNumber,
  formatPercent,
  formatRadAsDeg,
  formatSignedRange,
  formatTwr,
  formatWarp,
} from './format';

export function activeVesselOf(s: SimSnapshot): VesselSnapshot | null {
  return s.vessels.find((v) => v.id === s.activeVesselId) ?? null;
}

// ------------------------------------------------------------------------------------- landing target

export interface LandingTargetView {
  targetId: string;
  name: string;
  /** "Landing target" or "Recovery zone". */
  kindLabel: string;
  distance: string;
  bearing: string;
  /** "12.3 km ahead" / "4.5 km behind" / "on track"; "no ground track" below 0.1 m/s over the ground. */
  downRange: string;
  /** "1.2 km right" / "0.8 km left" / "on track"; "no ground track" below 0.1 m/s over the ground. */
  crossRange: string;
  /** Inside a recovery zone's radius (zones only). */
  insideZone: boolean;
  zoneRadius: string | null;
  /** "Impact" or "Entry point" and its miss from the target centre; null when nothing is predicted. */
  predicted: { label: 'Impact' | 'Entry point'; miss: string; missBearing: string; countdown: string; where: string } | null;
  /** Shown instead of `predicted` when it is null ("Predicted arrival: none"). */
  noPrediction: string;
  /** Raw numbers for graphics (m), +down = ahead, +cross = right. */
  raw: { distance: number; downRange: number; crossRange: number; bearingDeg: number; missDistance: number | null; missBearingDeg: number | null };
}

export function describeLandingTarget(s: SimSnapshot): LandingTargetView | null {
  const lt = s.readouts.landingTarget;
  if (!lt) return null;
  const target = s.surfaceTargets.find((t) => t.id === lt.targetId);
  const name = target?.name ?? lt.targetId;
  const isZone = target?.kind === 'recovery';
  const p = lt.predicted;
  // The readout resolves the separation along the ground track only when there is one (>= 0.1 m/s).
  const tracked = s.readouts.horizontalSpeed >= 0.1;
  return {
    targetId: lt.targetId,
    name,
    kindLabel: isZone ? 'Recovery zone' : 'Landing target',
    distance: formatDistance(lt.distance),
    bearing: formatBearing(lt.bearingDeg),
    downRange: tracked ? formatSignedRange(lt.downRange, 'ahead', 'behind') : 'no ground track',
    crossRange: tracked ? formatSignedRange(lt.crossRange, 'right', 'left') : 'no ground track',
    insideZone: isZone && target !== undefined && lt.distance <= target.radius,
    zoneRadius: isZone && target ? formatDistance(target.radius) : null,
    predicted: p
      ? {
          label: p.kind === 'impact' ? 'Impact' : 'Entry point',
          miss: formatDistance(p.missDistance),
          missBearing: formatBearing(p.missBearingDeg),
          countdown: formatCountdown(p.ut - s.ut),
          where: formatLatLon(p.latitude, p.longitude),
        }
      : null,
    noPrediction: 'none',
    raw: {
      distance: lt.distance,
      downRange: lt.downRange,
      crossRange: lt.crossRange,
      bearingDeg: lt.bearingDeg,
      missDistance: p ? p.missDistance : null,
      missBearingDeg: p ? p.missBearingDeg : null,
    },
  };
}

/** Label/value rows of the landing-target readout, identical on the HUD panel and the MFD landing page. */
export function landingTargetRows(v: LandingTargetView): [string, string][] {
  const rows: [string, string][] = [
    ['Distance', v.distance],
    ['Bearing', v.bearing],
    ['Down-range', v.downRange],
    ['Cross-range', v.crossRange],
  ];
  if (v.predicted) rows.push([`${v.predicted.label} miss`, `${v.predicted.miss} · ${v.predicted.missBearing}`]);
  else rows.push(['Predicted arrival', v.noPrediction]);
  return rows;
}

// --------------------------------------------------------------------------------------------- orbit

export interface OrbitView {
  apoapsis: string;
  apoapsisTime: string;
  periapsis: string;
  periapsisTime: string;
  inclination: string;
  eccentricity: string;
  period: string;
  /** False when the trajectory is open (escape): no apoapsis. */
  closed: boolean;
}

export function describeOrbit(s: SimSnapshot): OrbitView {
  const r = s.readouts;
  const closed = r.eccentricity < 1 && Number.isFinite(r.apoapsisAltitude) && r.apoapsisAltitude > -1e30;
  return {
    apoapsis: closed ? formatAltitude(r.apoapsisAltitude) : 'escape',
    apoapsisTime: r.timeToApoapsis !== null ? formatCountdown(r.timeToApoapsis) : '—',
    periapsis: formatAltitude(r.periapsisAltitude),
    periapsisTime: r.timeToPeriapsis !== null ? formatCountdown(r.timeToPeriapsis) : '—',
    inclination: formatRadAsDeg(r.inclination, 2),
    eccentricity: formatNumber(r.eccentricity, 4),
    period: r.period !== null ? formatDuration(r.period) : '—',
    closed,
  };
}

// --------------------------------------------------------------------------------------------- stages

export interface StageTileView {
  index: number;
  number: string;
  label: string;
  icon: string;
  actionKinds: string[];
  fired: boolean;
  next: boolean;
  deltaV: string;
  deltaVVac: string;
  twr: string;
  burnTime: string;
  /** 0..1 or null when the stage has no engines. */
  propellant: number | null;
  hasEngines: boolean;
}

export function describeStages(s: SimSnapshot): { tiles: StageTileView[]; lockout: boolean; nextStage: number; deltaVTotal: string } {
  const st = s.staging;
  const tiles = st.stages.map((info, i): StageTileView => {
    const hasEngines = info.propellantFraction !== null;
    return {
      index: i,
      number: `${i + 1}`,
      label: info.label,
      icon: info.icon,
      actionKinds: info.actionKinds,
      fired: info.fired,
      next: i === st.nextStage,
      deltaV: hasEngines ? formatDeltaV(info.deltaVNow) : '',
      deltaVVac: hasEngines ? formatDeltaV(info.deltaVVac) : '',
      twr: hasEngines ? formatTwr(info.twr) : '',
      burnTime: hasEngines ? formatDuration(info.burnTime) : '',
      propellant: info.propellantFraction,
      hasEngines,
    };
  });
  return { tiles, lockout: st.lockout, nextStage: st.nextStage, deltaVTotal: formatDeltaV(s.readouts.deltaVTotal) };
}

// ------------------------------------------------------------------------------------------ resources

export interface ResourceBarView {
  resourceId: string;
  name: string;
  fraction: number;
  amount: string;
}

export interface ResourceGroupView {
  id: string;
  label: string;
  bars: ResourceBarView[];
}

/**
 * Resources of the active vessel aggregated per stage group (VehicleDef.parts[].stageGroup, in the order of
 * VehicleDef.stageGroups). A vessel whose vehicle definition is unknown is shown as one group under its name.
 */
export function describeResources(s: SimSnapshot, defs: DefLibrary): ResourceGroupView[] {
  const v = activeVesselOf(s);
  if (!v) return [];
  const vehicle = defs.vehicles[v.vehicleId];
  const groupOf = new Map<string, string>();
  if (vehicle) for (const p of vehicle.parts) groupOf.set(p.id, p.stageGroup);
  const sums = new Map<string, Map<string, { amount: number; capacity: number }>>();
  for (const part of v.parts) {
    const def = defs.parts[part.def];
    if (!def?.resources) continue;
    const g = groupOf.get(part.instanceId) ?? v.id;
    let m = sums.get(g);
    if (!m) sums.set(g, (m = new Map()));
    for (const r of def.resources) {
      const e = m.get(r.resource) ?? { amount: 0, capacity: 0 };
      e.amount += part.resources[r.resource] ?? 0;
      e.capacity += r.capacity;
      m.set(r.resource, e);
    }
  }
  const order = vehicle ? vehicle.stageGroups.map((g) => g.id) : [];
  const ids = [...sums.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  return ids.map((id) => ({
    id,
    label: vehicle?.stageGroups.find((g) => g.id === id)?.label ?? v.name,
    bars: [...sums.get(id)!.entries()].map(([rid, e]) => ({
      resourceId: rid,
      name: defs.resources[rid]?.name ?? rid,
      fraction: e.capacity > 0 ? Math.max(0, Math.min(1, e.amount / e.capacity)) : 0,
      amount: e.capacity > 0 ? formatPercent(e.amount / e.capacity) : '—',
    })),
  }));
}

// ------------------------------------------------------------------------------------------- time warp

export interface WarpView {
  index: number;
  maxIndex: number;
  factor: string;
  onRails: boolean;
  /** "Limited to ×4: under acceleration or in atmosphere" when the sim caps warp. */
  limit: string | null;
}

export function describeWarp(s: SimSnapshot, levels: readonly number[]): WarpView {
  const w = s.warp;
  const capped = w.maxIndex < levels.length - 1;
  return {
    index: w.index,
    maxIndex: w.maxIndex,
    factor: formatWarp(w.factor),
    onRails: w.onRails,
    limit: capped && w.limitedBy ? `Limited to ${formatWarp(levels[w.maxIndex] ?? 1)}: ${w.limitedBy}` : null,
  };
}

// -------------------------------------------------------------------------------------------- node burn

export interface NodeBurnView {
  deltaV: string;
  burnTime: string;
  startIn: string;
  /** True inside the last 10 s before the burn should start (the HUD pulses). */
  imminent: boolean;
  started: boolean;
  insufficient: boolean;
}

export function describeNodeBurn(s: SimSnapshot): NodeBurnView | null {
  const nb = s.readouts.nodeBurn;
  if (!nb) return null;
  const t = nb.timeToBurnStart;
  return {
    deltaV: formatDeltaV(nb.dvRemainingMag),
    burnTime: nb.burnTime !== null ? formatDuration(nb.burnTime) : 'no engine',
    startIn: t !== null ? formatCountdown(t) : '—',
    imminent: t !== null && t >= 0 && t < 10,
    started: t !== null && t < 0,
    insufficient: nb.insufficientDeltaV,
  };
}

// ---------------------------------------------------------------------------------------- pad / target

export interface PadView {
  target: string;
  relativeInclination: string | null;
  planeCrossing: string | null;
  launchAzimuth: string | null;
}

/** Target and launch-opportunity readouts while landed (shown on the pad). */
export function describePad(s: SimSnapshot, defs: DefLibrary): PadView | null {
  const v = activeVesselOf(s);
  if (!v || (v.situation !== 'prelaunch' && v.situation !== 'landed')) return null;
  const r = s.readouts;
  const lw = r.launchWindow;
  return {
    target: r.targetBodyId ? (defs.bodies[r.targetBodyId]?.name ?? r.targetBodyId) : 'No target',
    relativeInclination: r.targetRelativeInclination !== null ? formatRadAsDeg(r.targetRelativeInclination, 2) : null,
    planeCrossing: lw ? formatCountdown(lw.timeToPlaneCrossing) : null,
    launchAzimuth: lw ? formatBearing(lw.launchAzimuthDeg) : null,
  };
}
