/**
 * Procedural crater relief and freshness for bodies with no global map (planet bake, ARCHITECTURE 8.5):
 * the crater population of the body's generic amplification model (src/terrain/amplification/generic.ts),
 * at the diameters the run-time model leaves to the data, plus the config's named craters.
 *
 * Every class of the extended field gets the weight
 *     w_c = (1 - smootherstep(log2MaxD_rt - log2 D_hi)) * smootherstep(log2 D_lo - log2 lambda)
 * where log2MaxD_rt is the run-time model's crater limit at the global max height level (generic.ts:
 * runtimeCraterLog2MaxD) and lambda the sample spacing of the baked level: the run-time model draws the
 * complement, so each crater of the population appears exactly once.
 *
 * Run (the Python driver does this, at most 6 parts in parallel):
 *   npx tsx tools/bake/planet/procedural.ts <job.json> <part> <parts>
 * job.json: { radius, heightLevel, albedoLevel, amplification, maxDiameter, named: [...], outDir,
 *             height: [[face, x, y], ...], albedo: [[face, x, y], ...] }
 * Writes <outDir>/h/<face>_<x>_<y>.f32 (259 x 259 relief, m, row j = v) and <outDir>/a/<face>_<x>_<y>.f32
 * (256 x 256 freshness 0..1), float32 little-endian, atomically (temp file + rename).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TerrainAmplificationDef } from '../../../src/core/contracts/defs';
import { tileUvToDir, type FaceId } from '../../../src/core/geo/cubeSphere';
import { genericCraterParams, runtimeCraterLog2MaxD } from '../../../src/terrain/amplification/generic';
import { CraterField, profile, type CraterClass } from '../../../src/terrain/craters';
import { smootherstep01 } from '../../../src/terrain/util';

interface NamedCrater {
  name: string;
  latDeg: number;
  lonDegE: number;
  diameterKm: number;
  depthKm: number;
  rimKm: number;
}

interface Job {
  radius: number;
  heightLevel: number;
  albedoLevel: number;
  amplification: TerrainAmplificationDef;
  maxDiameter: number;
  named: NamedCrater[];
  outDir: string;
  height: [number, number, number][];
  albedo: [number, number, number][];
}

const HEIGHT_STORED = 259;
const IMAGE = 256;

interface Weighted {
  c: CraterClass;
  w: number;
}

function weightedClasses(field: CraterField, log2MaxDRt: number, log2Lambda: number): Weighted[] {
  const out: Weighted[] = [];
  for (const c of field.classes) {
    const w = (1 - smootherstep01(log2MaxDRt - c.log2DHi)) * smootherstep01(c.log2DLo - log2Lambda);
    if (w > 0) out.push({ c, w });
  }
  return out;
}

interface NamedRec {
  cx: number;
  cy: number;
  cz: number;
  reach: number;
  invHalfD: number;
  depth: number;
  rim: number;
  rounding: number;
}

function namedRecords(job: Job, ext: number, roundingFresh: number): NamedRec[] {
  const R = job.radius;
  return job.named.map((n) => {
    const lat = (n.latDeg * Math.PI) / 180;
    const lon = (n.lonDegE * Math.PI) / 180;
    const D = n.diameterKm * 1000;
    const depth = n.depthKm * 1000;
    const rim = n.rimKm * 1000;
    return {
      cx: R * Math.cos(lat) * Math.cos(lon),
      cy: R * Math.cos(lat) * Math.sin(lon),
      cz: R * Math.sin(lat),
      reach: (ext / 2) * D,
      invHalfD: 2 / D,
      depth,
      rim,
      rounding: roundingFresh * (depth + rim),
    };
  });
}

async function writeF32(file: string, a: Float32Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial`;
  await fs.writeFile(tmp, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  await fs.rename(tmp, file);
}

async function main(): Promise<void> {
  const [jobPath, partS, partsS] = process.argv.slice(2);
  if (!jobPath || partS === undefined || partsS === undefined) throw new Error('usage: procedural.ts <job.json> <part> <parts>');
  const part = Number(partS);
  const parts = Number(partsS);
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8')) as Job;
  const R = job.radius;
  const lambda0 = (Math.PI * R) / 256;
  const def = job.amplification;
  const field = new CraterField(genericCraterParams(def, R, job.heightLevel, lambda0, job.maxDiameter));
  const ext = field.p.extentRadii;
  const log2MaxDRt = runtimeCraterLog2MaxD(def, lambda0, job.heightLevel);
  const postingH = (Math.PI * R) / 2 / 2 ** job.heightLevel / 256;
  const texelA = (Math.PI * R) / 2 / 2 ** job.albedoLevel / IMAGE;
  const hClasses = weightedClasses(field, log2MaxDRt, Math.log2(postingH));
  const aClasses = weightedClasses(field, log2MaxDRt, Math.log2(texelA));
  const named = namedRecords(job, ext, field.p.rimRoundingFresh);

  let done = 0;
  for (let i = part; i < job.height.length; i += parts) {
    const [face, x, y] = job.height[i]!;
    const key = { face: face as FaceId, level: job.heightLevel, x, y };
    const out = new Float32Array(HEIGHT_STORED * HEIGHT_STORED);
    for (let j = 0; j < HEIGHT_STORED; j++) {
      for (let ii = 0; ii < HEIGHT_STORED; ii++) {
        const d = tileUvToDir(key, (ii - 1) / 256, (j - 1) / 256);
        const px = d.x * R;
        const py = d.y * R;
        const pz = d.z * R;
        let h = 0;
        for (const { c, w } of hClasses) h += w * c.heightAt(px, py, pz, ext);
        for (const n of named) {
          const dx = px - n.cx;
          const dy = py - n.cy;
          const dz = pz - n.cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < n.reach) h += profile(dist * n.invHalfD, n.depth, n.rim, n.rounding, ext);
        }
        out[j * HEIGHT_STORED + ii] = h;
      }
    }
    await writeF32(path.join(job.outDir, 'h', `${face}_${x}_${y}.f32`), out);
    done++;
  }
  for (let i = part; i < job.albedo.length; i += parts) {
    const [face, x, y] = job.albedo[i]!;
    const key = { face: face as FaceId, level: job.albedoLevel, x, y };
    const out = new Float32Array(IMAGE * IMAGE);
    for (let r = 0; r < IMAGE; r++) {
      for (let col = 0; col < IMAGE; col++) {
        const d = tileUvToDir(key, (col + 0.5) / IMAGE, (r + 0.5) / IMAGE);
        let best = 0;
        for (const { c, w } of aClasses) {
          const v = w * c.freshnessAt(d.x * R, d.y * R, d.z * R, ext, false);
          if (v > best) best = v;
        }
        out[r * IMAGE + col] = best;
      }
    }
    await writeF32(path.join(job.outDir, 'a', `${face}_${x}_${y}.f32`), out);
    done++;
  }
  process.stdout.write(`procedural part ${part}/${parts}: ${done} tiles; classes ${hClasses.length} (height) ${aClasses.length} (albedo), largest D ${field.classes[0]!.dHi.toFixed(0)} m\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
