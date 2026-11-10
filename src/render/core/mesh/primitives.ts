/**
 * Procedural MeshData builders (right-handed, counter-clockwise front faces, metres) for labs, tests and
 * simple props. Every builder fills normals, tangents (xyz + handedness) and uvs.
 */
import type { MeshData } from '@/core/contracts/render';
import type { Vec3Tuple } from '@/core/math';

class Builder {
  p: number[] = [];
  n: number[] = [];
  t: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vertex(pos: Vec3Tuple, nrm: Vec3Tuple, tan: Vec3Tuple, u: number, v: number): number {
    this.p.push(...pos);
    this.n.push(...nrm);
    this.t.push(...tan, 1);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  build(material = 0): MeshData {
    const positions = new Float32Array(this.p);
    const min: Vec3Tuple = [Infinity, Infinity, Infinity];
    const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, positions[i + k]!);
        max[k] = Math.max(max[k]!, positions[i + k]!);
      }
    }
    return {
      positions,
      normals: new Float32Array(this.n),
      tangents: new Float32Array(this.t),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
      groups: [{ material, start: 0, count: this.idx.length }],
      bounds: { min, max },
    };
  }
}

/** Axis-aligned box centred on the origin with the given full extents. */
export function boxMesh(sx: number, sy: number, sz: number): MeshData {
  const b = new Builder();
  const h = [sx / 2, sy / 2, sz / 2];
  // For each face: normal axis, sign, tangent axis (u), bitangent axis (v) with n = t x b.
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0],
  ];
  for (const [a, s, ta, ba] of faces) {
    const nrm: Vec3Tuple = [0, 0, 0];
    nrm[a] = s;
    const tan: Vec3Tuple = [0, 0, 0];
    tan[ta] = 1;
    const base = b.p.length / 3;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const) {
      const pos: Vec3Tuple = [0, 0, 0];
      pos[a] = s * h[a]!;
      pos[ta] = (u * 2 - 1) * h[ta]!;
      pos[ba] = (v * 2 - 1) * h[ba]!;
      b.vertex(pos, nrm, tan, u, v);
    }
    // t x b = n for every listed face, so the quad is counter-clockwise seen from outside.
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return b.build();
}

/** UV sphere centred on the origin, poles on +-Z. `segments` around, `rings` pole to pole. */
export function sphereMesh(radius: number, segments = 48, rings = 24): MeshData {
  const b = new Builder();
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const th = v * Math.PI;
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const ph = u * 2 * Math.PI;
      const n: Vec3Tuple = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      b.vertex([n[0] * radius, n[1] * radius, n[2] * radius], n, [-Math.sin(ph), Math.cos(ph), 0], u, v);
    }
  }
  const w = segments + 1;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * w + i;
      const c = a + w;
      if (j > 0) b.idx.push(a, c, a + 1);
      if (j < rings - 1) b.idx.push(a + 1, c, c + 1);
    }
  }
  return b.build();
}

/** Horizontal plane in XY facing +Z, centred on the origin, subdivided `segments` x `segments`. */
export function planeMesh(sizeX: number, sizeY: number, segments = 1): MeshData {
  const b = new Builder();
  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const v = j / segments;
      b.vertex([(u - 0.5) * sizeX, (v - 0.5) * sizeY, 0], [0, 0, 1], [1, 0, 0], u, v);
    }
  }
  const w = segments + 1;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * w + i;
      b.idx.push(a, a + 1, a + w + 1, a, a + w + 1, a + w);
    }
  }
  return b.build();
}

/** Closed cylinder along +Y (VES nose axis) from y = -height/2 to +height/2; tangent runs around the axis. */
export function cylinderMesh(radius: number, height: number, segments = 48): MeshData {
  const b = new Builder();
  const h = height / 2;
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const a = u * 2 * Math.PI;
    const n: Vec3Tuple = [Math.cos(a), 0, -Math.sin(a)];
    const t: Vec3Tuple = [-Math.sin(a), 0, -Math.cos(a)];
    b.vertex([n[0] * radius, -h, n[2] * radius], n, t, u, 0);
    b.vertex([n[0] * radius, h, n[2] * radius], n, t, u, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    b.idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
  }
  for (const s of [1, -1]) {
    const centre = b.vertex([0, s * h, 0], [0, s, 0], [1, 0, 0], 0.5, 0.5);
    const first = b.p.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      b.vertex([Math.cos(a) * radius, s * h, -Math.sin(a) * radius], [0, s, 0], [1, 0, 0], 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    }
    for (let i = 0; i < segments; i++) {
      if (s > 0) b.idx.push(centre, first + i, first + i + 1);
      else b.idx.push(centre, first + i + 1, first + i);
    }
  }
  return b.build();
}

/** Triangle count of a mesh. */
export const triangleCount = (m: MeshData): number => m.indices.length / 3;
