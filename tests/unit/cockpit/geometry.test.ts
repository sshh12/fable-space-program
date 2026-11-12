/**
 * Geometry acceptance of the cockpit interior, against the SHARED mould-line file (no literals):
 *  - no interior vertex outside the mould line minus the wall thickness (every detail level);
 *  - window frames and the hatch line up with the shared openings within 2 mm;
 *  - the couches sit at the shared seat eye points;
 *  - the commander's eye sees through the left forward window and all three displays unobstructed;
 *  - the display quads are planar and their texture is never magnified from the seat at 1440p.
 * The opening outlines are recomputed here with plain trigonometry from the file (not with mould.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createCockpitRig } from '@/camera';
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import { getSection } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { displayVertices, type CockpitModel } from '@/render/cockpit/build';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { testDefs, testModel, vertexPosition } from './helpers';

type V = { x: number; y: number; z: number };
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: V): number => Math.sqrt(dot(a, a));
const norm = (a: V): V => scale(a, 1 / len(a));

let model: CockpitModel;
let def: CapsuleMouldLineDef;

beforeAll(async () => {
  const defs = await testDefs();
  model = await testModel('kestrel');
  def = getSection<CapsuleMouldLineDef>(defs, model.layout.mouldLine);
});

/** Distance from a point to the profile polyline in the (radius, y) half-plane, negative outside the shape. */
function signedDistance(p: V): number {
  const r = Math.hypot(p.x, p.z);
  let best = Infinity;
  const pr = def.profile;
  for (let i = 0; i + 1 < pr.length; i++) {
    const [ax, ay] = pr[i]!;
    const [bx, by] = pr[i + 1]!;
    const t = Math.max(0, Math.min(1, ((r - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    best = Math.min(best, Math.hypot(r - (ax + (bx - ax) * t), p.y - (ay + (by - ay) * t)));
  }
  // Inside the closed profile (closed along the axis): crossing test.
  const poly = [...pr, [0, pr[pr.length - 1]![1]] as [number, number]];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p.y !== yj > p.y && r < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? best : -best;
}

/** Outline of a shared opening on the INNER wall: (u along the circle, v along the generator), offset along the normal. */
function sharedInnerOutline(azDeg: number, y: number, w: number, h: number, rc: number, n: number): V[] {
  const r0 = def.heatShield.maxDiameter / 2;
  const dr = def.cone.radiusTop - r0;
  const dy = def.cone.yTop - def.cone.yBottom;
  const L = Math.hypot(dr, dy);
  const gr = dr / L;
  const gy = dy / L;
  const rAt = (yy: number): number => r0 + (dr / dy) * (yy - def.cone.yBottom);
  const pts: V[] = [];
  for (let i = 0; i < n; i++) {
    // Rounded rectangle by angle: the boundary point in direction phi.
    const phi = (i / n) * 2 * Math.PI;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    let lo = 0;
    let hi = Math.max(w, h);
    const insideRR = (u: number, v: number): boolean => {
      const qx = Math.abs(u) - (w / 2 - rc);
      const qy = Math.abs(v) - (h / 2 - rc);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc <= 0;
    };
    for (let k = 0; k < 50; k++) {
      const m = (lo + hi) / 2;
      if (insideRR(c * m, s * m)) lo = m;
      else hi = m;
    }
    const u = c * lo;
    const v = s * lo;
    const rr = rAt(y) + v * gr;
    const yy = y + v * gy;
    const az = (azDeg * Math.PI) / 180 + u / rr;
    const outer = { x: rr * Math.sin(az), y: yy, z: rr * Math.cos(az) };
    const normal = { x: Math.sin(az) * gy, y: -gr, z: Math.cos(az) * gy };
    pts.push(sub(outer, scale(normal, def.wallThickness)));
  }
  return pts;
}

/** Distance from a point to a triangle. */
function pointTriangle(p: V, [a, b, c]: [V, V, V]): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-20) return Math.min(len(sub(p, a)), len(sub(p, b)), len(sub(p, c)));
  // Barycentric projection; fall back to the edges when the projection is outside.
  const ap = sub(p, a);
  const w1 = dot(cross(ap, ac), n) / nn;
  const w2 = dot(cross(ab, ap), n) / nn;
  if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) return Math.abs(dot(ap, n)) / Math.sqrt(nn);
  const seg = (s: V, e: V): number => {
    const d = sub(e, s);
    const t = Math.max(0, Math.min(1, dot(sub(p, s), d) / Math.max(dot(d, d), 1e-20)));
    return len(sub(p, add(s, scale(d, t))));
  };
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}

function positionsOf(range: string, filter?: (mat: string) => boolean): V[] {
  const r = model.mesh.ranges[range]!;
  const seen = new Set<number>();
  const view = new Uint8Array(model.mesh.vertices);
  const out: V[] = [];
  for (let i = r.start; i < r.start + r.count; i++) {
    const k = model.mesh.indices[i]!;
    if (seen.has(k)) continue;
    seen.add(k);
    if (filter && !filter(model.materialNames[view[k * 48 + 40]!]!)) continue;
    out.push(vertexPosition(model, k));
  }
  return out;
}

describe('cockpit interior geometry (shared mould line)', () => {
  it('builds every detail level within the triangle budget', () => {
    expect(model.triangles.lod0).toBeGreaterThan(50_000);
    expect(model.triangles.lod0).toBeLessThanOrEqual(420_000);
    expect(model.triangles.lod1).toBeLessThan(model.triangles.lod0 * 0.4);
    expect(model.triangles.lod2).toBeLessThan(model.triangles.lod1);
  });

  it('has no vertex outside the mould line minus the wall thickness', () => {
    for (const range of ['lod0', 'lod1', 'lod2']) {
      let worst = Infinity;
      for (const p of positionsOf(range)) worst = Math.min(worst, signedDistance(p) - def.wallThickness);
      // Float32 positions: allow 0.1 mm.
      expect(worst, `${range}: deepest vertex into the wall (m)`).toBeGreaterThanOrEqual(-1e-4);
    }
  });

  it('lines the window frames and the hatch up with the shared openings within 2 mm', () => {
    // Window and hatch-window frames are the bezels; the hatch frame starts with its seal ring.
    const tris = (mat: string): [V, V, V][] => {
      const r = model.mesh.ranges.lod0!;
      const view = new Uint8Array(model.mesh.vertices);
      const out: [V, V, V][] = [];
      for (let i = r.start; i < r.start + r.count; i += 3) {
        const k = model.mesh.indices[i]!;
        if (model.materialNames[view[k * 48 + 40]!] !== mat) continue;
        out.push([vertexPosition(model, k), vertexPosition(model, model.mesh.indices[i + 1]!), vertexPosition(model, model.mesh.indices[i + 2]!)]);
      }
      return out;
    };
    const bezel = tris('bezel');
    const seal = tris('rubber');
    const openings = [
      ...def.windows.map((w) => ({ id: w.id, az: w.azimuthDeg, y: w.y, w: w.width, h: w.height, rc: w.shape === 'round' ? w.width / 2 : w.cornerRadius, set: bezel })),
      { id: 'hatch', az: def.hatch.azimuthDeg, y: def.hatch.y, w: def.hatch.width, h: def.hatch.height, rc: def.hatch.cornerRadius, set: seal },
      { id: 'hatch-window', az: def.hatch.azimuthDeg, y: def.hatch.y, w: 2 * def.hatch.window.radius, h: 2 * def.hatch.window.radius, rc: def.hatch.window.radius, set: bezel },
    ];
    for (const o of openings) {
      // (a) every point of the shared outline lies on the frame surface (within 2 mm);
      let worst = 0;
      const outline = sharedInnerOutline(o.az, o.y, o.w, o.h, o.rc, 48);
      for (const p of outline) worst = Math.max(worst, o.set.reduce((d, tri) => Math.min(d, pointTriangle(p, tri)), Infinity));
      expect(worst, `${o.id}: largest distance from the shared outline to the frame (m)`).toBeLessThan(0.002);
      // (b) the frame does not narrow the opening: frame vertices on the wall stay outside the outline shrunk by 2 mm.
      const inner = sharedInnerOutline(o.az, o.y, o.w - 0.004, o.h - 0.004, Math.max(0, o.rc - 0.002), 96);
      const centre = inner.reduce((s, p) => add(s, scale(p, 1 / inner.length)), { x: 0, y: 0, z: 0 });
      const nrm = norm(cross(sub(inner[24]!, inner[0]!), sub(inner[48]!, inner[0]!)));
      const u = norm(sub(inner[0]!, centre));
      const vv = cross(nrm, u);
      const poly = inner.map((p) => [dot(sub(p, centre), u), dot(sub(p, centre), vv)] as [number, number]);
      let intrusions = 0;
      for (const tri of o.set) {
        for (const p of tri) {
          const rel = sub(p, centre);
          if (Math.abs(dot(rel, nrm)) > 0.01 || len(rel) > Math.max(o.w, o.h)) continue;
          // The hatch's own window (with its gaskets) is inside the hatch opening by design.
          if (o.id === 'hatch' && len(rel) < def.hatch.window.radius + 0.05) continue;
          const x = dot(rel, u);
          const y = dot(rel, vv);
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i]!;
            const [xj, yj] = poly[j]!;
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
          }
          if (inside) intrusions++;
        }
      }
      if (o.id !== 'hatch-window') expect(intrusions, `${o.id}: frame vertices inside the opening`).toBe(0);
    }
  });

  it('sits the couches at the shared seat eye points', () => {
    expect(model.couches.map((c) => c.seat).sort()).toEqual(def.seats.map((s) => s.id).sort());
    for (const c of model.couches) {
      const seat = def.seats.find((s) => s.id === c.seat)!;
      const eye = { x: seat.pos[0], y: seat.pos[1], z: seat.pos[2] };
      const look = norm({ x: seat.lookDir[0], y: seat.lookDir[1], z: seat.lookDir[2] });
      // The back cushion faces the look direction, centred on the seat's lateral position, behind the eye.
      expect(dot(norm(c.backNormal), look)).toBeGreaterThan(0.999);
      expect(Math.abs(c.backCentre.x - eye.x)).toBeLessThan(0.001);
      const behind = dot(sub(eye, c.backCentre), look);
      expect(behind).toBeGreaterThan(0.04);
      expect(behind).toBeLessThan(0.16);
      // The head cushion is under the head: within 12 cm of the eye, behind it along the look direction.
      expect(len(sub(c.headrest, eye))).toBeLessThan(0.12);
      expect(dot(sub(c.headrest, eye), look)).toBeLessThan(0);
    }
  });

  // The commander (the brief's criterion) through the left forward window; the pilot's centre couch, which is
  // the vehicle's cockpit seat and so the player's eye (request cockpit-18), through both forward windows.
  it.each([
    ['cdr', ['fwd-left']],
    ['plt', ['fwd-left', 'fwd-right']],
  ] as [string, string[]][])('gives the %s couch an unobstructed line of sight through its forward windows and to all three displays', (seatId, windowIds) => {
    const cdr = def.seats.find((s) => s.id === seatId)!;
    const eye = { x: cdr.pos[0], y: cdr.pos[1], z: cdr.pos[2] };
    // Targets: each window's centre on the OUTER mould line (through the whole wall) and points around it on
    // the inner wall, and the centre and corners of each display screen.
    const targets: { name: string; p: V }[] = [];
    for (const wid of windowIds) {
      const fwdLeft = def.windows.find((w) => w.id === wid)!;
      const r0 = def.heatShield.maxDiameter / 2;
      const rOut = r0 + ((def.cone.radiusTop - r0) / (def.cone.yTop - def.cone.yBottom)) * (fwdLeft.y - def.cone.yBottom);
      const az = (fwdLeft.azimuthDeg * Math.PI) / 180;
      const winOuter = { x: rOut * Math.sin(az), y: fwdLeft.y, z: rOut * Math.cos(az) };
      const inner = sharedInnerOutline(fwdLeft.azimuthDeg, fwdLeft.y, fwdLeft.width * 0.6, fwdLeft.height * 0.6, 0, 8);
      targets.push({ name: `${wid} (outer centre)`, p: winOuter }, ...inner.map((p, i) => ({ name: `${wid} inner ${i}`, p })));
    }
    for (const d of model.displays) {
      const f = d.frame;
      const at = (a: number, b: number): V => add(f.o, add(scale(f.x, a), scale(f.y, b)));
      targets.push({ name: `display ${d.index} centre`, p: f.o });
      for (const [a, b] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) targets.push({ name: `display ${d.index} (${a},${b})`, p: at(a! * d.width, b! * d.height) });
    }
    const idx = model.mesh.indices;
    const r = model.mesh.ranges.lod0!;
    const P = (k: number): V => vertexPosition(model, k);
    for (const t of targets) {
      const dir = sub(t.p, eye);
      const dist = len(dir);
      const d = scale(dir, 1 / dist);
      let blocked = '';
      for (let i = r.start; i < r.start + r.count && !blocked; i += 3) {
        const a = P(idx[i]!);
        const e1 = sub(P(idx[i + 1]!), a);
        const e2 = sub(P(idx[i + 2]!), a);
        const pv = cross(d, e2);
        const det = dot(e1, pv);
        if (Math.abs(det) < 1e-12) continue;
        const tv = sub(eye, a);
        const u = dot(tv, pv) / det;
        if (u < 0 || u > 1) continue;
        const qv = cross(tv, e1);
        const v = dot(d, qv) / det;
        if (v < 0 || u + v > 1) continue;
        const tt = dot(e2, qv) / det;
        // Hits closer than the target by more than 1 mm block the view (the screen itself is not in this mesh).
        if (tt > 0.02 && tt < dist - 0.001) blocked = `triangle ${i / 3} at ${tt.toFixed(3)} m`;
      }
      expect(blocked, `line of sight to ${t.name}`).toBe('');
    }
  });

  it('keeps the display quads planar and never magnifies their images from the seat at 1440p', async () => {
    const cdr = def.seats.find((s) => s.id === 'cdr')!;
    const eye = { x: cdr.pos[0], y: cdr.pos[1], z: cdr.pos[2] };
    // The field of view the app's cockpit camera starts with (src/camera), not a literal.
    const fovY = await cockpitCameraFov();
    const pxPerRad = 1440 / 2 / Math.tan(fovY / 2);
    const { width: texW, height: texH } = model.layout.displays;
    // The vertices the display pipeline actually draws (displayVertices): 6 per display, 9 floats each.
    const dv = displayVertices(model);
    expect(dv.length).toBe(model.displays.length * 6 * 9);
    for (const d of model.displays) {
      const pts: V[] = [];
      for (let k = 0; k < 6; k++) {
        const o = (d.index * 6 + k) * 9;
        expect(dv[o + 8]).toBe(d.index);
        pts.push({ x: dv[o]!, y: dv[o + 1]!, z: dv[o + 2]! });
      }
      // Planar: every emitted vertex lies in the plane of the first three (within 1 micrometre).
      const n = norm(cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!)));
      for (const p of pts) expect(Math.abs(dot(sub(p, pts[0]!), n)), `display ${d.index} vertex off its plane`).toBeLessThan(1e-6);
      // The two triangles cover the active area: their summed area equals width x height.
      const area = (a: V, b: V, c: V): number => len(cross(sub(b, a), sub(c, a))) / 2;
      expect(area(pts[0]!, pts[1]!, pts[2]!) + area(pts[3]!, pts[4]!, pts[5]!)).toBeCloseTo(d.width * d.height, 6);
      // Texels per screen pixel along both axes at the screen's centre.
      const centre = scale(pts.reduce((s, p) => add(s, p), { x: 0, y: 0, z: 0 }), 1 / 6);
      const dist = len(sub(centre, eye));
      const cosv = Math.abs(dot(norm(sub(eye, centre)), n));
      const pxW = (d.width / dist) * pxPerRad;
      const pxH = ((d.height * cosv) / dist) * pxPerRad;
      const texelsPerPx = Math.min(texW / pxW, texH / pxH);
      expect(texelsPerPx, `display ${d.index}: texels per screen pixel`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('prints every label right-reading from the side it faces', () => {
    // For each label triangle: the directions in which the atlas u grows (text runs right) and v grows
    // (text runs down) must form, with the face normal, a right-handed reading frame seen from the front.
    const f32 = new Float32Array(model.mesh.vertices);
    const i16 = new Int16Array(model.mesh.vertices);
    const u16 = new Uint16Array(model.mesh.vertices);
    const u8 = new Uint8Array(model.mesh.vertices);
    const idx = model.mesh.indices;
    let labels = 0;
    // Decal labels and the lamp legends (lens faces, in the full detail level).
    const tris: number[] = [];
    for (const r of [model.mesh.ranges.labels!, model.mesh.ranges.lod0!]) for (let i = r.start; i < r.start + r.count; i += 3) tris.push(i);
    for (const i of tris) {
      const tri = [idx[i]!, idx[i + 1]!, idx[i + 2]!];
      if ((u8[tri[0]! * 48 + 42]! & 1) === 0) continue;
      const P = tri.map((k) => ({ x: f32[k * 12]!, y: f32[k * 12 + 1]!, z: f32[k * 12 + 2]! }));
      const UV = tri.map((k) => [u16[k * 24 + 18]! / 65535, u16[k * 24 + 19]! / 65535] as const);
      const N = norm({ x: i16[tri[0]! * 24 + 6]!, y: i16[tri[0]! * 24 + 7]!, z: i16[tri[0]! * 24 + 8]! });
      // Solve for the 3-D gradients of u and v over the triangle.
      const e1 = sub(P[1]!, P[0]!);
      const e2 = sub(P[2]!, P[0]!);
      const du1 = UV[1]![0] - UV[0]![0];
      const dv1 = UV[1]![1] - UV[0]![1];
      const du2 = UV[2]![0] - UV[0]![0];
      const dv2 = UV[2]![1] - UV[0]![1];
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-12) continue;
      // Positions along increasing u and increasing v (inverse of the uv Jacobian).
      const dPdu = scale(sub(scale(e1, dv2), scale(e2, dv1)), 1 / det);
      const dPdv = scale(sub(scale(e2, du1), scale(e1, du2)), 1 / det);
      // Atlas v grows downwards on the text: up = -dPdv. Right x up must point out of the face (along N).
      const handed = dot(cross(dPdu, scale(dPdv, -1)), N);
      expect(handed, `label triangle ${i / 3} reads mirrored`).toBeGreaterThan(0);
      labels++;
    }
    expect(labels).toBeGreaterThan(200);
  });
});

/** The vertical field of view the app's cockpit camera rig starts with. */
async function cockpitCameraFov(): Promise<number> {
  const defs = await testDefs();
  const vehicleId = Object.values(defs.vehicles).find((v) => v.cockpit)!.id;
  const sim = createFakeSim(defs, { scene: 'lowOrbit', parts: vesselPartSnapshots(assembleVessel(defs, vehicleId, { stagesAlreadyFired: 4 })) });
  const raw = sim.snapshot();
  const s = { ...raw, vessels: raw.vessels.map((v) => (v.id === raw.activeVesselId ? { ...v, vehicleId } : v)) };
  const rig = createCockpitRig({ defs });
  rig.activate(null, s);
  return rig.update(s, { yaw: 0, pitch: 0, zoom: 1 }, 0).fovY;
}
