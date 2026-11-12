/**
 * Display models built from a SimSnapshot: the exact strings the HUD panels and the MFD pages show. Both
 * render from these functions, so a number can never read differently on the two.
 */
import type { DefLibrary, ParachuteEnvelope } from '@/core/contracts/defs';
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
  formatMach,
  formatNumber,
  formatPercent,
  formatPressure,
  formatRadAsDeg,
  formatSignedRange,
  formatSpeed,
  formatSpeedReadout,
  formatTwr,
  formatVerticalSpeed,
  formatWarp,
  NBSP,
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

/**
 * Altimeter source: `auto` = radar (height of the vessel's lowest point over the ground or sea under it) below
 * RADAR_ALTITUDE_SWITCH, standing on the ground included, sea level / datum above. Near the ground the pilot needs
 * the height over it: a lander at rest at Tranquility Base reads about 0 m, not its datum height of -1.9 km, and
 * lifts off from that number without a jump. The reference is always named in the altimeter's title.
 */
export function altitudeSource(s: SimSnapshot, mode: AltitudeMode = 'auto'): 'radar' | 'asl' {
  if (mode !== 'auto') return mode;
  return s.readouts.altitudeRadar < RADAR_ALTITUDE_SWITCH ? 'radar' : 'asl';
}

/** The altitude an altimeter source reads: radar altitude never below 0 (a vessel afloat or settling on its gear). */
export function altitudeValue(s: SimSnapshot, src: 'radar' | 'asl'): number {
  return src === 'radar' ? Math.max(0, s.readouts.altitudeRadar) : s.readouts.altitudeAsl;
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
  /**
   * Horizontal speed in the frame of `speedMode`, so that it and the vertical speed are the two components of
   * `speed`: over the ground in surface mode, the horizontal part of the orbital velocity in orbit mode (the
   * vertical speed is the same in both frames: the body's rotation moves a point only horizontally).
   */
  horizontalSpeed: string;
  /** Horizontal speed over the ground whatever the mode (the landing page). */
  horizontalSpeedSurface: string;
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

/**
 * Horizontal part of the orbital velocity: the orbital speed less its radial component (the vertical speed, which
 * the body's rotation does not change).
 */
export const orbitalHorizontalSpeed = (speedOrbital: number, verticalSpeed: number): number => Math.sqrt(Math.max(0, speedOrbital * speedOrbital - verticalSpeed * verticalSpeed));

/** Primary flight data, the same strings on the HUD and the MFD flight / landing pages. */
export function describeFlight(s: SimSnapshot, mode: AltitudeMode = 'auto'): FlightView {
  const r = s.readouts;
  const src = altitudeSource(s, mode);
  const speedMode = s.navball.mode === 'surface' ? 'surface' : 'orbit';
  return {
    altitudeSource: src,
    altitude: formatAltitude(altitudeValue(s, src)),
    verticalSpeed: formatVerticalSpeed(r.verticalSpeed),
    verticalTrend: verticalTrend(r.verticalSpeed),
    horizontalSpeed: formatSpeed(speedMode === 'surface' ? r.horizontalSpeed : orbitalHorizontalSpeed(r.speedOrbital, r.verticalSpeed)),
    horizontalSpeedSurface: formatSpeed(r.horizontalSpeed),
    speedMode,
    speed: formatSpeedReadout(speedMode === 'surface' ? r.speedSurface : r.speedOrbital),
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
  /**
   * "Impact" or "Entry interface" (where the vacuum trajectory meets the atmosphere: not the splash point) and
   * its miss from the target centre; null when nothing is predicted.
   */
  predicted: { label: 'Impact' | 'Entry interface'; miss: string; missBearing: string; countdown: string; where: string } | null;
  /** Shown instead of `predicted` when it is null (an em dash: nothing predicted). */
  noPrediction: string;
  /** Raw numbers for graphics (m), +down = ahead, +cross = right. */
  raw: { distance: number; downRange: number; crossRange: number; bearingDeg: number; missDistance: number | null; missBearingDeg: number | null };
}

/**
 * Within this distance (m) of the target the vessel is on it: the bearing reads "on target" (a compass bearing
 * to a point under the vessel is noise), the same threshold as a range reading "on track".
 */
export const ON_TARGET_DISTANCE = 0.5;

/** A ground track needs this horizontal speed (m/s) ... */
export const TRACK_MIN_SPEED = 1;
/** ... and a flight path no steeper than this (deg from the horizontal). */
export const TRACK_MAX_CLIMB_DEG = 75;

/** True when the motion over the ground has a direction worth resolving distances along. */
export function hasGroundTrack(horizontalSpeed: number, verticalSpeed: number): boolean {
  return horizontalSpeed >= TRACK_MIN_SPEED && Math.atan2(Math.abs(verticalSpeed), horizontalSpeed) <= (TRACK_MAX_CLIMB_DEG * Math.PI) / 180;
}

export function describeLandingTarget(s: SimSnapshot): LandingTargetView | null {
  const lt = s.readouts.landingTarget;
  if (!lt) return null;
  const target = s.surfaceTargets.find((t) => t.id === lt.targetId);
  const name = target?.name ?? lt.targetId;
  const isZone = target?.kind === 'recovery';
  const p = lt.predicted;
  // The readout resolves the separation along the ground track only when there is one: a horizontal speed of
  // TRACK_MIN_SPEED or more and a flight path flatter than TRACK_MAX_CLIMB_DEG. In a vertical climb (or a
  // descent under chutes) the few m/s of drift point anywhere: no down-range / cross-range then, "vertical".
  const tracked = hasGroundTrack(s.readouts.horizontalSpeed, s.readouts.verticalSpeed);
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
          label: p.kind === 'impact' ? 'Impact' : 'Entry interface',
          miss: formatDistance(p.missDistance),
          missBearing: formatBearing(p.missBearingDeg),
          countdown: formatCountdown(p.ut - s.ut),
          where: formatLatLon(p.latitude, p.longitude),
        }
      : null,
    noPrediction: '—',
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
 * without data collapse: with no ground track (moving straight up or down) down-range and cross-range are one
 * "Ground track: vertical" row, and with neither a track nor a prediction the arrival row joins it ("Track ·
 * arrival: —").
 */
export function landingTargetRows(v: LandingTargetView): [string, string][] {
  const rows: [string, string][] = [
    ['Distance', v.distance],
    ['Bearing', v.bearing],
  ];
  if (v.tracked) rows.push(['Down-range', v.downRange], ['Cross-range', v.crossRange]);
  else if (v.predicted) rows.push(['Ground track', 'vertical']);
  // An impact is where the vessel comes down; the entry interface only where it meets the atmosphere (its
  // miss from the target centre says nothing about the splash point), so the row is named for what it is.
  if (v.predicted) rows.push([v.predicted.label === 'Impact' ? 'Impact miss' : 'Entry point', `${v.predicted.miss} · ${v.predicted.missBearing}`]);
  else if (v.tracked) rows.push(['Predicted arrival', v.noPrediction]);
  else rows.push(['Track · arrival', v.noPrediction]);
  return rows;
}

/** True for the prediction row of landingTargetRows (drawn under a rule). */
export const isPredictionRow = (label: string): boolean => label.endsWith(' miss') || label === 'Entry point' || label === 'Predicted arrival' || label === 'Track · arrival';

/** Below this surface speed (m/s), descending through the air, the vessel comes down close to its sub-point. */
export const TERMINAL_DESCENT_SPEED = 250;

export interface ZoneStatus {
  /** The vessel comes down (or is down) inside the recovery zone's radius. */
  inside: boolean;
  /** What decides it: a predicted impact point, or the sub-point (landed, or the slow end of a descent). */
  basis: 'impact' | 'position';
}

/**
 * Whether the vessel will come down inside its recovery zone, once something says where it comes down: a predicted
 * impact point, or the sub-point while landed / splashed or in the slow last part of a descent through the air
 * (under drogues or mains the vessel lands close to its sub-point). Null for a target that is not a recovery
 * zone and while nothing tells where the vessel will land: in orbit, and with only an entry-interface prediction
 * (where the trajectory meets the atmosphere, not where it ends). One rule for the HUD light and the MFD row.
 */
export function zoneStatus(s: SimSnapshot, defs: DefLibrary): ZoneStatus | null {
  const lt = s.readouts.landingTarget;
  if (!lt) return null;
  const target = s.surfaceTargets.find((t) => t.id === lt.targetId);
  if (!target || target.kind !== 'recovery') return null;
  if (lt.predicted?.kind === 'impact') return { inside: lt.predicted.missDistance <= target.radius, basis: 'impact' };
  const r = s.readouts;
  const terminal = isLanded(activeVesselOf(s)) || (inAtmosphere(s, defs) && r.verticalSpeed < 0 && r.speedSurface < TERMINAL_DESCENT_SPEED);
  return terminal ? { inside: lt.distance <= target.radius, basis: 'position' } : null;
}

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

/**
 * The osculating orbit as the HUD and the MFD show it. A path whose periapsis lies below the surface never
 * reaches it and has no period to fly (both '—'), and coming down on such a path the vessel meets the surface
 * before its next apoapsis (no time to it either).
 */
export function describeOrbit(s: SimSnapshot): OrbitView {
  const r = s.readouts;
  const closed = r.eccentricity < 1 && Number.isFinite(r.apoapsisAltitude) && r.apoapsisAltitude > -1e30;
  const meetsSurface = r.periapsisAltitude < 0;
  // Past its apoapsis on this pass (falling, or more than half a period from the next one: the time from periapsis
  // to apoapsis is half the period on every ellipse), the vessel meets the surface first.
  const comingDown = meetsSurface && (r.verticalSpeed < 0 || (r.period !== null && r.timeToApoapsis !== null && r.timeToApoapsis > r.period / 2));
  return {
    apoapsis: closed ? formatApsis(r.apoapsisAltitude) : 'escape',
    apoapsisTime: r.timeToApoapsis !== null && !comingDown ? formatCountdown(r.timeToApoapsis) : '—',
    periapsis: formatApsis(r.periapsisAltitude),
    periapsisTime: r.timeToPeriapsis !== null && !meetsSurface ? formatCountdown(r.timeToPeriapsis) : '—',
    inclination: formatRadAsDeg(r.inclination, 2),
    eccentricity: formatNumber(r.eccentricity, 4),
    period: r.period !== null && !meetsSurface ? formatDuration(r.period) : '—',
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
  /**
   * Delta-v in vacuum, for every stage alike (the figures add up to Readouts.deltaVTotal, the header's total):
   * a stage fires high up, and at the pad's pressure the lunar ascent stage would read a third of what it has.
   */
  deltaV: string;
  /** The same in vacuum (kept for the MFD's explicit row). */
  deltaVVac: string;
  /** Delta-v at the current ambient pressure ('' when it equals the vacuum figure to 1 %): the active stage in air. */
  deltaVNow: string;
  twr: string;
  /**
   * What the engines do at full throttle, named: 'TWR' and the thrust-to-weight ratio at local gravity near a
   * body, 'Accel' and the acceleration (m/s^2) where local gravity is too weak for a ratio to mean anything
   * (WEAK_GRAVITY: a translunar coast would read TWR 230).
   */
  thrustLabel: 'TWR' | 'Accel';
  thrustValue: string;
  burnTime: string;
  /** 0..1 or null when the stage has no engines. */
  propellant: number | null;
  hasEngines: boolean;
  /** What firing the stage does, from its action kinds ("separate · deploy chute"); empty when unknown. */
  actions: string;
  /**
   * What the stage burns: the stage groups of the engines it ignites ("Meridian M-3"), from the vessel's vehicle
   * definition (stageBurnLabel); null when unknown or when the stage lights no engine. The active tile is titled
   * with it (the stage's own label names the event that started the burn, "M-3 separation").
   */
  burnName: string | null;
}

/**
 * What a stage burns: the labels of the stage groups (VehicleDef.stageGroups) of the engines its igniteEngines
 * actions light, e.g. "Meridian M-3" or "Heron descent stage". Null when the active vessel's vehicle definition
 * is unknown or the stage ignites no engine. StageInfo index i is VehicleDef.stages[i] (the sim reports the
 * whole stack, fired stages included).
 */
export function stageBurnLabel(s: SimSnapshot, defs: DefLibrary, index: number): string | null {
  const v = activeVesselOf(s);
  const vehicle = v ? defs.vehicles[v.vehicleId] : undefined;
  const stage = vehicle?.stages[index];
  if (!vehicle || !stage) return null;
  const groups: string[] = [];
  for (const a of stage.actions) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const g = vehicle.parts.find((p) => p.id === id)?.stageGroup;
      if (g !== undefined && !groups.includes(g)) groups.push(g);
    }
  }
  if (groups.length === 0) return null;
  return groups.map((g) => vehicle.stageGroups.find((x) => x.id === g)?.label ?? g).join(' + ');
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

const CHUTE_NAMES = { drogue: 'drogues', main: 'mains' } as const;

/**
 * What firing a stage does, from the vessel's vehicle definition where it is known: the words of
 * stageActionText, with every chute named by its kind ("separate · deploy drogues", "release drogues · deploy
 * mains": a cut releases the canopies the latest earlier stage deployed). Falls back to the bare action kinds of
 * the StageInfo without a vehicle definition.
 */
export function stageActionWords(s: SimSnapshot, defs: DefLibrary | undefined, index: number): string {
  const info = s.staging.stages[index];
  const v = activeVesselOf(s);
  const vehicle = defs && v ? defs.vehicles[v.vehicleId] : undefined;
  const stage = vehicle?.stages[index];
  if (!vehicle || !stage) return stageActionText(info?.actionKinds ?? []);
  let deployed: 'drogue' | 'main' | null = null;
  for (let i = 0; i < index; i++) for (const a of vehicle.stages[i]!.actions) if (a.kind === 'deployParachute') deployed = a.mode;
  const words: string[] = [];
  for (const a of stage.actions) {
    let w: string | undefined;
    if (a.kind === 'deployParachute') w = `deploy ${CHUTE_NAMES[a.mode]}`;
    else if (a.kind === 'cutParachute') w = deployed ? `release ${CHUTE_NAMES[deployed]}` : ACTION_WORDS.cutparachute;
    else w = ACTION_WORDS[a.kind.toLowerCase()];
    if (w !== undefined && !words.includes(w)) words.push(w);
    if (a.kind === 'deployParachute') deployed = a.mode;
  }
  return words.join(' · ');
}

/** Local gravity (m/s^2) below which a stage shows its acceleration instead of a thrust-to-weight ratio. */
export const WEAK_GRAVITY = 0.5;

const G0 = 9.80665;

/**
 * Full-throttle acceleration of stage `index` at its current mass, m/s^2, from its vacuum delta-v, its burn time
 * and the vacuum Isp of the engines it ignites (VehicleDef stage actions; fixed-burn motors left out):
 * a0 = ve (1 - e^(-dv/ve)) / t, exact for a constant-thrust burn. It does not depend on gravity, so it stays
 * right where the sim's TWR is stale: StageInfo is refreshed on integrated steps only, and after a coast on rails
 * across a sphere-of-influence change its TWR still holds the gravity of the old body (request flight-ui-8).
 * Null without a vehicle definition, engines or a burn time.
 */
export function stageAcceleration(s: SimSnapshot, defs: DefLibrary | undefined, index: number): number | null {
  const info = s.staging.stages[index];
  const v = activeVesselOf(s);
  const vehicle = defs && v ? defs.vehicles[v.vehicleId] : undefined;
  const stage = vehicle?.stages[index];
  if (!info || !defs || !vehicle || !stage || !(info.burnTime > 0) || !(info.deltaVVac > 0)) return null;
  let thrust = 0;
  let flow = 0;
  for (const a of stage.actions) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const def = defs.parts[vehicle.parts.find((p) => p.id === id)?.def ?? ''];
      for (const m of def?.modules ?? []) {
        if (m.type !== 'engine' || m.fixedBurn || !(m.ispVac > 0)) continue;
        thrust += m.thrustVac;
        flow += m.thrustVac / m.ispVac;
      }
    }
  }
  if (!(flow > 0)) return null;
  const ve = (G0 * thrust) / flow;
  return (ve * (1 - Math.exp(-info.deltaVVac / ve))) / info.burnTime;
}

export interface StagesView {
  tiles: StageTileView[];
  /** Index of the active (burning) stage, or -1. */
  active: number;
  lockout: boolean;
  nextStage: number;
  deltaVTotal: string;
}

/** `defs` names what the stages burn (StageTileView.burnName); without it burnName is null. */
export function describeStages(s: SimSnapshot, defs?: DefLibrary): StagesView {
  const st = s.staging;
  // The active stage: the latest fired stage the sim still reports numbers for (the owner of the running engines).
  let active = -1;
  for (let i = Math.min(st.nextStage, st.stages.length) - 1; i >= 0 && active < 0; i--) {
    const info = st.stages[i]!;
    if (info.fired && info.propellantFraction !== null) active = i;
  }
  // Local gravity at the vessel (the sim's TWR is at it): below WEAK_GRAVITY the tiles give the acceleration.
  const v = activeVesselOf(s);
  const body = defs && v ? defs.bodies[v.bodyId] : undefined;
  const gLocal = body && v ? body.mu / (v.r.x * v.r.x + v.r.y * v.r.y + v.r.z * v.r.z) : null;
  const weak = gLocal !== null && gLocal < WEAK_GRAVITY;
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
      deltaV: hasEngines ? formatDeltaV(info.deltaVVac) : '',
      deltaVVac: hasEngines ? formatDeltaV(info.deltaVVac) : '',
      deltaVNow: hasEngines && Math.abs(info.deltaVNow - info.deltaVVac) > 0.01 * info.deltaVVac ? formatDeltaV(info.deltaVNow) : '',
      twr: hasEngines ? formatTwr(info.twr) : '',
      thrustLabel: weak ? 'Accel' : 'TWR',
      thrustValue: !hasEngines ? '' : weak ? `${formatNumber(stageAcceleration(s, defs, i) ?? info.twr * gLocal!, 2)}${NBSP}m/s²` : formatTwr(info.twr),
      burnTime: hasEngines ? formatDuration(info.burnTime) : '',
      propellant: info.propellantFraction,
      hasEngines,
      actions: stageActionWords(s, defs, i),
      burnName: defs ? stageBurnLabel(s, defs, i) : null,
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
  /**
   * Part of the group's main supply: what its main engines burn (not the solid propellant of ullage or
   * separation motors, which is spent in seconds by design); in a group without main engines every resource but
   * those, and a group of nothing but fixed-burn motors their propellant. A heat shield's ablator never is (the
   * entry panel shows it). The HUD's one line per group reads these.
   */
  primary: boolean;
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
  /** Per group: what its main engines burn, what its fixed-burn motors burn, and its heat shields' ablator. */
  const mainFeed = new Map<string, Set<string>>();
  const fixedFeed = new Map<string, Set<string>>();
  const ablators = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, g: string, rid: string): void => {
    let set = m.get(g);
    if (!set) m.set(g, (set = new Set()));
    set.add(rid);
  };
  for (const part of v.parts) {
    const def = defs.parts[part.def];
    if (!def) continue;
    const g = groupOf.get(part.instanceId) ?? v.id;
    for (const md of def.modules) {
      if (md.type === 'engine') for (const p of md.propellants) add(md.fixedBurn ? fixedFeed : mainFeed, g, p.resource);
      else if (md.type === 'heatShield') add(ablators, g, md.ablatorResource);
    }
    if (!def.resources) continue;
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
  return ids.map((id) => {
    const entries = [...sums.get(id)!.entries()];
    const main = mainFeed.get(id);
    const held = (rid: string): boolean => main?.has(rid) === true;
    const ablator = (rid: string): boolean => ablators.get(id)?.has(rid) ?? false;
    const other = (rid: string): boolean => !ablator(rid) && !(fixedFeed.get(id)?.has(rid) ?? false);
    // Main engines with a tank of their own in the group: their propellants; otherwise every other supply (RCS);
    // a group of nothing but fixed-burn motors (a launch escape motor): their propellant; never the ablator.
    const isPrimary = entries.some(([rid]) => held(rid)) ? held : entries.some(([rid]) => other(rid)) ? other : (rid: string): boolean => !ablator(rid);
    return {
      id,
      label: vehicle?.stageGroups.find((g) => g.id === id)?.label ?? v.name,
      bars: entries.map(([rid, e]) => ({
        resourceId: rid,
        name: defs.resources[rid]?.name ?? rid,
        fraction: e.capacity > 0 ? Math.max(0, Math.min(1, e.amount / e.capacity)) : 0,
        amount: e.capacity > 0 ? formatPercent(e.amount / e.capacity) : '—',
        primary: isPrimary(rid),
      })),
    };
  });
}

/** One stage group in use on the HUD: one bar, the main-supply resource that runs out first. */
export interface ResourceGroupLine {
  id: string;
  label: string;
  /** Lowest fraction of the group's main supply (ResourceBarView.primary), 0..1, and its percentage string. */
  fraction: number;
  amount: string;
  /** "Liquid oxygen 62 % · Liquid hydrogen 62 % · Solid propellant 0 %" (every resource; the line's tooltip). */
  detail: string;
}

export interface ResourceSummary {
  /** Every group in use (any resource below full), aggregated to one line each. */
  inUse: ResourceGroupLine[];
  /** Labels of the remaining groups, all full (folded into one line; on the pad, every group). */
  full: string[];
}

/**
 * What the HUD's resource panel shows: one bar per stage group in use (aggregated: the resource of the group's
 * main supply that runs out first, so a stage whose ullage motors burned out still reads what its tanks hold)
 * and the untouched groups folded into one "full" line, so a ten-tank stack does not fill the screen with bars
 * at 100 %. The MFD systems page keeps every resource of every group.
 */
export function summarizeResources(groups: readonly ResourceGroupView[]): ResourceSummary {
  // A group without a supply of its own (a capsule whose only resource is its heat shield) has no line here.
  const supplied = groups.filter((g) => g.bars.some((b) => b.primary));
  const used = supplied.filter((g) => g.bars.some((b) => b.fraction < 0.9995));
  const inUse = used.map((g): ResourceGroupLine => {
    const low = g.bars.filter((b) => b.primary).reduce((a, b) => (b.fraction < a.fraction ? b : a));
    return { id: g.id, label: g.label, fraction: low.fraction, amount: low.amount, detail: g.bars.map((b) => `${b.name} ${b.amount}`).join(' · ') };
  });
  return { inUse, full: supplied.filter((g) => !used.includes(g)).map((g) => g.label) };
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

/** Heat flux above which a vessel coming in counts as heating up (W/m^2). */
export const ENTRY_HEAT_FLUX = 1000;

/**
 * Entering an atmosphere: heating up (above ENTRY_HEAT_FLUX) while coming down, or while rising unpowered on a
 * path that stays inside the atmosphere (a skip, which comes back down). An ascent heats up too (the stagnation
 * flux of a rocket at Mach 0.6 is already a few kW/m^2) but climbs under power toward an apoapsis above the air:
 * it is not an entry, and its orbit panel stays.
 */
export function isEntering(s: SimSnapshot, defs: DefLibrary): boolean {
  const r = s.readouts;
  if (r.heatFlux <= ENTRY_HEAT_FLUX) return false;
  if (r.verticalSpeed < 0) return true;
  const v = activeVesselOf(s);
  const top = v ? (defs.bodies[v.bodyId]?.atmosphere?.simTop ?? 0) : 0;
  return r.thrust <= 0 && r.throttle <= 0 && r.apoapsisAltitude < top;
}

// ------------------------------------------------------------------------------------------ air data

export interface AirDataView {
  q: string;
  mach: string;
  aoa: string;
}

/**
 * Dynamic pressure, Mach number and angle of attack. Mach and angle of attack exist only in air: outside an
 * atmosphere (above its simulated top, or on a body without one) they read "—". The sim keeps a nominal speed of
 * sound in vacuum, so its Mach number there is the speed over 275 m/s (M 37.8 in a 300 km parking orbit, M 4 at
 * the Moon), which is not a reading.
 */
export function describeAirData(s: SimSnapshot, defs: DefLibrary): AirDataView {
  const r = s.readouts;
  const air = inAtmosphere(s, defs);
  return {
    q: formatPressure(r.dynamicPressure),
    mach: air ? formatMach(r.mach) : '—',
    aoa: air ? formatRadAsDeg(r.angleOfAttack) : '—',
  };
}

// ------------------------------------------------------------------------------------ chute envelope

export interface ChuteEnvelopeView {
  /** The chutes the light is about, by the stage that deploys them: "Drogue deploy", "Main deploy". */
  label: string;
  /** "SAFE" | "RISKY" | "UNSAFE". */
  light: string;
  tone: 'good' | 'caution' | 'warning';
  /** Tooltip: the envelope itself, from the parachute's data ("safe below 4 500 m, under 95 m/s and 2.8 kPa..."). */
  detail: string;
}

const CHUTE_DEPLOY_LABEL = { drogue: 'Drogue deploy', main: 'Main deploy' } as const;

/** "below 4 500 m, under 95 m/s and under 2.8 kPa" (inside) or "above 130 m/s or 4.5 kPa" (outside the limits). */
function envelopeWords(e: ParachuteEnvelope, inside: boolean): string {
  const w: string[] = [];
  const [lo, hi] = inside ? ['below', 'under'] : ['above', 'above'];
  if (e.maxAlt !== undefined) w.push(`${lo} ${formatAltitude(e.maxAlt)}`);
  if (e.maxMach !== undefined) w.push(`${hi} ${formatMach(e.maxMach)}`);
  if (e.maxSpeed !== undefined) w.push(`${hi} ${formatSpeed(e.maxSpeed)}`);
  w.push(`${hi} ${formatPressure(e.maxQ)} dynamic pressure`);
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} ${inside ? 'and' : 'or'} ${w[w.length - 1]}` : w[0]!;
}

/**
 * The chute envelope light (Readouts.chuteEnvelope) with the chutes it is about. The sim reports it for the NEXT
 * chute stage that has not fired, so once the drogues are out the light is about the mains: at 7.4 km and
 * 130 m/s it reads RISKY for them while the drogues opened safely. The row therefore names the chute (from
 * the vehicle's stage actions, the same stage the sim looks at) and its tooltip spells out the envelope.
 * Null when no chute stage remains.
 */
export function describeChuteEnvelope(s: SimSnapshot, defs: DefLibrary): ChuteEnvelopeView | null {
  const env = s.readouts.chuteEnvelope;
  // A parachute needs air: on the Moon or above the atmosphere the light means nothing (the sim judges its envelope
  // from altitude, Mach and q alone, so q = 0 on the Moon would read SAFE; request flight-ui-9).
  if (env === null || !inAtmosphere(s, defs)) return null;
  const light = env.toUpperCase();
  const tone = env === 'safe' ? 'good' : env === 'risky' ? 'caution' : 'warning';
  const v = activeVesselOf(s);
  const vehicle = v ? defs.vehicles[v.vehicleId] : undefined;
  if (vehicle) {
    for (let i = s.staging.nextStage; i < vehicle.stages.length; i++) {
      for (const a of vehicle.stages[i]!.actions) {
        if (a.kind !== 'deployParachute') continue;
        const partDef = defs.parts[vehicle.parts.find((p) => a.parts.includes(p.id))?.def ?? ''];
        const md = partDef?.modules.find((m) => m.type === 'parachute' && m.mode === a.mode);
        const name = CHUTE_NAMES[a.mode];
        const detail =
          md?.type === 'parachute'
            ? `Deploying the ${name} now: ${light}. Safe ${envelopeWords(md.safe, true)}; the canopies fail ${envelopeWords(md.destroy, false)}.`
            : `Deploying the ${name} now: ${light}.`;
        return { label: CHUTE_DEPLOY_LABEL[a.mode], light, tone, detail };
      }
    }
  }
  return { label: 'Chute deploy', light, tone, detail: `Deploying the next chutes now: ${light}.` };
}

// ---------------------------------------------------------------------------------------- milestones

/**
 * What a mission milestone is called on screen: the rule's own title from the scenario data ("TLI complete",
 * "Entered the Moon's sphere of influence"; MilestoneRuleDef.title), or for a rule without one words from its
 * generic trigger and the names in the definitions (bodies, the vehicle's stages): "Moon encounter predicted",
 * "Entered the Moon sphere of influence", "M-1 separation", "Splashdown". Never the id. A rule the HUD cannot
 * find is announced as "Milestone reached".
 */
export function milestoneTitle(id: string, s: SimSnapshot, defs: DefLibrary): string {
  const rule = defs.scenarios[s.scenario.id]?.milestones.find((m) => m.id === id);
  if (!rule) return 'Milestone reached';
  if (rule.title) return rule.title;
  const t = rule.trigger;
  const body = (bodyId: string): string => defs.bodies[bodyId]?.name ?? bodyId;
  switch (t.kind) {
    case 'liftoff':
      return 'Lift-off';
    case 'maxQ':
      return 'Max Q';
    case 'stageFired': {
      const v = activeVesselOf(s);
      const label = v ? defs.vehicles[v.vehicleId]?.stages[t.stageIndex]?.label : undefined;
      return label ?? `Stage ${t.stageIndex + 1} fired`;
    }
    case 'orbit':
      return `${body(t.bodyId)} orbit reached`;
    case 'encounterPredicted':
      return `${body(t.bodyId)} encounter predicted`;
    case 'soiEnter':
      return `Entered the ${body(t.bodyId)} sphere of influence`;
    case 'soiExit':
      return `Left the ${body(t.bodyId)} sphere of influence`;
    case 'touchdown':
      return t.surface === 'water' ? 'Splashdown' : `${body(t.bodyId)} touchdown`;
    case 'liftoffFromSurface':
      return `${body(t.bodyId)} lift-off`;
    case 'predictedPeriapsis':
      return `${body(t.bodyId)} periapsis targeted · ${formatApsis(t.minAltitude)} to ${formatApsis(t.maxAltitude)}`;
    case 'altitudeCrossing':
      return `${t.direction === 'descending' ? 'Down through' : 'Up through'} ${formatApsis(t.altitude)}`;
    case 'chuteDeployed':
      return t.mode === 'drogue' ? 'Drogues deployed' : 'Mains deployed';
  }
}

/** The body whose sphere of influence a milestone is about (its trigger enters or leaves it), else null. */
export function milestoneSoiBody(id: string, s: SimSnapshot, defs: DefLibrary): string | null {
  const t = defs.scenarios[s.scenario.id]?.milestones.find((m) => m.id === id)?.trigger;
  return t && (t.kind === 'soiEnter' || t.kind === 'soiExit') ? t.bodyId : null;
}

/**
 * The landing-target panel shows its full rows (down-range, cross-range, the predicted miss, the zone status)
 * only while they matter: with a prediction, in an entry, or descending. Otherwise it is one line (name,
 * distance and bearing), so a recovery zone 6 000 km away does not take five rows of the screen.
 */
export function landingTargetExpanded(s: SimSnapshot, defs: DefLibrary): boolean {
  const lt = s.readouts.landingTarget;
  if (!lt) return false;
  return lt.predicted !== null || isEntering(s, defs) || isDescending(s, defs);
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
