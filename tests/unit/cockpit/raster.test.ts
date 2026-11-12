/**
 * What the full-detail interior costs the rasteriser from the commander's seat (the perf spec's view: 2560 x
 * 1440, 70 degrees): triangles per assembly and how large they are on screen. A triangle of a pixel or two
 * costs as much set-up as a large one and shades up to four pixels for each one it covers (the 2 x 2 quads of
 * the rasteriser), so the count of very small triangles in view is what the interior's GPU line pays for.
 */
import { describe, expect, it } from 'vitest';
import { v3, type Vec3 } from '@/core/math';
import { seatFrames } from '@/render/cockpit/cabin/context';
import { EDGE_REACH_MAX, FLAG_LABEL, LABEL_REACH, VERTEX_STRIDE } from '@/render/cockpit/mesh';
import { testDefs, testModel } from './helpers';

interface ViewStats {
  triangles: number;
  inView: number;
  /** In view, by projected area (pixels): under 1, 1 to 4, 4 to 16, 16 to 64, larger. */
  bins: [number, number, number, number, number];
  /** Projected area of the in-view triangles (pixels; overdraw included). */
  area: number;
}

const WIDTH = 2560;
const HEIGHT = 1440;
const FOV_Y = (70 * Math.PI) / 180;

function viewStats(positions: Float32Array, indices: Uint32Array, start: number, count: number, groupOf: (v: number) => string, eye: Vec3, f: Vec3, up: Vec3): Map<string, ViewStats> {
  const r = v3.normalize(v3.cross(f, up));
  const u = v3.cross(r, f);
  const ty = Math.tan(FOV_Y / 2);
  const tx = (ty * WIDTH) / HEIGHT;
  const out = new Map<string, ViewStats>();
  const proj = (i: number): { x: number; y: number; z: number } => {
    const d = { x: positions[i * 3]! - eye.x, y: positions[i * 3 + 1]! - eye.y, z: positions[i * 3 + 2]! - eye.z };
    const z = v3.dot(d, f);
    return { x: ((v3.dot(d, r) / (z * tx)) * 0.5 + 0.5) * WIDTH, y: ((v3.dot(d, u) / (z * ty)) * 0.5 + 0.5) * HEIGHT, z };
  };
  for (let k = start; k < start + count; k += 3) {
    const g = groupOf(indices[k]!);
    let s = out.get(g);
    if (!s) out.set(g, (s = { triangles: 0, inView: 0, bins: [0, 0, 0, 0, 0], area: 0 }));
    s.triangles++;
    const a = proj(indices[k]!);
    const b = proj(indices[k + 1]!);
    const c = proj(indices[k + 2]!);
    if (a.z < 0.05 || b.z < 0.05 || c.z < 0.05) continue;
    const inside = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT;
    if (!inside(a) && !inside(b) && !inside(c)) continue;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    s.inView++;
    s.area += area;
    s.bins[area < 1 ? 0 : area < 4 ? 1 : area < 16 ? 2 : area < 64 ? 3 : 4]++;
  }
  return out;
}

describe('cockpit raster load from the seat', () => {
  it('reports triangles per assembly and their size on screen; the full detail level stays within its budget', async () => {
    const defs = await testDefs();
    const model = await testModel();
    const mesh = model.mesh;
    const f32 = new Float32Array(mesh.vertices);
    const positions = new Float32Array(mesh.vertexCount * 3);
    for (let i = 0; i < mesh.vertexCount; i++) positions.set(f32.subarray((i * VERTEX_STRIDE) / 4, (i * VERTEX_STRIDE) / 4 + 3), i * 3);
    const vehicle = Object.values(defs.vehicles).find((v) => v.cockpit)!;
    const seat = seatFrames(model.mould).find((s) => s.id === vehicle.cameras.cockpit.seat)!;
    // The perf spec's view (cockpit lab, scene leo): yaw 8 degrees right, pitch 2 up.
    const yaw = (8 * Math.PI) / 180;
    const pitch = (2 * Math.PI) / 180;
    const fwd = v3.normalize(v3.add(v3.add(v3.scale(seat.L, Math.cos(pitch) * Math.cos(yaw)), v3.scale(seat.R, Math.cos(pitch) * Math.sin(yaw))), v3.scale(seat.U, Math.sin(pitch))));
    // Assemblies by their family (the part of the name before the first ':').
    const family = (v: number): string => mesh.groupNames[mesh.vertexGroup[v]!]!.split(':')[0]!;
    const r = mesh.ranges.lod0!;
    const stats = viewStats(positions, mesh.indices, r.start, r.count, family, seat.eye, fwd, seat.U);
    const rows = [...stats.entries()].sort((a, b) => b[1].triangles - a[1].triangles);
    const total: ViewStats = { triangles: 0, inView: 0, bins: [0, 0, 0, 0, 0], area: 0 };
    for (const [name, s] of rows) {
      total.triangles += s.triangles;
      total.inView += s.inView;
      total.area += s.area;
      s.bins.forEach((n, i) => (total.bins[i]! += n));
      console.log(`${name.padEnd(16)} ${String(s.triangles).padStart(7)} tris, in view ${String(s.inView).padStart(7)}: <1px ${s.bins[0]}, 1-4 ${s.bins[1]}, 4-16 ${s.bins[2]}, 16-64 ${s.bins[3]}, >64 ${s.bins[4]}; area ${(s.area / 1e6).toFixed(2)} Mpx`);
    }
    console.log(`${'TOTAL'.padEnd(16)} ${String(total.triangles).padStart(7)} tris, in view ${String(total.inView).padStart(7)}: <1px ${total.bins[0]}, 1-4 ${total.bins[1]}, 4-16 ${total.bins[2]}, 16-64 ${total.bins[3]}, >64 ${total.bins[4]}; area ${(total.area / 1e6).toFixed(2)} Mpx of ${((WIDTH * HEIGHT) / 1e6).toFixed(2)}`);
    // The brief's budget for the full detail level.
    expect(model.triangles.lod0 + mesh.ranges.labels!.count / 3).toBeLessThan(400_000);
  });
});

describe('cockpit triangle edges', () => {
  it('every vertex states the longest triangle edge that ends at it (the bound the sun gate is built on); no label is larger than the reach assumed for labels', async () => {
    const model = await testModel();
    const mesh = model.mesh;
    const f32 = new Float32Array(mesh.vertices);
    const u16 = new Uint16Array(mesh.vertices);
    const u8 = new Uint8Array(mesh.vertices);
    const at = (i: number): [number, number, number] => [f32[(i * VERTEX_STRIDE) / 4]!, f32[(i * VERTEX_STRIDE) / 4 + 1]!, f32[(i * VERTEX_STRIDE) / 4 + 2]!];
    const isLabel = (i: number): boolean => (u8[i * VERTEX_STRIDE + 42]! & FLAG_LABEL) !== 0;
    const reach = (i: number): number => (u16[(i * VERTEX_STRIDE + 36) / 2]! / 65535) * EDGE_REACH_MAX;
    let longest = 0;
    let checked = 0;
    for (const name of ['lod0', 'labels', 'lod1', 'lod2']) {
      const r = mesh.ranges[name]!;
      for (let k = r.start; k < r.start + r.count; k += 3) {
        for (let e = 0; e < 3; e++) {
          const ia = mesh.indices[k + e]!;
          const ib = mesh.indices[k + ((e + 1) % 3)]!;
          const a = at(ia);
          const b = at(ib);
          const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          longest = Math.max(longest, len);
          for (const v of [ia, ib]) {
            if (isLabel(v)) expect(len).toBeLessThanOrEqual(LABEL_REACH);
            else expect(reach(v)).toBeGreaterThanOrEqual(Math.min(len, EDGE_REACH_MAX) - 1e-5);
          }
          checked++;
        }
      }
    }
    console.log();
    expect(checked).toBeGreaterThan(500_000);
    expect(longest).toBeLessThan(EDGE_REACH_MAX);
  });
});
