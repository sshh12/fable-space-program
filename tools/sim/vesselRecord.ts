/**
 * The record of EVERY vessel of the mission flight, for the proof of a re-baseline of the golden hash
 * (docs/handoff/island-core.md): what the trajectory guard holds for the attended craft, taken for every
 * vessel of the snapshot at the guard's 400 control ticks (body, position, velocity, attitude and mass as
 * float64 bit patterns), with the fate of every vessel the session removed and the survivors at the end.
 * The same flight also gives the mission record of tools/dev/record-mission-baseline.ts (the EXACT
 * comparison of the 17 milestones).
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/vesselRecord.ts --out <vessels.json> [--mission <record.json>] [--label <text>]
 *       fly `lunar-direct` once and write the per-vessel record (and the mission record)
 *   npx tsx tools/sim/vesselRecord.ts --compare <before.json> <after.json>
 *       nothing flies. Prints (1) whether every vessel that was ever attended is EXACTLY equal at all 400
 *       ticks, (2) one row per other vessel: the samples that differ, the largest difference in units in the
 *       last place and in metres, and its fate in both flights. Exit 1 when an attended sample differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { captureMilestones, writeRecord } from '../dev/record-mission-baseline';
import { repoRoot } from './realWorld';
import { bits, fromBits, readGuard } from './trajectoryGuard';

interface RecordedVessel {
  id: string;
  name: string;
  bodyId: string;
  situation: string;
  tier: string;
  /** Float64 bit patterns: r (3), v (3), q (4), mass. */
  n: string[];
}

interface RecordedSample {
  controlTick: number;
  tick: number;
  activeId: string | null;
  vessels: RecordedVessel[];
}

interface RecordedFate {
  vesselId: string;
  name: string;
  reason: string;
  ut: number;
  bodyId: string;
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface VesselRecord {
  label: string;
  stateHash: string;
  steps: number;
  railsAdvances: number;
  controlTicks: number;
  endTick: number;
  samples: RecordedSample[];
  fates: RecordedFate[];
  survivors: { id: string; name: string; bodyId: string; situation: string }[];
}

const vesselOf = (v: VesselSnapshot): RecordedVessel => ({
  id: v.id,
  name: v.name,
  bodyId: v.bodyId,
  situation: v.situation,
  tier: v.tier,
  n: [v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.x, v.q.y, v.q.z, v.q.w, v.mass].map(bits),
});

/** Distance of two float64 values in units in the last place (the count of representable values between them). */
export function ulpsApart(a: string, b: string): number {
  if (a === b) return 0;
  const ordered = (hex: string): bigint => {
    const x = BigInt(`0x${hex}`);
    const sign = x >> 63n;
    const magnitude = x & 0x7fffffffffffffffn;
    return sign === 1n ? -magnitude : magnitude;
  };
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

function surfaceDistance(latA: number, lonA: number, latB: number, lonB: number, radius: number): number {
  const rad = Math.PI / 180;
  const dir = (lat: number, lon: number): [number, number, number] => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
  const a = dir(latA, lonA);
  const b = dir(latB, lonB);
  const chord = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return 2 * Math.asin(Math.min(1, chord / 2)) * radius;
}

interface Row {
  id: string;
  name: string;
  attended: boolean;
  samples: number;
  differing: number;
  onlyBefore: number;
  onlyAfter: number;
  firstDifferingTick: number | null;
  maxUlpR: number;
  maxUlpV: number;
  maxUlpQ: number;
  maxDr: number;
  maxDv: number;
  fate: string;
}

export function compareRecords(before: VesselRecord, after: VesselRecord, radiusOf: (bodyId: string) => number): { rows: Row[]; attendedEqual: boolean; text: string } {
  const lines: string[] = [];
  const attendedIds = new Set<string>();
  for (const s of before.samples) if (s.activeId !== null) attendedIds.add(s.activeId);
  for (const s of after.samples) if (s.activeId !== null) attendedIds.add(s.activeId);
  const rows = new Map<string, Row>();
  const rowOf = (v: RecordedVessel): Row => {
    let r = rows.get(v.id);
    if (!r) rows.set(v.id, (r = { id: v.id, name: v.name, attended: attendedIds.has(v.id), samples: 0, differing: 0, onlyBefore: 0, onlyAfter: 0, firstDifferingTick: null, maxUlpR: 0, maxUlpV: 0, maxUlpQ: 0, maxDr: 0, maxDv: 0, fate: '' }));
    return r;
  };
  if (before.samples.length !== after.samples.length) lines.push(`SAMPLES: ${after.samples.length} after, ${before.samples.length} before`);
  let ticksEqual = true;
  for (let i = 0; i < Math.min(before.samples.length, after.samples.length); i++) {
    const a = before.samples[i]!;
    const b = after.samples[i]!;
    if (a.tick !== b.tick || a.controlTick !== b.controlTick || a.activeId !== b.activeId) ticksEqual = false;
    const inB = new Map(b.vessels.map((v) => [v.id, v]));
    for (const va of a.vessels) {
      const row = rowOf(va);
      const vb = inB.get(va.id);
      if (!vb) {
        row.onlyBefore++;
        continue;
      }
      inB.delete(va.id);
      row.samples++;
      let differs = va.bodyId !== vb.bodyId;
      const num = (k: number, of: RecordedVessel): number => fromBits(of.n[k]!);
      if (va.bodyId === vb.bodyId) {
        for (let k = 0; k < 11; k++) {
          const u = ulpsApart(va.n[k]!, vb.n[k]!);
          if (u === 0) continue;
          differs = true;
          if (k < 3) row.maxUlpR = Math.max(row.maxUlpR, u);
          else if (k < 6) row.maxUlpV = Math.max(row.maxUlpV, u);
          else if (k < 10) row.maxUlpQ = Math.max(row.maxUlpQ, u);
        }
        row.maxDr = Math.max(row.maxDr, Math.hypot(num(0, va) - num(0, vb), num(1, va) - num(1, vb), num(2, va) - num(2, vb)));
        row.maxDv = Math.max(row.maxDv, Math.hypot(num(3, va) - num(3, vb), num(4, va) - num(4, vb), num(5, va) - num(5, vb)));
      }
      if (differs) {
        row.differing++;
        row.firstDifferingTick ??= a.controlTick;
      }
    }
    for (const vb of inB.values()) rowOf(vb).onlyAfter++;
  }
  // Fates, by vessel id.
  const fateB = new Map(after.fates.map((f) => [f.vesselId, f]));
  for (const fa of before.fates) {
    const row = rows.get(fa.vesselId) ?? rowOf({ id: fa.vesselId, name: fa.name, bodyId: fa.bodyId, situation: '', tier: '', n: [] });
    const fb = fateB.get(fa.vesselId);
    fateB.delete(fa.vesselId);
    if (!fb) row.fate = `${fa.reason} before, NO FATE after`;
    else if (fa.reason !== fb.reason || fa.bodyId !== fb.bodyId) row.fate = `${fa.reason} on ${fa.bodyId} before, ${fb.reason} on ${fb.bodyId} after`;
    else row.fate = `${fa.reason} at T+${(fa.ut - before.samples[0]!.tick / 120).toFixed(1)} s: ${(fb.ut - fa.ut).toFixed(4)} s, ${surfaceDistance(fa.latitudeDeg, fa.longitudeDeg, fb.latitudeDeg, fb.longitudeDeg, radiusOf(fa.bodyId)).toFixed(3)} m`;
  }
  for (const fb of fateB.values()) (rows.get(fb.vesselId) ?? rowOf({ id: fb.vesselId, name: fb.name, bodyId: fb.bodyId, situation: '', tier: '', n: [] })).fate = `NO FATE before, ${fb.reason} after`;
  const survA = new Map(before.survivors.map((s) => [s.id, s]));
  for (const sb of after.survivors) {
    const sa = survA.get(sb.id);
    const row = rows.get(sb.id);
    if (row && row.fate === '') row.fate = sa ? `survives (${sa.situation} about ${sa.bodyId}${sa.situation === sb.situation && sa.bodyId === sb.bodyId ? '' : ` before, ${sb.situation} about ${sb.bodyId} after`})` : `survives after only`;
  }
  const all = [...rows.values()];
  const attended = all.filter((r) => r.attended);
  const attendedEqual = ticksEqual && before.samples.length === after.samples.length && attended.every((r) => r.differing === 0 && r.onlyBefore === 0 && r.onlyAfter === 0);
  lines.push(`before: ${before.label}, hash ${before.stateHash}, ${before.steps} steps, ${before.railsAdvances} rails advances, ${before.controlTicks} control ticks, end tick ${before.endTick}`);
  lines.push(`after:  ${after.label}, hash ${after.stateHash}, ${after.steps} steps, ${after.railsAdvances} rails advances, ${after.controlTicks} control ticks, end tick ${after.endTick}`);
  lines.push(`sample ticks and the active vessel at each: ${ticksEqual ? 'equal' : 'DIFFERENT'}`);
  for (const r of attended) lines.push(`ATTENDED ${r.id} (${r.name}): ${r.samples} samples in both, ${r.differing} differ${r.differing === 0 ? ' (EXACTLY equal: body, r, v, q, mass)' : `, first at control tick ${r.firstDifferingTick}`}`);
  lines.push('| vessel | id | samples in both | differing | first at control tick | max ulp r / v / q | max dr, m | max dv, m/s | only before / after | fate (after - before) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of all.filter((x) => !x.attended)) {
    lines.push(`| ${r.name} | ${r.id} | ${r.samples} | ${r.differing} | ${r.firstDifferingTick ?? '-'} | ${r.maxUlpR} / ${r.maxUlpV} / ${r.maxUlpQ} | ${r.maxDr.toExponential(2)} | ${r.maxDv.toExponential(2)} | ${r.onlyBefore} / ${r.onlyAfter} | ${r.fate} |`);
  }
  return { rows: all, attendedEqual, text: lines.join('\n') };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).split(path.sep).join('/').endsWith('tools/sim/vesselRecord.ts');
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const value = (flag: string, offset = 1): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + offset] : undefined;
  };
  if (argv.includes('--compare')) {
    const before = JSON.parse(fs.readFileSync(path.resolve(value('--compare', 1) ?? ''), 'utf8')) as VesselRecord;
    const after = JSON.parse(fs.readFileSync(path.resolve(value('--compare', 2) ?? ''), 'utf8')) as VesselRecord;
    const { loadLibrary } = await import('./realWorld');
    const defs = await loadLibrary();
    const result = compareRecords(before, after, (id) => defs.bodies[id]!.radius);
    console.log(result.text);
    process.exit(result.attendedEqual ? 0 : 1);
  } else if (argv.includes('--out')) {
    const out = path.resolve(value('--out') ?? '');
    const label = value('--label') ?? path.basename(out, '.json');
    const { fly, tileContentHashes } = await import('../../tests/mission/harness');
    const wanted = new Set(readGuard().samples.map((s) => s.controlTick));
    const samples: RecordedSample[] = [];
    const capture = captureMilestones(label);
    let tick = -1;
    const flight = await fly({
      scenario: 'lunar-direct',
      onPilotTick: (s: SimSnapshot) => {
        tick++;
        capture.onPilotTick(s);
        if (wanted.has(tick)) samples.push({ controlTick: tick, tick: Math.round(s.simUt * 120), activeId: s.activeVesselId, vessels: s.vessels.map(vesselOf) });
      },
    });
    if (flight.run.failure) throw new Error(`the flight failed: ${flight.run.failure}`);
    const last = flight.run.last;
    const record: VesselRecord = {
      label,
      stateHash: flight.hash,
      steps: flight.run.stats.steps,
      railsAdvances: flight.run.stats.railsAdvances,
      controlTicks: flight.run.stats.ticks,
      endTick: Math.round(flight.run.finalUt * 120),
      samples,
      fates: flight.debris.map((f) => ({ vesselId: f.vesselId, name: f.name, reason: f.reason, ut: f.ut, bodyId: f.bodyId, latitudeDeg: f.latitudeDeg, longitudeDeg: f.longitudeDeg })),
      survivors: last.vessels.filter((v) => v.id !== last.activeVesselId).map((v) => ({ id: v.id, name: v.name, bodyId: v.bodyId, situation: v.situation })),
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(record)}\n`);
    console.log(`vessel record: wrote ${path.relative(repoRoot, out)}: state hash ${record.stateHash}, ${record.steps} steps, ${samples.length} samples, ${record.fates.length} fates, ${record.survivors.length} survivors`);
    const missionFile = value('--mission');
    if (missionFile) {
      const mission = capture.finish(flight, tileContentHashes(flight.defs));
      writeRecord(path.resolve(missionFile), mission);
      console.log(`mission record: wrote ${path.relative(repoRoot, path.resolve(missionFile))}: state hash ${mission.stateHash}, ${mission.steps} steps, ${mission.milestones.length} milestones`);
    }
    process.exit(0);
  } else {
    console.error('usage: vesselRecord.ts --out <vessels.json> [--mission <record.json>] [--label <text>] | --compare <before.json> <after.json>');
    process.exit(2);
  }
}
