/**
 * Penetration check of a built cockpit interior (request cockpit-lead-1): no assembly of the cabin may run
 * into the pressure hull, into what lies on the hull (insulation blankets, ring frames and stringers, hard
 * close-out panels) or into another assembly. Pure: runs in vitest (tests/unit/cockpit/penetration.test.ts).
 *
 * The mesh carries an assembly name per vertex (MeshBuilder.group, BuiltMesh.vertexGroup). Assemblies are of
 * four kinds, told by their name:
 *  - `shell`: the inner pressure wall, the floor and the tunnel. Tested analytically: the signed distance of
 *    a point from the shared mould line minus the wall thickness (mould.ts insideDistance), and the floor's
 *    height;
 *  - `skin:*`: what lies ON the wall as a sheet or a section standing off it (blankets, frames, close-out
 *    panels). A point is under a skin when the ray from it along the wall's inward normal meets the skin
 *    within its height: the space between a skin and the wall is taken, whether the skin is a closed solid
 *    (a pillow against the wall) or an open section (a T frame);
 *  - `mount:*`: brackets, stand-offs, straps' wall ends, clamps and seals: hardware whose job is to reach
 *    through the insulation to the structure or to press against a neighbour. Never tested, never a target;
 *  - every other name: a solid. A point is inside a solid when, in nearly every one of fourteen directions,
 *    the first surface of that solid the ray meets is seen from behind (it is leaving the solid). The
 *    orientation of a surface is its vertex normal's (the builder's normals point out of the material),
 *    whatever the triangle's winding. Depth: the distance to the nearest such surface.
 *
 * Sample points: every vertex of the full detail level (labels are paint: skipped), plus the centroid and
 * the edge mid-points of every triangle with an edge longer than 3 cm. Thin overlays (webbing, fastener
 * heads, hook-and-loop) are sampled but are no targets: they occupy no space of their own.
 *
 * Webbing and the other soft overlays against the hardware of their OWN assembly (round 6: a harness
 * adjuster stood through the shoulder strap it is threaded on): every sample of a thin overlay, and the
 * centre and edge mid-points of each of its triangles whatever their size, is also tested against the solid
 * parts of its own assembly, with a tolerance of its own (overlayTolerance, default 0.8 mm: the fittings are
 * a few millimetres thick). Reported with `into` = the assembly's name + ' (own hardware)'.
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import { v3, type Vec3 } from '@/core/math';
import { buildBvh, bvhRay, type Bvh } from './bvh';
import { FLAG_LABEL, VERTEX_STRIDE, type BuiltMesh } from './mesh';
import { coneNormal, insideDistance, mouldOf, radialDir } from './mould';

export interface Penetration {
  /** The assembly whose surface reaches into `into`. */
  group: string;
  /** 'shell' (the pressure wall, the floor), a skin or a solid assembly. */
  into: string;
  /** Deepest sample (m) and where it is (part frame). */
  depth: number;
  at: Vec3;
  /** Number of samples deeper than the tolerance. */
  samples: number;
}

export interface PenetrationOptions {
  /** Depth (m) from which a sample counts (default 3 mm). */
  tolerance?: number;
  /** Index range to test (default 'lod0'). */
  range?: string;
  /** Vertex flag of thin overlays (context.ts FLAG_OVERLAY): sampled, never a target. */
  overlayFlag?: number;
  /** Depth (m) from which a thin overlay's sample inside the hardware of its own assembly counts (default 0.8 mm). */
  overlayTolerance?: number;
}

const DIRS: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (const a of [-1, 1]) {
    out.push({ x: a, y: 0, z: 0 }, { x: 0, y: a, z: 0 }, { x: 0, y: 0, z: a });
    for (const b of [-1, 1]) for (const c of [-1, 1]) out.push(v3.normalize({ x: a, y: b, z: c }));
  }
  // A small skew, so that no direction runs exactly along the faces of axis-aligned boxes.
  return out.map((d) => v3.normalize({ x: d.x + 0.0131 * d.y - 0.0073 * d.z, y: d.y + 0.0091 * d.z - 0.0117 * d.x, z: d.z + 0.0057 * d.x - 0.0139 * d.y }));
})();
/** A point is inside a solid when at least this many of the 14 directions leave it first. */
const INSIDE_VOTES = 12;
/** Farthest a solid's far side is looked for (m): no cabin assembly is thicker. */
const SOLID_REACH = 1.2;
/** Height (m) under which a skin is looked for above a point near the wall. */
const SKIN_REACH = 0.07;

interface Group {
  name: string;
  kind: 'shell' | 'skin' | 'mount' | 'solid';
  indices: number[];
  bvh: Bvh | null;
  min: Vec3;
  max: Vec3;
  samples: Vec3[];
  /** Samples of the assembly's thin overlays (also in `samples`), denser: tested against its own solids. */
  thin: Vec3[];
}

/**
 * Per assembly (mounts included: what reaches through the insulation ends AT the wall, not in it), how far
 * its deepest vertex of an index range lies inside the pressure wall or under the floor (m; 0 or less = none).
 */
export function wallDepthByGroup(mesh: BuiltMesh, mould: CapsuleMouldLineDef, rangeName = 'lod0'): Record<string, number> {
  const range = mesh.ranges[rangeName]!;
  const f32 = new Float32Array(mesh.vertices);
  const m = mouldOf(mould);
  const out: Record<string, number> = {};
  for (let i = range.start; i < range.start + range.count; i++) {
    const v = mesh.indices[i]!;
    const name = mesh.groupNames[mesh.vertexGroup[v]!] || '(unnamed)';
    if (name === 'shell') continue;
    const p = { x: f32[(v * VERTEX_STRIDE) / 4]!, y: f32[(v * VERTEX_STRIDE) / 4 + 1]!, z: f32[(v * VERTEX_STRIDE) / 4 + 2]! };
    const depth = Math.max(m.wall - insideDistance(mould, p), m.floorY - p.y);
    if (!(name in out) || depth > out[name]!) out[name] = depth;
  }
  return out;
}

export const groupKind = (name: string): Group['kind'] => (name === 'shell' ? 'shell' : name.startsWith('skin:') ? 'skin' : name.startsWith('mount:') ? 'mount' : 'solid');

/**
 * Every pair (assembly, what it reaches into) with a sample deeper than the tolerance, deepest first.
 * `mesh.groupNames[0]` (the empty name) holds vertices built outside any named assembly: reported as the
 * solid '(unnamed)' so that nothing escapes the check.
 */
export function findPenetrations(mesh: BuiltMesh, mould: CapsuleMouldLineDef, opts: PenetrationOptions = {}): Penetration[] {
  const tol = opts.tolerance ?? 0.003;
  const thinTol = opts.overlayTolerance ?? 0.0008;
  const overlay = opts.overlayFlag ?? 64;
  const range = mesh.ranges[opts.range ?? 'lod0']!;
  const f32 = new Float32Array(mesh.vertices);
  const i16 = new Int16Array(mesh.vertices);
  const u8 = new Uint8Array(mesh.vertices);
  const pos = (v: number): Vec3 => ({ x: f32[(v * VERTEX_STRIDE) / 4]!, y: f32[(v * VERTEX_STRIDE) / 4 + 1]!, z: f32[(v * VERTEX_STRIDE) / 4 + 2]! });
  const nrm = (v: number): Vec3 => ({ x: i16[(v * VERTEX_STRIDE + 12) / 2]! / 32767, y: i16[(v * VERTEX_STRIDE + 12) / 2 + 1]! / 32767, z: i16[(v * VERTEX_STRIDE + 12) / 2 + 2]! / 32767 });
  const flags = (v: number): number => u8[v * VERTEX_STRIDE + 42]!;
  const positions = new Float32Array(mesh.vertexCount * 3);
  for (let i = 0; i < mesh.vertexCount; i++) positions.set(f32.subarray((i * VERTEX_STRIDE) / 4, (i * VERTEX_STRIDE) / 4 + 3), i * 3);

  // ---- assemblies: triangles, bounds, samples
  const groups: Group[] = mesh.groupNames.map((name) => ({
    name: name === '' ? '(unnamed)' : name,
    kind: groupKind(name),
    indices: [],
    bvh: null,
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
    samples: [],
    thin: [],
  }));
  const seen = new Uint8Array(mesh.vertexCount);
  for (let i = range.start; i < range.start + range.count; i += 3) {
    const a = mesh.indices[i]!;
    const b = mesh.indices[i + 1]!;
    const c = mesh.indices[i + 2]!;
    if ((flags(a) & FLAG_LABEL) !== 0) continue;
    const g = groups[mesh.vertexGroup[a]!]!;
    // A thin overlay (a strap's webbing, a fastener head on a face) occupies no space of its own: it is
    // sampled (the webbing must not dive into the pad it lies on) but is no target.
    const thin = (flags(a) & overlay) !== 0;
    if (!thin) g.indices.push(a, b, c);
    const P = [pos(a), pos(b), pos(c)];
    for (const [k, v] of [a, b, c].entries()) {
      const p = P[k]!;
      if (!thin) {
        g.min = { x: Math.min(g.min.x, p.x), y: Math.min(g.min.y, p.y), z: Math.min(g.min.z, p.z) };
        g.max = { x: Math.max(g.max.x, p.x), y: Math.max(g.max.y, p.y), z: Math.max(g.max.z, p.z) };
      }
      if (!seen[v]) {
        seen[v] = 1;
        g.samples.push(p);
        if (thin) g.thin.push(p);
      }
    }
    if (thin) g.thin.push(v3.scale(v3.add(v3.add(P[0]!, P[1]!), P[2]!), 1 / 3), v3.lerp(P[0]!, P[1]!, 0.5), v3.lerp(P[1]!, P[2]!, 0.5), v3.lerp(P[2]!, P[0]!, 0.5));
    const longest = Math.max(v3.dist(P[0]!, P[1]!), v3.dist(P[1]!, P[2]!), v3.dist(P[2]!, P[0]!));
    if (longest > 0.03) {
      g.samples.push(v3.scale(v3.add(v3.add(P[0]!, P[1]!), P[2]!), 1 / 3), v3.lerp(P[0]!, P[1]!, 0.5), v3.lerp(P[1]!, P[2]!, 0.5), v3.lerp(P[2]!, P[0]!, 0.5));
    }
  }
  for (const g of groups) {
    if (g.indices.length === 0 || g.kind === 'shell' || g.kind === 'mount') continue;
    // The BVH's material slot carries the triangle's first vertex: its normal orients the triangle.
    g.bvh = buildBvh(positions, Uint32Array.from(g.indices), 0, g.indices.length, (v) => v);
  }

  const m = mouldOf(mould);
  const found = new Map<string, Penetration>();
  const report = (group: string, into: string, depth: number, at: Vec3, limit = tol): void => {
    if (depth <= limit) return;
    const key = `${group}|${into}`;
    const f = found.get(key);
    if (!f) found.set(key, { group, into, depth, at, samples: 1 });
    else {
      f.samples++;
      if (depth > f.depth) {
        f.depth = depth;
        f.at = at;
      }
    }
  };
  /** Whether the nearest surface of `bvh` along d from p is seen from behind, and how far it is. */
  const leaves = (bvh: Bvh, p: Vec3, d: Vec3, reach: number): number | null => {
    const h = bvhRay(bvh, p, d, 1e-5, reach, false);
    if (!h) return null;
    const n = nrm(h.material);
    const facing = v3.dot(h.normal, n) >= 0 ? v3.dot(h.normal, d) : -v3.dot(h.normal, d);
    return facing > 0 ? h.t : null;
  };
  const solids = groups.filter((g) => g.kind === 'solid' && g.bvh);
  const skins = groups.filter((g) => g.kind === 'skin' && g.bvh);

  for (const g of groups) {
    if (g.kind === 'shell' || g.kind === 'mount') continue;
    for (const p of g.samples) {
      // ---- the pressure hull and the floor
      const dWall = insideDistance(mould, p) - m.wall;
      if (g.kind === 'solid') {
        report(g.name, 'shell', Math.max(-dWall, m.floorY - p.y), p);
        // ---- what lies on the wall
        if (dWall < SKIN_REACH) {
          const az = Math.atan2(p.x, p.z);
          const inward = p.y >= m.tunnelJoinY ? v3.neg(radialDir(az)) : v3.neg(coneNormal(m, az));
          for (const s of skins) {
            const h = bvhRay(s.bvh!, p, inward, 1e-5, SKIN_REACH, false);
            if (h) report(g.name, s.name, h.t, p);
          }
        }
      }
      // ---- the other solid assemblies
      for (const s of solids) {
        if (s === g) continue;
        if (p.x < s.min.x || p.y < s.min.y || p.z < s.min.z || p.x > s.max.x || p.y > s.max.y || p.z > s.max.z) continue;
        let votes = 0;
        let nearest = Infinity;
        for (let k = 0; k < DIRS.length; k++) {
          const t = leaves(s.bvh!, p, DIRS[k]!, SOLID_REACH);
          if (t !== null) {
            votes++;
            nearest = Math.min(nearest, t);
          } else if (k + 1 - votes > DIRS.length - INSIDE_VOTES) break;
        }
        if (votes >= INSIDE_VOTES) report(g.name, s.name, nearest, p);
      }
    }
    // ---- its own hardware, for the thin overlays (a strap through the fitting threaded on it)
    if (g.kind !== 'solid' || !g.bvh) continue;
    for (const p of g.thin) {
      if (p.x < g.min.x || p.y < g.min.y || p.z < g.min.z || p.x > g.max.x || p.y > g.max.y || p.z > g.max.z) continue;
      let votes = 0;
      let nearest = Infinity;
      for (let k = 0; k < DIRS.length; k++) {
        const t = leaves(g.bvh, p, DIRS[k]!, SOLID_REACH);
        if (t !== null) {
          votes++;
          nearest = Math.min(nearest, t);
        } else if (k + 1 - votes > DIRS.length - INSIDE_VOTES) break;
      }
      if (votes >= INSIDE_VOTES) report(g.name, `${g.name} (own hardware)`, nearest, p, thinTol);
    }
  }
  return [...found.values()].sort((a, b) => b.depth - a.depth);
}
