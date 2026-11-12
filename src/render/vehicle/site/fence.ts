/**
 * 'pad.fence': the security fence of a launch complex, on the surveyed ground: chain-link fabric on
 * galvanised posts with a top rail and three strands of barbed wire on outriggers, and gates where roads
 * and the crawlerway pass through it.
 *
 * Parameters (site frame of the structure: +X east, +Z south):
 *
 *   path        "x,z>x,z>..."            the fence line (a closed loop when `closed` is 1)
 *   fillet      corner radius, m
 *   height      height of the fabric, m (default 2.4)
 *   gates       "x,z,width,kind;..."     openings centred at the point of the line nearest (x, z): kind 0 = a
 *                                        pair of swing leaves standing open, 1 = a clear opening between posts
 *
 * The line is cut into runs of about 180 m, each a model of its own, so that every run picks its detail by
 * its own distance: round posts, rail, wires and outriggers close by; square posts beyond; and from afar
 * only the fabric (a faint grey veil, as chain-link is) under a rail a pixel wide. A fence casts no shadow
 * the cascades could resolve.
 */
import type { Vec3Tuple } from '@/core/math';
import type { MeshBuilder } from '../geom/builder';
import { box, rod } from '../geom/prims';
import { buildModel, parseList } from '../parts/common';
import type { PartModel } from '../parts/types';
import { filletPlan, parsePath, stationsAlong, type Station } from './ground';
import type { GroundField } from './survey';
import { numParam, strParam, type SiteGenerator } from './types';

const POST_SPACING = 3;
const RUN_POSTS = 60;

interface Gate {
  x: number;
  z: number;
  width: number;
  kind: number;
}

/** Fabric between two stations: one quad from under the ground to the top rail, UVs in metres. */
function fabric(b: MeshBuilder, ground: GroundField, a: Station, c: Station, height: number): void {
  const pts = [a, c].map((q) => ({ x: q.p[0], z: q.p[1], y0: ground.lo(q.p[0], q.p[1]) - 0.1, y1: ground.hi(q.p[0], q.p[1]) + height, s: q.s }));
  const n: Vec3Tuple = [a.n[0], 0, a.n[1]];
  const ids = pts.flatMap((p) => [b.v(p.x, p.y0, p.z, n[0], n[1], n[2], a.d[0], 0, a.d[1], p.s, 0), b.v(p.x, p.y1, p.z, n[0], n[1], n[2], a.d[0], 0, a.d[1], p.s, p.y1 - p.y0)]);
  b.quad(ids[0]!, ids[1]!, ids[3]!, ids[2]!);
}

function leaf(b: MeshBuilder, hinge: Vec3Tuple, dir: [number, number], width: number, height: number): void {
  const end: Vec3Tuple = [hinge[0] + dir[0] * width, hinge[1], hinge[2] + dir[1] * width];
  const up = (p: Vec3Tuple, h: number): Vec3Tuple => [p[0], p[1] + h, p[2]];
  b.mat('galvanised').masks(0.15, 1, 0.2, 0);
  const segs = b.pick(8, 5, 4);
  for (const [p0, p1] of [
    [up(hinge, 0.15), up(end, 0.15)],
    [up(hinge, height), up(end, height)],
    [up(hinge, 0.15), up(hinge, height)],
    [up(end, 0.15), up(end, height)],
    [up(hinge, 0.15), up(end, height)],
  ] as [Vec3Tuple, Vec3Tuple][]) rod(b, p0, p1, 0.03, segs, 'gate-frame');
  b.mat('chainlink').masks(0, 1, 0.1, 0);
  b.begin(false, 'fabric');
  const n: Vec3Tuple = [dir[1], 0, -dir[0]];
  const q = [up(hinge, 0.15), up(end, 0.15), up(end, height), up(hinge, height)];
  const ids = q.map((p, i) => b.v(p[0], p[1], p[2], n[0], n[1], n[2], dir[0], 0, dir[1], i === 1 || i === 2 ? width : 0, i >= 2 ? height - 0.15 : 0));
  b.quad(ids[0]!, ids[3]!, ids[2]!, ids[1]!);
}

export const padFence: SiteGenerator = ({ params, ground }) => {
  const closed = numParam(params, 'closed', 1) > 0;
  const height = numParam(params, 'height', 2.4);
  const line = filletPlan(parsePath(strParam(params, 'path', ''), 'pad.fence'), numParam(params, 'fillet', 20), closed);
  if (closed) line.push(line[0]!);
  const gates: Gate[] = parseList(strParam(params, 'gates', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, width: e.n[2] ?? 8, kind: e.n[3] ?? 0 }));
  const all = stationsAlong(line, POST_SPACING);
  // A gate takes out the stations within half its width of the point of the line nearest to it.
  const gateAt: (Station | null)[] = gates.map((g) => all.reduce<Station | null>((best, q) => (!best || Math.hypot(q.p[0] - g.x, q.p[1] - g.z) < Math.hypot(best.p[0] - g.x, best.p[1] - g.z) ? q : best), null));
  const open = (q: Station): boolean => gates.some((g, i) => Math.abs(q.s - gateAt[i]!.s) < g.width / 2);
  // Runs of consecutive standing stations.
  const runs: Station[][] = [];
  let cur: Station[] = [];
  for (const q of all) {
    if (open(q)) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
      continue;
    }
    cur.push(q);
    if (cur.length > RUN_POSTS) {
      runs.push(cur);
      cur = [q];
    }
  }
  if (cur.length > 1) runs.push(cur);

  const models: Record<string, PartModel> = {};
  runs.forEach((run, k) => {
    models[`run${k}`] = buildModel(
      `pad.fence.run${k}`,
      (b) => {
        const top = (q: Station, h = height): Vec3Tuple => [q.p[0], ground.hi(q.p[0], q.p[1]) + h, q.p[1]];
        const foot = (q: Station): Vec3Tuple => [q.p[0], ground.lo(q.p[0], q.p[1]) - 0.3, q.p[1]];
        b.mat('chainlink').masks(0, 1, 0.1, 0);
        b.begin(false, 'fabric');
        const stride = b.pick(1, 2, 5);
        const kept = run.filter((_, i) => i % stride === 0 || i === run.length - 1);
        for (let i = 0; i + 1 < kept.length; i++) fabric(b, ground, kept[i]!, kept[i + 1]!, height);
        b.mat('galvanised').masks(0.15, 1, 0.2, 0);
        if (b.lod === 2) {
          // A rail the far cascade of pixels can hold: a flat band along the top.
          for (let i = 0; i + 1 < kept.length; i++) rod(b, top(kept[i]!), top(kept[i + 1]!), 0.07, 4, 'rail');
          return;
        }
        for (let i = 0; i + 1 < run.length; i++) rod(b, top(run[i]!), top(run[i + 1]!), b.pick(0.021, 0.04, 0), b.pick(6, 4, 4), 'rail');
        for (const q of run) {
          rod(b, foot(q), top(q, height + 0.05), b.pick(0.03, 0.05, 0), b.pick(8, 4, 4), 'post');
          if (b.lod === 0) {
            // Outrigger leaning outward (to the left of the line) with three strands of barbed wire.
            const o = top(q, height + 0.05);
            rod(b, o, [o[0] + q.n[0] * 0.3, o[1] + 0.38, o[2] + q.n[1] * 0.3], 0.016, 5, 'outrigger');
          }
        }
        if (b.lod === 0) {
          for (let w = 1; w <= 3; w++) {
            const at = (q: Station): Vec3Tuple => {
              const o = top(q, height + 0.05);
              return [o[0] + (q.n[0] * 0.3 * w) / 3, o[1] + (0.38 * w) / 3, o[2] + (q.n[1] * 0.3 * w) / 3];
            };
            for (let i = 0; i + 1 < run.length; i++) rod(b, at(run[i]!), at(run[i + 1]!), 0.004, 3, 'wire');
          }
        }
      },
      [2700, 600],
    );
  });
  const gateModel = buildModel('pad.fence.gates', (b) => {
    gates.forEach((g, i) => {
      const q = gateAt[i]!;
      for (const side of [-1, 1]) {
        const px = q.p[0] + q.d[0] * side * (g.width / 2);
        const pz = q.p[1] + q.d[1] * side * (g.width / 2);
        const y0 = ground.lo(px, pz) - 0.3;
        const y1 = ground.hi(px, pz) + height + 0.35;
        b.mat('galvanised').masks(0.15, 1, 0.25, 0);
        box(b, 0.2, y1 - y0, 0.2, [px, (y0 + y1) / 2, pz], 'gate-post');
        if (g.kind === 0 && b.lod < 2) {
          // The leaf stands open, swung inward (to the right of the line) and a little back from square.
          const sw: [number, number] = [-q.n[0] * 0.985 - q.d[0] * side * 0.17, -q.n[1] * 0.985 - q.d[1] * side * 0.17];
          leaf(b, [px - q.n[0] * 0.16, ground.hi(px, pz), pz - q.n[1] * 0.16], sw, g.width / 2 - 0.15, height);
        }
      }
    });
  });
  return {
    models: { ...models, ...(gates.length > 0 ? { gates: gateModel } : {}) },
    pose: (_state, emit) => {
      for (const name of Object.keys(models)) emit(name, null, null, { castShadow: false, grime: 0.6 });
      if (gates.length > 0) emit('gates', null, null, { nearShadowOnly: true });
    },
  };
};
