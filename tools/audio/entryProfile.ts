/**
 * The mission's entry as the sound model sees it: the capsule alone on the lunar-return trajectory of the
 * nominal vacuum perigee, flown by the mission pilot through the real Sim on the real Earth tiles
 * (tools/sim/entryCorridor.ts), sampled twice a second from five seconds before the entry interface
 * (122 km) to ten seconds after splashdown. What is kept is what the audio model reads of the active vessel:
 * aero state, g-load, situation, parachutes, radar altitude, events.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/audio/entryProfile.ts [--perigee 45]
 *
 * Writes labs/audio/entryProfile.json (read by the lab's `missionEntry` script, the offline acceptance spec
 * tests/browser/audio/audio-offline.spec.ts and tests/unit/audio/entryProfile.test.ts). Re-run it when the
 * entry physics change (drag, heating, the pilot's entry phases).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { createMissionPilot, runHeadless } from '@/pilot';
import { createSim } from '@/sim';
import { entryScenario } from '../sim/entryCorridor';
import { createRealTerrain, loadLibrary, repoRoot } from '../sim/realWorld';

/** One sample. Arrays, to keep the file small: see `ENTRY_PROFILE_FIELDS`. */
export const ENTRY_PROFILE_FIELDS = ['t', 'altitude', 'radar', 'speed', 'mach', 'q', 'pressure', 'density', 'plasma', 'heatFlux', 'gLoad', 'airX', 'airY', 'airZ', 'chute'] as const;

export interface EntryProfileFile {
  perigeeKm: number;
  /** Seconds between samples. */
  step: number;
  fields: readonly string[];
  /** t = seconds since the first sample; airX/Y/Z = air-relative velocity in the vessel's VES axes, m/s; chute: 0 none, 1 drogues, 2 mains. */
  samples: number[][];
  /** Events of the flight: seconds since the first sample and the SimEvent type (with the parachute mode). */
  events: { t: number; type: string; mode?: string; speed?: number }[];
  /** Seconds since the first sample of the milestones. */
  marks: Record<string, number>;
  vehicle: string;
  boundingRadius: number;
}

const num = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

async function main(): Promise<void> {
  const perigeeKm = num('perigee', 45);
  const step = 0.5;
  const defs: DefLibrary = await loadLibrary();
  const terrain = await createRealTerrain(defs);
  const base = defs.scenarios['lunar-direct']!;
  const sc = entryScenario(defs, base, perigeeKm * 1000);
  const lib: DefLibrary = { ...defs, scenarios: { ...defs.scenarios, [sc.id]: sc } };
  const sim = createSim(lib, sc.id, { terrain });
  const pilot = createMissionPilot(lib, sc);
  await sim.ready;

  const samples: number[][] = [];
  const events: EntryProfileFile['events'] = [];
  const marks: Record<string, number> = {};
  let t0 = NaN;
  let next = 0;
  let splashAt = NaN;
  let boundingRadius = 0;
  const seen = new Set<string>();
  const run = await runHeadless(sim, pilot, {
    maxSimTime: 3 * 3600,
    record: false,
    until: (s) => !Number.isNaN(splashAt) && s.simUt - splashAt > 10,
    onTick: (s) => {
      const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
      if (Number.isNaN(t0)) {
        if (s.readouts.altitudeAsl > 126000) return;
        t0 = s.simUt;
      }
      const t = s.simUt - t0;
      for (const m of s.milestones) {
        if (!(m.id in marks)) marks[m.id] = Math.max(0, m.ut - t0);
        if (m.id === 'SPLASHDOWN' && Number.isNaN(splashAt)) splashAt = s.simUt;
      }
      for (const e of s.events) {
        const key = `${e.type}|${e.ut}|${(e as { partId?: string }).partId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rec: EntryProfileFile['events'][number] = { t: Math.round((e.ut - t0) * 100) / 100, type: e.type };
        if (e.type === 'chuteDeployed') rec.mode = e.mode;
        if (e.type === 'splash' || e.type === 'touchdown') rec.speed = Math.round(e.speed * 100) / 100;
        events.push(rec);
      }
      if (t + 1e-9 < next) return;
      next += step;
      boundingRadius = v.boundingRadius;
      const chute = 'MAINS' in marks ? 2 : 'DROGUES' in marks ? 1 : 0;
      const air = quat.rotateInv(v.q, v.aero.airVelocity);
      const r = (x: number, d: number): number => Number(x.toPrecision(d));
      samples.push([
        Math.round(t * 100) / 100,
        Math.round(s.readouts.altitudeAsl),
        Math.round(s.readouts.altitudeRadar),
        r(v3.len(v.aero.airVelocity), 5),
        r(v.aero.mach, 4),
        r(v.aero.q, 4),
        r(v.aero.pressure, 4),
        r(v.aero.airDensity, 4),
        r(v.aero.plasmaIntensity, 3),
        r(v.aero.heatFlux, 4),
        r(v.gLoad, 3),
        r(air.x, 4),
        r(air.y, 4),
        r(air.z, 4),
        chute,
      ]);
    },
  });
  if (!marks['SPLASHDOWN']) throw new Error(`entryProfile: the entry did not end in a splashdown (${run.reason}${run.failure ? `: ${run.failure}` : ''})`);
  const v = run.last.vessels.find((x) => x.id === run.last.activeVesselId)!;
  const file: EntryProfileFile = { perigeeKm, step, fields: ENTRY_PROFILE_FIELDS, samples, events, marks, vehicle: v.vehicleId, boundingRadius: Number(boundingRadius.toPrecision(4)) };
  const out = path.join(repoRoot, 'labs', 'audio', 'entryProfile.json');
  fs.writeFileSync(out, `${JSON.stringify(file)}\n`);
  console.log(`wrote ${out}: ${samples.length} samples over ${samples[samples.length - 1]![0]} s; marks ${JSON.stringify(marks)}`);
  const pick = (i: number): string => {
    const s = samples[i]!;
    return `t ${s[0]!.toFixed(0).padStart(5)} s  alt ${(s[1]! / 1000).toFixed(1).padStart(6)} km  v ${s[3]!.toFixed(0).padStart(6)} m/s  M ${s[4]!.toFixed(1).padStart(5)}  q ${s[5]!.toFixed(0).padStart(6)} Pa  p ${s[6]!.toFixed(1).padStart(8)} Pa  plasma ${s[8]!.toFixed(2)}  flux ${(s[9]! / 1000).toFixed(0).padStart(5)} kW/m2  g ${s[10]!.toFixed(2)}  chute ${s[14]}`;
  };
  for (let i = 0; i < samples.length; i += 20) console.log(pick(i));
}

await main();
