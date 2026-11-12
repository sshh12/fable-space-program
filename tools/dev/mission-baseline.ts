/**
 * The mission record and its two comparisons (lead-owned; MIGRATION_V2 principle 3 and section 8).
 *
 * A MISSION RECORD is what one flight of the headless `lunar-direct` mission leaves behind: per milestone
 * the event time, the state of the active vessel at the first control tick at which the milestone is on
 * record (`captureOffset` seconds after the event), its classical elements and the milestone's own facts.
 * tests/mission/baseline-v1.json is the record of the v1 code on the v1 clock.
 *
 * Why there are two comparisons. The scripted pilot decides at 30 Hz control ticks, so a flight is a chaotic
 * function of its start instant: moving only the start of the UNMODIFIED v1 code by 2 ms changes EARTH_ORBIT
 * by 4.8e-5 in da/a, TLI by 1.6e-3, the lunar touchdown by 47 s and the splashdown by 15 s, while the
 * unshifted code reproduces the baseline bit for bit (measured by sim-core-v2, 2026-11-12). No fixed
 * tolerance separates "the same flight on a moved clock" from "a changed simulation". Therefore:
 *
 *   EXACT     for a step that must not change behaviour and starts at the bit-identical instant: every
 *             milestone's event time, capture time and state are EQUAL. (The golden hash asserts the same
 *             thing for the end state; this comparison says at which milestone a difference starts.)
 *   ENVELOPE  for a step that legitimately moves time (the tick grid; later the session switch): per
 *             milestone, the flight is about the SAME BODY in the SAME SITUATION as the reference, and its
 *             difference from the reference in EVENT MISSION TIME, in da/a, in e and in i lies within
 *             TWICE the largest such difference among a recorded set of CONTROL flights: flights of the
 *             reference code whose only change is a shifted start. The controls measure how far the same
 *             code moves when only time moves; a flight outside twice that is a different simulation. The
 *             mission's own gates (tests/mission/full-mission.test.ts) must pass as well: the envelope
 *             says "the same flight", the gates say "a good flight".
 *
 * What each check can and cannot catch (the independent review of sim-core-v2, 2026-11-12, measured on the
 * four control flights of tests/mission/controls-v1.json). None of them proves unchanged behaviour over the
 * whole flight:
 *
 *   EXACT                everything, from the first bit that differs; but only for a step that starts at
 *                        the bit-identical instant, which no flight on the tick grid does against v1.
 *   Same-start equality  (tests/mission/reference-v1-aligned.json: the v1 clock at the tick-aligned start;
 *                        asserted by the mission test) catches a relative change of about 1e-8 in the
 *                        INTEGRATED ASCENT, and nothing after EARTH_ORBIT: from the first rails landing
 *                        the two flights stand on different instants and diverge like any two starts.
 *   ENVELOPE             catches about 5e-5 in da/a from the first staging to orbit (STAGE_SEP_1 to
 *                        EARTH_ORBIT: the controls spread by 5e-5 there and the allowed difference is twice
 *                        that; e is held to the same order). Before the first staging the floors apply
 *                        (one control tick; 1e-12 in da/a, e and i). After TLI it is ONLY A SANITY BOUND:
 *                        the allowed difference is 0.3-1.6 % in a and 150-1,300 s in event time (i up to
 *                        0.2 rad at the lunar lift-off), so a change to the coast, the lunar phases or the
 *                        entry that is smaller than that passes. A flight that ends up about another body
 *                        or in another situation at a milestone fails wherever it happens.
 *   Rails equivalence    in the unit suite (a rails advance against the integration of the same code) is
 *                        SELF-CONSISTENCY: it holds for whatever the code does. The comparison of the rails
 *                        with the v1 code was made once, for the tick-grid step, and is not a test.
 *   The mission's gates  say that the flight is good (landing accuracy, entry corridor, splashdown zone),
 *                        not that it is the same flight.
 *
 * So a change to the coast or to anything after TLI is guarded by the mission's gates and by the unit
 * suites of the code concerned, not by a mission record.
 *
 * In both comparisons: angles are compared as wrapped absolute differences (never relative: a longitude of
 * node of 0.008 rad is as good as one of 3 rad), the true anomaly is never compared (it is the position
 * along the orbit at the capture instant, and capture instants differ), and the capture offset after the
 * event is stated per milestone (a state under thrust taken 1/60 s after the event is not the state at
 * the event).
 *
 * Pure functions: nothing here flies. The recorder is tools/dev/record-mission-baseline.ts.
 */

export interface Elements {
  /** Semi-major axis, m (negative on a hyperbola). */
  a: number;
  e: number;
  /** Inclination, longitude of the ascending node, argument of periapsis and true anomaly, rad, in BCI axes. */
  i: number;
  lan: number;
  argPe: number;
  nu: number;
  /** Specific orbital energy, J/kg, and specific angular momentum, m^2/s. */
  energy: number;
  h: number;
}

export interface MilestoneState {
  id: string;
  /** Time the milestone was recorded at by the simulation, and the time of the snapshot the state is from, s since J2000. */
  ut: number;
  captureUt: number;
  /** captureUt - ut: how long after the event the state below was taken, s (0, or up to one control tick). */
  captureOffset: number;
  /** Mission elapsed time at the capture, s. */
  met: number;
  vesselId: string;
  bodyId: string;
  situation: string;
  /** State in BCI(bodyId), m and m/s. */
  r: [number, number, number];
  v: [number, number, number];
  elements: Elements;
  apoapsisAltitude: number;
  periapsisAltitude: number;
  /** Sub-point (rad) and altitude above the reference radius, m. */
  latitude: number;
  longitude: number;
  altitudeAsl: number;
  speedOrbital: number;
  speedSurface: number;
  mass: number;
  /** The milestone's own captured facts (MilestoneRecord.data). */
  data: Record<string, number>;
}

export interface MissionRecord {
  /** Format of this file: 2 (per-milestone captureOffset, the `compare` description, no blanket tolerance). */
  format: 2;
  /** Free label of the flight ("v1", "control +2 ms", "tick grid"). */
  label: string;
  scenario: string;
  /** How a record is compared with another (documentation for readers of the file; the code is mission-baseline.ts). */
  compare: { exact: string; envelope: string; notes: string[] };
  stateHash: string;
  steps: number;
  railsAdvances: number;
  controlTicks: number;
  simSeconds: number;
  /** Scenario start, s since J2000. Event MISSION time is `ut - startUt`. */
  startUt: number;
  tiles: Record<string, string>;
  node: string;
  milestones: MilestoneState[];
  /** Where the flight ended (the splashed capsule). */
  final: { ut: number; vesselId: string; bodyId: string; situation: string; latitude: number; longitude: number; recoveryZone: string | null };
}

export const COMPARE_DOC: MissionRecord['compare'] = {
  exact:
    'EXACT, for a step that must not change behaviour and starts at the bit-identical instant: every milestone has the same id, event time (ut), capture time, body, situation, state (r, v, mass), readouts and data, compared for equality. The first milestone that differs is where the change begins.',
  envelope:
    'ENVELOPE, for a step that legitimately moves time (the tick grid, the session switch): per milestone, the flight is about the same body in the same situation as the reference, and |event mission time - reference|, |a - a_ref| / |a_ref|, |e - e_ref| and |i - i_ref| must each be within twice the largest such difference among the control flights (the reference code with shifted starts only; recorded by the owner of the step in a controls file), with floors of one control tick (1/30 s) for the time and 1e-12 for the others. The mission gates must pass as well.',
  notes: [
    'The scripted pilot decides at 30 Hz, so a flight is a chaotic function of its start instant: a 2 ms shift of the unmodified v1 code moves EARTH_ORBIT by 4.8e-5 in da/a and the lunar touchdown by 47 s. A fixed tolerance cannot tell a moved clock from a changed simulation; the control flights can.',
    'Angles are compared as wrapped absolute differences. The true anomaly (nu) is never compared.',
    'captureOffset is the time after the event at which the state was taken (the first control tick that sees the milestone): 0 for events that coincide with a control tick, up to 1/30 s otherwise. Under thrust or drag the state at the capture is not the state at the event.',
    'Event mission time is ut - startUt of the same record.',
    'What the envelope catches: about 5e-5 in da/a from the first staging to orbit; after TLI it is a sanity bound only (0.3-1.6 % in a, 150-1,300 s). Same-start equality (reference-v1-aligned.json) catches about 1e-8 in the integrated ascent and nothing after EARTH_ORBIT.',
  ],
};

interface V3 {
  x: number;
  y: number;
  z: number;
}
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: V3): number => Math.sqrt(dot(a, a));
const TWO_PI = 2 * Math.PI;
const wrap = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;

/** |a - b| of two angles (rad), taken the short way round: in [0, pi]. */
export function angleDifference(a: number, b: number): number {
  const d = wrap(a - b);
  return d > Math.PI ? TWO_PI - d : d;
}

/** Classical elements of the state (r, v) about a body of gravitational parameter mu, BCI axes. */
export function elementsOf(mu: number, r: V3, v: V3): Elements {
  const rm = len(r);
  const hv = cross(r, v);
  const h = len(hv);
  const energy = dot(v, v) / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const rv = dot(r, v);
  const k = dot(v, v) - mu / rm;
  const ev: V3 = { x: (k * r.x - rv * v.x) / mu, y: (k * r.y - rv * v.y) / mu, z: (k * r.z - rv * v.z) / mu };
  const e = len(ev);
  const i = Math.acos(Math.max(-1, Math.min(1, hv.z / h)));
  const n: V3 = { x: -hv.y, y: hv.x, z: 0 };
  const nm = len(n);
  const lan = nm > 1e-12 * h ? wrap(Math.atan2(n.y, n.x)) : 0;
  // Angles measured in the orbit plane from the node line (or from +X for an equatorial orbit).
  const nodeDir: V3 = nm > 1e-12 * h ? { x: n.x / nm, y: n.y / nm, z: 0 } : { x: 1, y: 0, z: 0 };
  const inPlane = cross({ x: hv.x / h, y: hv.y / h, z: hv.z / h }, nodeDir);
  const angle = (d: V3): number => wrap(Math.atan2(dot(d, inPlane), dot(d, nodeDir)));
  const argPe = e > 1e-12 ? angle(ev) : 0;
  const nu = wrap(angle(r) - argPe);
  return { a, e, i, lan, argPe, nu, energy, h };
}

/** Event mission time of a milestone of a record, s. */
export const missionTime = (record: Pick<MissionRecord, 'startUt'>, m: Pick<MilestoneState, 'ut'>): number => m.ut - record.startUt;

// ------------------------------------------------------------------------------------------------- EXACT

export interface ExactDifference {
  milestone: string;
  index: number;
  /** Fields that differ, with both values (reference first). */
  fields: { field: string; reference: unknown; candidate: unknown }[];
}

const SCALARS: (keyof MilestoneState)[] = ['id', 'ut', 'captureUt', 'vesselId', 'bodyId', 'situation', 'mass', 'apoapsisAltitude', 'periapsisAltitude', 'latitude', 'longitude', 'altitudeAsl', 'speedOrbital', 'speedSurface'];

/**
 * EXACT: every milestone equal. Returns the milestones that differ, in order (empty = equal); the first
 * entry is where the difference starts. `met` and `elements` are derived from compared fields and are not
 * compared themselves, so a record written by a later recorder version stays comparable.
 */
export function compareExact(reference: MissionRecord, candidate: MissionRecord): ExactDifference[] {
  const out: ExactDifference[] = [];
  const n = Math.max(reference.milestones.length, candidate.milestones.length);
  for (let index = 0; index < n; index++) {
    const a = reference.milestones[index];
    const b = candidate.milestones[index];
    const fields: ExactDifference['fields'] = [];
    if (!a || !b) {
      out.push({ milestone: (a ?? b)!.id, index, fields: [{ field: 'present', reference: a !== undefined, candidate: b !== undefined }] });
      continue;
    }
    for (const f of SCALARS) if (!Object.is(a[f], b[f])) fields.push({ field: f, reference: a[f], candidate: b[f] });
    for (let k = 0; k < 3; k++) {
      if (!Object.is(a.r[k], b.r[k])) fields.push({ field: `r[${k}]`, reference: a.r[k], candidate: b.r[k] });
      if (!Object.is(a.v[k], b.v[k])) fields.push({ field: `v[${k}]`, reference: a.v[k], candidate: b.v[k] });
    }
    for (const key of [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])].sort()) {
      if (!Object.is(a.data[key], b.data[key])) fields.push({ field: `data.${key}`, reference: a.data[key], candidate: b.data[key] });
    }
    if (fields.length > 0) out.push({ milestone: a.id, index, fields });
  }
  return out;
}

export function describeExact(reference: MissionRecord, candidate: MissionRecord, diffs: ExactDifference[]): string {
  if (diffs.length === 0) return `EXACT: all ${reference.milestones.length} milestones equal (state hash ${candidate.stateHash}${candidate.stateHash === reference.stateHash ? ' = reference' : `, reference ${reference.stateHash}`})`;
  const first = diffs[0]!;
  const shown = first.fields.slice(0, 6).map((f) => `${f.field}: ${String(f.reference)} -> ${String(f.candidate)}`);
  return (
    `EXACT: ${diffs.length} of ${reference.milestones.length} milestones differ. The difference starts at ${first.milestone} (#${first.index + 1}): ` +
    `${shown.join('; ')}${first.fields.length > shown.length ? `; and ${first.fields.length - shown.length} more fields` : ''}. ` +
    `Equal before it: ${reference.milestones.slice(0, first.index).map((m) => m.id).join(', ') || 'nothing'}.`
  );
}

// ---------------------------------------------------------------------------------------------- ENVELOPE

/** Floors of the envelope: one control tick of event time, and float noise in da/a, in e and in i (rad). */
export const ENVELOPE_TIME_FLOOR = 1 / 30;
export const ENVELOPE_DA_FLOOR = 1e-12;
export const ENVELOPE_DE_FLOOR = 1e-12;
export const ENVELOPE_DI_FLOOR = 1e-12;
/** The flight may differ by this many times the largest difference among the controls. */
export const ENVELOPE_FACTOR = 2;

export interface MilestoneDifference {
  id: string;
  /** Capture offsets after the event, s (reference, other). */
  captureOffset: [number, number];
  /** Difference of the event mission time, s (signed: other - reference). */
  dTime: number;
  /** (a - a_ref) / |a_ref| (signed). */
  dA: number;
  /** e - e_ref (signed), and |i - i_ref| as a wrapped absolute difference, rad. Both are judged by the envelope. */
  dE: number;
  dI: number;
  /** Information: lan and argPe as wrapped absolute differences (rad). `nu` is never compared. */
  dLan: number;
  dArgPe: number;
  /** Information: differences of altitude (m) and of orbital speed (m/s) at the two captures. */
  dAltitude: number;
  dSpeed: number;
  /**
   * The milestone was not reached, or the two states are about different bodies or in different situations
   * (the elements are then not comparable). The envelope fails on any of them.
   */
  mismatch: string | null;
}

/** `mismatch` of a milestone that the other flight did not reach. */
export const NOT_REACHED = 'the milestone was not reached';

/** Per-milestone differences of `other` from `reference` (milestones are matched by id). */
export function milestoneDifferences(reference: MissionRecord, other: MissionRecord): MilestoneDifference[] {
  return reference.milestones.map((a) => {
    const b = other.milestones.find((m) => m.id === a.id);
    if (!b) {
      return { id: a.id, captureOffset: [a.captureOffset, Number.NaN], dTime: Number.NaN, dA: Number.NaN, dE: Number.NaN, dI: Number.NaN, dLan: Number.NaN, dArgPe: Number.NaN, dAltitude: Number.NaN, dSpeed: Number.NaN, mismatch: NOT_REACHED };
    }
    return {
      id: a.id,
      captureOffset: [a.captureOffset, b.captureOffset],
      dTime: missionTime(other, b) - missionTime(reference, a),
      dA: (b.elements.a - a.elements.a) / Math.abs(a.elements.a),
      dE: b.elements.e - a.elements.e,
      dI: angleDifference(b.elements.i, a.elements.i),
      dLan: angleDifference(b.elements.lan, a.elements.lan),
      dArgPe: angleDifference(b.elements.argPe, a.elements.argPe),
      dAltitude: b.altitudeAsl - a.altitudeAsl,
      dSpeed: b.speedOrbital - a.speedOrbital,
      mismatch: a.bodyId !== b.bodyId ? `about ${b.bodyId}, reference about ${a.bodyId}` : a.situation !== b.situation ? `situation ${b.situation}, reference ${a.situation}` : null,
    };
  });
}

export interface EnvelopeRow extends MilestoneDifference {
  /** Largest |dTime|, |dA|, |dE| and dI among the controls, and the allowed values (factor x largest, at least the floor). */
  controlTime: number;
  controlA: number;
  controlE: number;
  controlI: number;
  allowedTime: number;
  allowedA: number;
  allowedE: number;
  allowedI: number;
  pass: boolean;
  /** Every reason the milestone is outside, joined by "; " (null when it passes). */
  why: string | null;
}

/**
 * ENVELOPE: `candidate` against `reference`, judged by the control flights (records of the reference code
 * with shifted starts). Per milestone the candidate must be about the reference's body in the reference's
 * situation, and within the allowed difference in event mission time, da/a, e and i.
 *
 * At least two controls are required. A milestone that a control did not reach, or at which a control is
 * about another body or in another situation than the reference, has no envelope (differences of elements
 * about two bodies mean nothing): that is a failure of the controls file, not of the candidate, and the row
 * says so.
 */
export function compareEnvelope(reference: MissionRecord, candidate: MissionRecord, controls: MissionRecord[]): EnvelopeRow[] {
  if (controls.length < 2) throw new Error(`the envelope needs at least two control flights (got ${controls.length})`);
  const controlDiffs = controls.map((c) => milestoneDifferences(reference, c));
  return milestoneDifferences(reference, candidate).map((d, index) => {
    const column = controlDiffs.map((c) => c[index]!);
    const brokenAt = column.findIndex((c) => c.mismatch !== null);
    const largest = (of: (c: MilestoneDifference) => number): number => Math.max(...column.map((c) => Math.abs(of(c))));
    const controlTime = largest((c) => c.dTime);
    const controlA = largest((c) => c.dA);
    const controlE = largest((c) => c.dE);
    const controlI = largest((c) => c.dI);
    const allowedTime = Math.max(ENVELOPE_TIME_FLOOR, ENVELOPE_FACTOR * controlTime);
    const allowedA = Math.max(ENVELOPE_DA_FLOOR, ENVELOPE_FACTOR * controlA);
    const allowedE = Math.max(ENVELOPE_DE_FLOOR, ENVELOPE_FACTOR * controlE);
    const allowedI = Math.max(ENVELOPE_DI_FLOOR, ENVELOPE_FACTOR * controlI);
    const reasons: string[] = [];
    if (brokenAt >= 0) {
      const c = column[brokenAt]!;
      reasons.push(
        c.mismatch === NOT_REACHED
          ? 'a control flight did not reach this milestone: the controls file is unusable'
          : `control flight ${brokenAt + 1} is ${c.mismatch} here, so the milestone has no envelope: the controls file is unusable`,
      );
    } else if (d.mismatch !== null) {
      // Not reached, another body or another situation: the element differences below mean nothing.
      reasons.push(d.mismatch);
    } else {
      // `!(x <= allowed)` and not `x > allowed`: a NaN difference is outside.
      if (!(Math.abs(d.dTime) <= allowedTime)) reasons.push(`event time differs by ${d.dTime.toFixed(3)} s, allowed ${allowedTime.toFixed(3)} s`);
      if (!(Math.abs(d.dA) <= allowedA)) reasons.push(`da/a ${d.dA.toExponential(2)}, allowed ${allowedA.toExponential(2)}`);
      if (!(Math.abs(d.dE) <= allowedE)) reasons.push(`de ${d.dE.toExponential(2)}, allowed ${allowedE.toExponential(2)}`);
      if (!(Math.abs(d.dI) <= allowedI)) reasons.push(`di ${d.dI.toExponential(2)} rad, allowed ${allowedI.toExponential(2)} rad`);
    }
    const why = reasons.length > 0 ? reasons.join('; ') : null;
    return { ...d, controlTime, controlA, controlE, controlI, allowedTime, allowedA, allowedE, allowedI, pass: why === null, why };
  });
}

const sci = (x: number): string => (Number.isFinite(x) ? x.toExponential(2) : 'n/a');

/** A table of the envelope comparison, one line per milestone. */
export function describeEnvelope(rows: EnvelopeRow[]): string {
  const head = 'milestone                capture offset (ref, flight) s   dTime s (allowed)        da/a (allowed)            de (allowed)              di rad (allowed)          dlan rad  dargPe rad  result';
  const lines = rows.map((r) =>
    [
      r.id.padEnd(24),
      `${r.captureOffset[0].toFixed(4)}, ${Number.isFinite(r.captureOffset[1]) ? r.captureOffset[1].toFixed(4) : 'n/a'}`.padEnd(32),
      `${Number.isFinite(r.dTime) ? r.dTime.toFixed(3) : 'n/a'} (${r.allowedTime.toFixed(3)})`.padEnd(24),
      `${sci(r.dA)} (${sci(r.allowedA)})`.padEnd(25),
      `${sci(r.dE)} (${sci(r.allowedE)})`.padEnd(25),
      `${sci(r.dI)} (${sci(r.allowedI)})`.padEnd(25),
      sci(r.dLan).padEnd(9),
      sci(r.dArgPe).padEnd(11),
      r.pass ? 'ok' : `OUTSIDE: ${r.why}`,
    ].join(' '),
  );
  const failed = rows.filter((r) => !r.pass);
  return `${head}\n${lines.join('\n')}\nENVELOPE: ${failed.length === 0 ? `all ${rows.length} milestones about the reference's body in its situation and inside twice the controls' spread in event time, da/a, e and i` : `${failed.length} of ${rows.length} milestones outside (${failed.map((r) => r.id).join(', ')})`}. The mission gates must pass as well (npm run test:mission).`;
}

/** Read a controls file: an array of records, or `{ controls: [...] }`. */
export function parseControls(json: unknown): MissionRecord[] {
  const list = Array.isArray(json) ? json : (json as { controls?: unknown }).controls;
  if (!Array.isArray(list)) throw new Error('a controls file is an array of mission records, or { "controls": [ ... ] }');
  return list.map((c, i) => normaliseRecord(c as MissionRecord, `control ${i + 1}`));
}

/**
 * Accept a record written before format 2 (no captureOffset, no label): the offset is captureUt - ut. A
 * record needs `startUt` and, per milestone, id, ut, captureUt, bodyId, situation, r, v, elements.
 */
export function normaliseRecord(record: MissionRecord, fallbackLabel: string): MissionRecord {
  if (typeof record.startUt !== 'number' || !Array.isArray(record.milestones)) throw new Error(`${fallbackLabel}: not a mission record (startUt and milestones are required)`);
  return {
    ...record,
    format: 2,
    label: record.label ?? fallbackLabel,
    milestones: record.milestones.map((m) => ({ ...m, captureOffset: m.captureOffset ?? m.captureUt - m.ut })),
  };
}
