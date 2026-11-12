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
import { bakeCraterWeight, genericCraterParams, runtimeCraterLog2MaxD } from '../../../src/terrain/amplification/generic';
import { CRATER_O, CRATER_STRIDE, CraterField, profile, type CraterClass } from '../../../src/terrain/craters';
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
  /** Complex craters: above transitionDiameterKm a fresh crater is depthKm (D / 1 km)^exponent deep (km). */
  complex: { transitionDiameterKm: number; depthKm: number; exponent: number } | null;
}

/**
 * Crater relief of one class at P with the complex-crater depth law: above the simple-to-complex transition a
 * crater's depth and rim are scaled by (law's fresh depth) / (freshDepthToDiameter D), at most 1, so a crater
 * keeps its degradation (its share of the fresh depth). The records are the class's own (same cells, same
 * order as CraterClass.heightAt): the population is unchanged; only large craters are shallower.
 */
class ComplexRelief {
  private bx = 0x7fffffff;
  private by = 0;
  private bz = 0;
  private count = 0;
  private rec: Float64Array;

  constructor(
    private readonly c: CraterClass,
    private readonly freshRatio: number,
    private readonly law: { transitionDiameterKm: number; depthKm: number; exponent: number },
  ) {
    this.rec = new Float64Array(8 * c.slots * CRATER_STRIDE);
  }

  /**
   * Depth scale of a crater of diameter D (m): 1 up to the transition D_t; from 2 D_t on, the complex law's
   * fresh depth over the simple one (never above 1); between, a smootherstep blend in log2 D, so the relief is
   * continuous in diameter.
   */
  scale(D: number): number {
    const Dk = D / 1000;
    const Dt = this.law.transitionDiameterKm;
    if (Dk <= Dt) return 1;
    const sc = Math.min(1, (this.law.depthKm * Dk ** this.law.exponent) / (this.freshRatio * Dk));
    return 1 + smootherstep01(Math.log2(Dk / Dt)) * (sc - 1);
  }

  heightAt(px: number, py: number, pz: number, ext: number): number {
    const c = this.c;
    const bx = Math.floor(px * c.invCell - 0.5) | 0;
    const by = Math.floor(py * c.invCell - 0.5) | 0;
    const bz = Math.floor(pz * c.invCell - 0.5) | 0;
    if (bx !== this.bx || by !== this.by || bz !== this.bz) {
      this.bx = bx;
      this.by = by;
      this.bz = bz;
      let n = 0;
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) n = c.cellCratersInto(bx + dx, by + dy, bz + dz, this.rec, n);
      this.count = n;
    }
    const r = this.rec;
    let sum = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += CRATER_STRIDE) {
      const dx = px - r[o + CRATER_O.cx]!;
      const dy = py - r[o + CRATER_O.cy]!;
      const dz = pz - r[o + CRATER_O.cz]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r[o + CRATER_O.reach2]!) continue;
      const s = this.scale(r[o + CRATER_O.diameter]!);
      sum += profile(Math.sqrt(d2) * r[o + CRATER_O.invHalfD]!, r[o + CRATER_O.depth]! * s, r[o + CRATER_O.rim]! * s, r[o + CRATER_O.rounding]! * s, ext);
    }
    return sum;
  }
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
    const w = bakeCraterWeight(c, log2MaxDRt, log2Lambda);
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
  const law = job.complex;
  const hRelief = hClasses.map(({ c, w }) => ({ w, rel: law ? new ComplexRelief(c, field.p.freshDepthToDiameter, law) : c }));

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
        for (const { rel, w } of hRelief) h += w * rel.heightAt(px, py, pz, ext);
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
