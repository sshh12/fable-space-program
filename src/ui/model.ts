/**
 * Display models built from a SimSnapshot: the exact strings the HUD panels and the MFD pages show. Both
 * render from these functions, so a number can never read differently on the two.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import {
  formatAltitude,
  formatApsis,
  formatBearing,
  formatCountdown,
  formatDeg,
  formatDeltaV,
  formatDistance,
  formatDuration,
  formatG,
  formatLatLon,
  formatNumber,
  formatPercent,
  formatRadAsDeg,
  formatSignedRange,
  formatSpeed,
  formatTwr,
  formatVerticalSpeed,
  formatWarp,
  verticalTrend,
  type VerticalTrend,
} from './format';

export function activeVesselOf(s: SimSnapshot): VesselSnapshot | null {
  return s.vessels.find((v) => v.id === s.activeVesselId) ?? null;
}

/** True while the vessel rests on a surface (pad, landed, splashed). */
export function isLanded(v: VesselSnapshot | null): boolean {
  return v !== null && (v.situation === 'prelaunch' || v.situation === 'landed' || v.situation === 'splashed');
}

// --------------------------------------------------------------------------------------- flight data

/** Below this radar altitude (m), in flight, the automatic altimeter reads radar altitude. */
export const RADAR_ALTITUDE_SWITCH = 2000;

export type AltitudeMode = 'auto' | 'asl' | 'radar';

/** Altimeter source: `auto` = radar below RADAR_ALTITUDE_SWITCH in flight, sea level otherwise. */
export function altitudeSource(s: SimSnapshot, mode: AltitudeMode = 'auto'): 'radar' | 'asl' {
  if (mode !== 'auto') return mode;
  return !isLanded(activeVesselOf(s)) && s.readouts.altitudeRadar < RADAR_ALTITUDE_SWITCH ? 'radar' : 'asl';
}

/**
 * Name of the altitude reference of the body under the vessel: "sea level" on a body with an ocean, "datum"
 * (the mean-radius reference surface) on any other (the Moon has no sea).
 */
export function altitudeDatumName(s: SimSnapshot, defs: DefLibrary): 'sea level' | 'datum' {
  const v = activeVesselOf(s);
  const body = v ? defs.bodies[v.bodyId] : undefined;
  return body && body.ocean !== null && body.ocean !== undefined ? 'sea level' : 'datum';
}

/**
 * G-load scale shared by the HUD gauge and the MFD pages, from the sim's crew model: below 6 g a g-dose
 * recovers, above 10 g it accumulates toward the fatal limit (src/sim/dynamics/failure.ts); the gauge reads to
 * 12 g.
 */
export const G_SCALE = { caution: 6, limit: 10, full: 12 } as const;

/** Tone of a g-load reading on the shared scale. */
export function gTone(g: number): 'normal' | 'caution' | 'warning' {
  return g >= G_SCALE.limit ? 'warning' : g >= G_SCALE.caution ? 'caution' : 'normal';
}

export interface FlightView {
  altitudeSource: 'radar' | 'asl';
  altitude: string;
  /** "+12.3 m/s" / "−4.0 m/s" / "0.0 m/s" (formatVerticalSpeed); the direction is `verticalTrend`. */
  verticalSpeed: string;
  verticalTrend: VerticalTrend;
  horizontalSpeed: string;
  /** Speed of the navball mode: surface speed or orbital speed. */
  speedMode: 'surface' | 'orbit';
  speed: string;
  pitch: string;
  /** Compass heading of the nose, "087°". */
  heading: string;
  roll: string;
  throttle: string;
  gLoad: string;
}

/** Primary flight data, the same strings on the HUD and the MFD flight / landing pages. */
export function describeFlight(s: SimSnapshot, mode: AltitudeMode = 'auto'): FlightView {
  const r = s.readouts;
  const src = altitudeSource(s, mode);
  const speedMode = s.navball.mode === 'surface' ? 'surface' : 'orbit';
  return {
    altitudeSource: src,
    altitude: formatAltitude(src === 'radar' ? r.altitudeRadar : r.altitudeAsl),
    verticalSpeed: formatVerticalSpeed(r.verticalSpeed),
    verticalTrend: verticalTrend(r.verticalSpeed),
    horizontalSpeed: formatSpeed(r.horizontalSpeed),
    speedMode,
    speed: formatSpeed(speedMode === 'surface' ? r.speedSurface : r.speedOrbital),
    pitch: formatDeg(s.navball.pitchDeg),
    heading: formatBearing(s.navball.headingDeg),
    roll: formatDeg(s.navball.rollDeg),
    throttle: formatPercent(r.throttle),
    gLoad: formatG(r.gLoad),
  };
}

// ------------------------------------------------------------------------------------- landing target

export interface LandingTargetView {
  targetId: string;
  name: string;
  /** "Landing target" or "Recovery zone". */
  kindLabel: string;
  distance: string;
  /** Compass bearing "087°", or "on target" within ON_TARGET_DISTANCE. */
  bearing: string;
  /** "12.3 km ahead" / "4.5 km behind" / "on track"; "no ground track" below 0.1 m/s over the ground. */
  downRange: string;
  /** "1.2 km right" / "0.8 km left" / "on track"; "no ground track" below 0.1 m/s over the ground. */
  crossRange: string;
  /**
   * True while there is a ground track (horizontal speed >= 0.1 m/s): only then are the readout's down-range and
   * cross-range meaningful (the sim reports both as 0 below that speed, whatever the distance).
   */
  tracked: boolean;
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

/**
 * Within this distance (m) of the target the vessel is on it: the bearing reads "on target" (a compass bearing
 * to a point under the vessel is noise), the same threshold as a range reading "on track".
 */
export const ON_TARGET_DISTANCE = 0.5;

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
    bearing: lt.distance < ON_TARGET_DISTANCE ? 'on target' : formatBearing(lt.bearingDeg),
    downRange: tracked ? formatSignedRange(lt.downRange, 'ahead', 'behind') : 'no ground track',
    crossRange: tracked ? formatSignedRange(lt.crossRange, 'right', 'left') : 'no ground track',
    tracked,
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

/**
 * Label/value rows of the landing-target readout, identical on the HUD panel and the MFD landing page. Rows
 * without data collapse: with no ground track (stationary) down-range and cross-range are one "Ground track:
 * none" row, and with neither a track nor a prediction the arrival row joins it ("Track · arrival: none").
 */
export function landingTargetRows(v: LandingTargetView): [string, string][] {
  const rows: [string, string][] = [
    ['Distance', v.distance],
    ['Bearing', v.bearing],
  ];
  if (v.tracked) rows.push(['Down-range', v.downRange], ['Cross-range', v.crossRange]);
  else if (v.predicted) rows.push(['Ground track', 'none']);
  if (v.predicted) rows.push([`${v.predicted.label} miss`, `${v.predicted.miss} · ${v.predicted.missBearing}`]);
  else if (v.tracked) rows.push(['Predicted arrival', v.noPrediction]);
  else rows.push(['Track · arrival', 'none']);
  return rows;
}

/** True for the prediction row of landingTargetRows (drawn under a rule). */
export const isPredictionRow = (label: string): boolean => label.endsWith(' miss') || label === 'Predicted arrival' || label === 'Track · arrival';

/** Below this separation (m) the readout's down-range / cross-range carry no usable track direction. */
const TRACK_RECOVERY_MIN_RANGE = 1;

export interface LandingScope {
  /** Target relative to the vessel on the ground, metres east and north. */
  east: number;
  north: number;
  /**
   * Compass direction of the ground track (degrees in [0, 360)), recovered from the readout's own down-range
   * and cross-range; null without a ground track (below 0.1 m/s) and within 1 m of the target.
   */
  trackDeg: number | null;
}

/**
 * Geometry of the landing scope (MFD landing page). The scope is north-up at every speed: the target is placed
 * from the distance and the compass bearing, which the readout gives whatever the speed, so a target 400 m
 * away never sits on the vessel symbol while hovering (when down-range and cross-range are both 0), and the
 * picture does not jump or swing as a slow drift crosses the 0.1 m/s ground-track threshold or wanders in
 * direction. The ground track is drawn as a line at `trackDeg`: with the target at bearing B, down-range =
 * d cos(B - T) and cross-range = d sin(B - T) (cross-range positive = target right of the track), so
 * T = B - atan2(cross, down), and the line agrees with the "ahead / right" rows by construction.
 */
export function landingScope(v: LandingTargetView): LandingScope {
  const b = (v.raw.bearingDeg * Math.PI) / 180;
  const east = v.raw.distance * Math.sin(b);
  const north = v.raw.distance * Math.cos(b);
  let trackDeg: number | null = null;
  if (v.tracked && Math.hypot(v.raw.downRange, v.raw.crossRange) >= TRACK_RECOVERY_MIN_RANGE) {
    const t = v.raw.bearingDeg - (Math.atan2(v.raw.crossRange, v.raw.downRange) * 180) / Math.PI;
    trackDeg = ((t % 360) + 360) % 360;
  }
  return { east, north, trackDeg };
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
    apoapsis: closed ? formatApsis(r.apoapsisAltitude) : 'escape',
    apoapsisTime: r.timeToApoapsis !== null ? formatCountdown(r.timeToApoapsis) : '—',
    periapsis: formatApsis(r.periapsisAltitude),
    periapsisTime: r.timeToPeriapsis !== null ? formatCountdown(r.timeToPeriapsis) : '—',
    inclination: formatRadAsDeg(r.inclination, 2),
    eccentricity: formatNumber(r.eccentricity, 4),
    period: r.period !== null ? formatDuration(r.period) : '—',
    closed,
  };
}

export interface OrbitPhase {
  /** The orbit panel belongs on the flight HUD (false while falling through the atmosphere on a suborbital path). */
  show: boolean;
  /** Periapsis below the surface while that is the plan: under power or inside the atmosphere. */
  suborbital: boolean;
  /** Tone of the periapsis value: red only for an unplanned impact (coasting above the atmosphere). */
  periapsisTone: 'normal' | 'caution' | 'warning';
}

/**
 * What the orbit readout means in the current flight phase. During a powered ascent or inside the atmosphere a
 * periapsis below the surface is expected (amber, "suborbital"); coasting above the atmosphere it is an impact
 * (red). A vessel falling through the atmosphere on a suborbital path (entry, parachutes) has no orbit to show.
 */
export function orbitPhase(s: SimSnapshot, defs: DefLibrary): OrbitPhase {
  const r = s.readouts;
  const v = activeVesselOf(s);
  const body = v ? defs.bodies[v.bodyId] : undefined;
  const atmTop = body?.atmosphere?.simTop ?? 0;
  const inAtmosphere = atmTop > 0 && r.altitudeAsl < atmTop;
  const powered = r.thrust > 0 || r.throttle > 0;
  const below = r.periapsisAltitude < 0;
  const suborbital = below && (inAtmosphere || powered);
  return {
    show: !(inAtmosphere && below && r.verticalSpeed < 0),
    suborbital,
    periapsisTone: below ? (suborbital ? 'caution' : 'warning') : atmTop > 0 && r.periapsisAltitude < atmTop ? 'caution' : 'normal',
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
  /**
   * The stage whose engines are running (or armed) now: the sim fills a fired stage's numbers only for the one
   * that owns the active engines (StageInfo of a fired stage with propellantFraction set), so its delta-v, TWR,
   * burn time and propellant are live. At most one tile is active.
   */
  active: boolean;
  deltaV: string;
  deltaVVac: string;
  twr: string;
  burnTime: string;
  /** 0..1 or null when the stage has no engines. */
  propellant: number | null;
  hasEngines: boolean;
  /** What firing the stage does, from its action kinds ("separate · deploy chute"); empty when unknown. */
  actions: string;
}

/** Words for the action kinds of a stage (the second line of an engine-less next-stage tile). */
const ACTION_WORDS: Record<string, string> = {
  igniteengines: 'ignite',
  shutdownengines: 'shut down',
  decouple: 'separate',
  fireseparationmotors: 'sep. motors',
  jettisonfairing: 'jettison fairing',
  jettisonles: 'jettison tower',
  deployparachute: 'deploy chute',
  cutparachute: 'cut chute',
  deploylegs: 'deploy gear',
  releaseclamps: 'release clamps',
  enablercs: 'RCS on',
};

/** "separate · deploy chute": the known action kinds of a stage in order, each once. */
export function stageActionText(actionKinds: readonly string[]): string {
  const words = actionKinds.map((k) => ACTION_WORDS[k.toLowerCase().replace(/[^a-z]/g, '')]).filter((w): w is string => w !== undefined);
  return [...new Set(words)].join(' · ');
}

export interface StagesView {
  tiles: StageTileView[];
  /** Index of the active (burning) stage, or -1. */
  active: number;
  lockout: boolean;
  nextStage: number;
  deltaVTotal: string;
}

export function describeStages(s: SimSnapshot): StagesView {
  const st = s.staging;
  // The active stage: the latest fired stage the sim still reports numbers for (the owner of the running engines).
  let active = -1;
  for (let i = Math.min(st.nextStage, st.stages.length) - 1; i >= 0 && active < 0; i--) {
    const info = st.stages[i]!;
    if (info.fired && info.propellantFraction !== null) active = i;
  }
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
      active: i === active,
      deltaV: hasEngines ? formatDeltaV(info.deltaVNow) : '',
      deltaVVac: hasEngines ? formatDeltaV(info.deltaVVac) : '',
      twr: hasEngines ? formatTwr(info.twr) : '',
      burnTime: hasEngines ? formatDuration(info.burnTime) : '',
      propellant: info.propellantFraction,
      hasEngines,
      actions: stageActionText(info.actionKinds),
    };
  });
  return { tiles, active, lockout: st.lockout, nextStage: st.nextStage, deltaVTotal: formatDeltaV(s.readouts.deltaVTotal) };
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

/** One stage group in use on the HUD: one bar, the resource that runs out first. */
export interface ResourceGroupLine {
  id: string;
  label: string;
  /** Lowest fraction of the group's resources, 0..1, and its percentage string. */
  fraction: number;
  amount: string;
  /** "RP-1 62 % · Liquid oxygen 62 %" (every resource of the group; the line's tooltip). */
  detail: string;
}

export interface ResourceSummary {
  /** Every group in use (any resource below full), aggregated to one line each. */
  inUse: ResourceGroupLine[];
  /** Labels of the remaining groups, all full (folded into one line; on the pad, every group). */
  full: string[];
}

/**
 * What the HUD's resource panel shows: one bar per stage group in use (aggregated: the resource of the group
 * that runs out first) and the untouched groups folded into one "full" line, so a ten-tank stack does not fill
 * the screen with bars at 100 %. The MFD systems page keeps every resource of every group.
 */
export function summarizeResources(groups: readonly ResourceGroupView[]): ResourceSummary {
  const used = groups.filter((g) => g.bars.some((b) => b.fraction < 0.9995));
  const inUse = used.map((g): ResourceGroupLine => {
    const low = g.bars.reduce((a, b) => (b.fraction < a.fraction ? b : a));
    return { id: g.id, label: g.label, fraction: low.fraction, amount: low.amount, detail: g.bars.map((b) => `${b.name} ${b.amount}`).join(' · ') };
  });
  return { inUse, full: groups.filter((g) => !used.includes(g)).map((g) => g.label) };
}

/** Heat-shield redline: below this ablator fraction the shield is in its last margin (HUD and MFD). */
export const ABLATOR_REDLINE = 0.3;

/** Tone of an ablator reading: low is bad, so the whole reading turns red only below the redline. */
export const ablatorTone = (f: number): 'good' | 'warning' => (f < ABLATOR_REDLINE ? 'warning' : 'good');

// ------------------------------------------------------------------------------------- flight phase

/** The vessel is inside its body's atmosphere (below the simulated top). */
export function inAtmosphere(s: SimSnapshot, defs: DefLibrary): boolean {
  const v = activeVesselOf(s);
  const top = v ? (defs.bodies[v.bodyId]?.atmosphere?.simTop ?? 0) : 0;
  return top > 0 && s.readouts.altitudeAsl < top;
}

/**
 * Coming down: in flight and descending either through an atmosphere or on a path that meets the surface
 * (periapsis below it), which covers an entry, a descent under chutes and a powered landing.
 */
export function isDescending(s: SimSnapshot, defs: DefLibrary): boolean {
  const v = activeVesselOf(s);
  if (!v || isLanded(v)) return false;
  const r = s.readouts;
  return r.verticalSpeed < 0 && (inAtmosphere(s, defs) || r.periapsisAltitude < 0);
}

/**
 * The landing-target panel shows its full rows (down-range, cross-range, the predicted miss, the zone status)
 * only while they matter: with a prediction, heating in an entry, or descending. Otherwise it is one line
 * (name, distance and bearing), so a recovery zone 6 000 km away does not take five rows of the screen.
 */
export function landingTargetExpanded(s: SimSnapshot, defs: DefLibrary): boolean {
  const lt = s.readouts.landingTarget;
  if (!lt) return false;
  return lt.predicted !== null || s.readouts.heatFlux > 1000 || isDescending(s, defs);
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
