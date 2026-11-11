/**
 * Acceptance checks of the generated vehicle models (work package vehicle-pad):
 *  - every part definition has a visual file and a registered generator;
 *  - every mesh of every model and LOD: unit normals, orthonormal tangents, no degenerate triangles,
 *    every component declared watertight is watertight and faces outward;
 *  - the posed part agrees with PartDef.bounds within 5 %;
 *  - mated attach interfaces along the stack meet within 5 mm, with no interpenetration above 5 mm;
 *  - the capsule follows the shared mould line and cuts its openings where the shared file puts them
 *    (the file is read here; no dimension of it is repeated);
 *  - nothing under a fairing or boost cover reaches through it, and the escape system's cover stays outside
 *    the mould line of the capsule it covers;
 *  - triangle budgets of the full stack.
 */
import { shieldGlowLuminance } from '@/render/vehicle/parts/capsule';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CapsuleMouldLineDef, DefLibrary, PartDef } from '@/core/contracts/defs';
import type { PartSnapshot } from '@/core/contracts/sim';
import type { BuiltMesh } from '@/render/vehicle/geom/builder';
import { fsDefSource } from '@/core/defs/fsSource';
import { getSection, loadDefs } from '@/core/defs/loader';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { boundingCylinder, checkMesh, verticalHits, weld } from '@/render/vehicle/geom/validate';
import { generatePart, generatorIds, hasGenerator, type PartVisual } from '@/render/vehicle/parts';
import { posedPart, posedTriangles, transformGeometry, type PosedGeometry } from '@/render/vehicle/parts/assemble';
import { assembleVessel, setModuleStateForLab, vesselPartSnapshots } from '@/sim/vessel/public';

const DEG = Math.PI / 180;
let defs: DefLibrary;
const visuals = new Map<string, PartVisual>();
const visualOf = (id: string): PartVisual => {
  let v = visuals.get(id);
  if (!v) {
    v = generatePart(defs, defs.parts[id]!);
    visuals.set(id, v);
  }
  return v;
};

/** Module states of each part in the launch configuration, with the legs deployed (the pose PartDef.bounds describes). */
function referenceParts(vehicleId: string): PartSnapshot[] {
  const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId));
  for (const p of parts) p.modules.forEach((m, i) => m.type === 'legs' && setModuleStateForLab(parts, p.instanceId, i, { deploy: 1 }));
  return parts;
}

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

describe('part visuals', () => {
  it('every part definition has a visual file and a registered generator', () => {
    const ids = Object.keys(defs.parts);
    expect(ids.length).toBeGreaterThanOrEqual(25);
    for (const id of ids) {
      const def = defs.parts[id]!;
      expect(def.visual, `data/defs/visuals/parts/${id}.json`).not.toBeNull();
      expect(hasGenerator(def.visual!.generator), `generator "${def.visual!.generator}" of ${id}`).toBe(true);
      // The same file is also a section of the library.
      expect(defs.sections[`visuals/parts/${id}`]).toBeDefined();
    }
    expect(generatorIds().length).toBeGreaterThanOrEqual(12);
  });

  it('every model has three LODs that share one material list', () => {
    for (const id of Object.keys(defs.parts)) {
      for (const [name, model] of Object.entries(visualOf(id).models)) {
        expect(model.lods.length, `${id}.${name}`).toBe(3);
        for (const lod of model.lods) for (const g of lod.groups) expect(model.materials[g.material], `${id}.${name}`).toBeDefined();
        const tris = model.lods.map((l) => l.indices.length);
        expect(tris[1]!, `${id}.${name} LOD1 <= LOD0`).toBeLessThanOrEqual(tris[0]!);
        expect(tris[2]!, `${id}.${name} LOD2 <= LOD1`).toBeLessThanOrEqual(tris[1]!);
      }
    }
  });

  it('every mesh has unit normals, orthonormal tangents, no degenerate triangles and watertight solids', () => {
    let meshes = 0;
    let closed = 0;
    let flipped = 0;
    let triangles = 0;
    for (const id of Object.keys(defs.parts)) {
      for (const [name, model] of Object.entries(visualOf(id).models)) {
        model.lods.forEach((lod, i) => {
          const r = checkMesh(lod);
          const label = `${id}.${name} LOD${i}`;
          expect(r.badNormals, `${label}: normals`).toBe(0);
          expect(r.badTangents, `${label}: tangents`).toBe(0);
          expect(r.degenerate, `${label}: degenerate triangles`).toBe(0);
          expect(r.leaks, `${label}: leaks`).toEqual([]);
          expect(r.insideOut, `${label}: inside-out solids`).toEqual([]);
          // Tight pipe bends may fold a few triangles; anything more is a winding bug.
          expect(r.flipped, `${label}: triangles facing against their normals`).toBeLessThanOrEqual(Math.max(2, r.triangles * 0.004));
          meshes++;
          closed += Array.from(lod.meta.closed).filter((c) => c === 1).length;
          flipped += r.flipped;
          triangles += r.triangles;
        });
      }
    }
    console.log(`checked ${meshes} meshes, ${triangles} triangles, ${closed} watertight components, ${flipped} folded triangles`);
    expect(closed).toBeGreaterThan(3000);
  });

  it('open components are only sheets and bands, never structure', () => {
    const allowed = new Set(['band', 'frame', 'weld', 'corrugation', 'hatband', 'throat-ring', 'lip-ring', 'boot', 'sep-joint', 'clamp-band', 'strap', 'skirt-band', 'case-band', 'nozzle-band', 'core-band', 'foil', 'well', 'sleeve', 'pad-foil', 'capsule-skin', 'capsule-reveal', 'capsule-door', 'pane', 'placard', 'rime']);
    for (const id of Object.keys(defs.parts)) {
      for (const [name, model] of Object.entries(visualOf(id).models)) {
        for (const lod of model.lods) lod.meta.tags.forEach((tag, c) => lod.meta.closed[c] === 0 && expect(allowed.has(tag), `${id}.${name}: open component "${tag}"`).toBe(true));
      }
    }
  });

  it('posed parts agree with PartDef.bounds within 5 %', () => {
    const rows: string[] = [];
    for (const vehicleId of Object.keys(defs.vehicles)) {
      const seen = new Set<string>();
      for (const p of referenceParts(vehicleId)) {
        if (seen.has(p.def)) continue;
        seen.add(p.def);
        const def = defs.parts[p.def]!;
        const g = posedPart(visualOf(p.def), { def, modules: p.modules }, 0);
        const c = boundingCylinder([g]);
        const size = Math.max(def.bounds.radius, def.bounds.yMax - def.bounds.yMin);
        const tol = 0.05 * size;
        rows.push(`${p.def.padEnd(28)} r ${c.radius.toFixed(3)} / ${def.bounds.radius}   y ${c.yMin.toFixed(3)} .. ${c.yMax.toFixed(3)} / ${def.bounds.yMin} .. ${def.bounds.yMax}`);
        expect(Math.abs(c.radius - def.bounds.radius), `${p.def}: radius ${c.radius} vs ${def.bounds.radius}`).toBeLessThanOrEqual(0.05 * def.bounds.radius);
        expect(Math.abs(c.yMin - def.bounds.yMin), `${p.def}: yMin ${c.yMin} vs ${def.bounds.yMin}`).toBeLessThanOrEqual(tol);
        expect(Math.abs(c.yMax - def.bounds.yMax), `${p.def}: yMax ${c.yMax} vs ${def.bounds.yMax}`).toBeLessThanOrEqual(tol);
      }
    }
    console.log(rows.join('\n'));
  });

  it('mated attach interfaces meet within 5 mm with no interpenetration above 5 mm', () => {
    const fractions = [0.9, 0.92, 0.94, 0.96, 0.98, 0.99, 0.995];
    const azimuths = 24;
    const rows: string[] = [];
    for (const vehicle of Object.values(defs.vehicles)) {
      const parts = referenceParts(vehicle.id);
      const snap = new Map(parts.map((p) => [p.instanceId, p]));
      const geom = new Map<string, PosedGeometry>();
      const inVes = (id: string): PosedGeometry => {
        let g = geom.get(id);
        if (!g) {
          const p = snap.get(id)!;
          const def = defs.parts[p.def]!;
          const q: QuatTuple = [p.localRot.x, p.localRot.y, p.localRot.z, p.localRot.w];
          g = transformGeometry(posedPart(visualOf(p.def), { def, modules: p.modules, skip: ['glass'] }, 0), [p.localPos.x, p.localPos.y, p.localPos.z], q);
          geom.set(id, g);
        }
        return g;
      };
      let checked = 0;
      for (const pl of vehicle.parts) {
        if (!pl.parent || !pl.parentNode || !pl.node) continue;
        const parent = snap.get(pl.parent)!;
        const child = snap.get(pl.id)!;
        const pn = defs.parts[parent.def]!.attachNodes.find((n) => n.id === pl.parentNode)!;
        const cn = defs.parts[child.def]!.attachNodes.find((n) => n.id === pl.node)!;
        // The stack is upright: the node sits at parent.localPos + pn.pos and the child lies along pn.dir.
        expect(Math.abs(pn.dir[1]), `${pl.id}: node along the stack axis`).toBeCloseTo(1, 6);
        const centre: Vec3Tuple = [parent.localPos.x + pn.pos[0], parent.localPos.y + pn.pos[1], parent.localPos.z + pn.pos[2]];
        const sign = pn.dir[1];
        const R = Math.min(pn.size, cn.size) / 2;
        const gp = inVes(pl.parent);
        const gc = inVes(pl.id);
        let worstOverlap = 0;
        let best = { fraction: 0, coverage: 0, gap: Infinity };
        for (const f of fractions) {
          let both = 0;
          let maxAbsGap = 0;
          for (let a = 0; a < azimuths; a++) {
            const phi = ((a + 0.37) / azimuths) * 2 * Math.PI;
            const x = centre[0] + f * R * Math.sin(phi);
            const z = centre[2] + f * R * Math.cos(phi);
            const hp = verticalHits(gp, x, z, centre[1] - 0.35, centre[1] + 0.35).map((y) => (y - centre[1]) * sign);
            const hc = verticalHits(gc, x, z, centre[1] - 0.35, centre[1] + 0.35).map((y) => (y - centre[1]) * sign);
            if (hp.length === 0 || hc.length === 0) continue;
            const gap = Math.min(...hc) - Math.max(...hp);
            worstOverlap = Math.min(worstOverlap, gap);
            both++;
            maxAbsGap = Math.max(maxAbsGap, Math.abs(gap));
          }
          const coverage = both / azimuths;
          if (coverage >= 0.9 && maxAbsGap < best.gap) best = { fraction: f, coverage, gap: maxAbsGap };
        }
        rows.push(`${pl.parent} > ${pl.id}`.padEnd(40) + ` contact at ${best.fraction} R: gap ${(best.gap * 1000).toFixed(2)} mm, deepest overlap ${(-worstOverlap * 1000).toFixed(2)} mm`);
        expect(worstOverlap, `${pl.parent} > ${pl.id}: interpenetration`).toBeGreaterThanOrEqual(-0.005);
        expect(best.gap, `${pl.parent} > ${pl.id}: gap on the mating ring`).toBeLessThanOrEqual(0.005);
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(30);
    }
    console.log(rows.join('\n'));
  });

  it('the hold-down clamps carry the first stage at its base plane', () => {
    for (const vehicle of Object.values(defs.vehicles)) {
      const parts = referenceParts(vehicle.id);
      for (const p of parts) {
        const def = defs.parts[p.def]!;
        if (!def.modules.some((m) => m.type === 'launchClamp')) continue;
        const pl = vehicle.parts.find((x) => x.id === p.instanceId)!;
        const parent = parts.find((x) => x.instanceId === pl.parent)!;
        const g = posedPart(visualOf(p.def), { def, modules: p.modules }, 0);
        const top = boundingCylinder([g]).yMax + p.localPos.y;
        const base = parent.localPos.y + defs.parts[parent.def]!.bounds.yMin;
        expect(Math.abs(top - base), `${p.instanceId}: clamp top ${top} vs stage base ${base}`).toBeLessThanOrEqual(0.005);
      }
    }
  });

  it('nothing under a fairing or boost cover reaches through it', () => {
    let covers = 0;
    const rows: string[] = [];
    const problems: string[] = [];
    for (const vehicle of Object.values(defs.vehicles)) {
      // The launch configuration: legs stowed, everything attached.
      const parts = vesselPartSnapshots(assembleVessel(defs, vehicle.id));
      const inVes = (p: PartSnapshot): PosedGeometry => {
        const def = defs.parts[p.def]!;
        return transformGeometry(posedPart(visualOf(p.def), { def, modules: p.modules }, 0), [p.localPos.x, p.localPos.y, p.localPos.z], [p.localRot.x, p.localRot.y, p.localRot.z, p.localRot.w]);
      };
      for (const cover of parts) {
        const def = defs.parts[cover.def]!;
        const fairing = def.modules.find((m) => m.type === 'fairing');
        if (!fairing || fairing.type !== 'fairing') continue;
        const shielded = parts.filter((q) => q !== cover && (fairing.shields.includes(q.instanceId) || fairing.shields.includes(q.def)));
        if (shielded.length === 0) continue;
        covers++;
        // Inner envelope of the cover: the smallest radius of its wall, frames and fittings in every centimetre of
        // height (plates across the axis are not part of the wall). Heights without a vertex ring lie on a
        // straight piece of wall between two rings.
        const g = inVes(cover);
        const axisX = cover.localPos.x;
        const axisZ = cover.localPos.z;
        const env = new Map<number, number>();
        for (let i = 0; i < g.positions.length; i += 3) {
          const r = Math.hypot(g.positions[i]! - axisX, g.positions[i + 2]! - axisZ);
          if (r < 0.3 * def.bounds.radius) continue;
          const k = Math.round(g.positions[i + 1]! * 100);
          if (r < (env.get(k) ?? Infinity)) env.set(k, r);
        }
        const keys = [...env.keys()].sort((a, c) => a - c);
        const inner = (y: number): number | null => {
          const k = Math.round(y * 100);
          if (k <= keys[0]! || k >= keys[keys.length - 1]!) return null;
          let lo = keys[0]!;
          let hi = keys[keys.length - 1]!;
          for (const q of keys) {
            if (q <= k && q > lo) lo = q;
            if (q >= k && q < hi) hi = q;
          }
          // Within a centimetre of a ring: the ring itself and its neighbours; otherwise the wall between two rings.
          const a = env.get(lo)!;
          const c = env.get(hi)!;
          return hi === lo ? a : Math.min(a + ((c - a) * (k - lo)) / (hi - lo), k - lo <= 1 ? a : Infinity, hi - k <= 1 ? c : Infinity);
        };
        for (const q of shielded) {
          const s = inVes(q);
          let worst = Infinity;
          let at = '';
          let checked = 0;
          for (let i = 0; i < s.positions.length; i += 3) {
            const y = s.positions[i + 1]!;
            const lim = inner(y);
            if (lim === null) continue;
            const r = Math.hypot(s.positions[i]! - axisX, s.positions[i + 2]! - axisZ);
            checked++;
            if (lim - r < worst) {
              worst = lim - r;
              at = `r ${r.toFixed(3)} at y ${y.toFixed(3)} under ${lim.toFixed(3)}`;
            }
          }
          rows.push(`${cover.instanceId} over ${q.instanceId}: ${checked} vertices, least clearance ${(worst * 1000).toFixed(1)} mm (${at})`);
          if (checked < 100) problems.push(`${cover.instanceId} over ${q.instanceId}: only ${checked} vertices under the cover`);
          if (worst < 0.003) problems.push(`${q.instanceId} reaches through ${cover.instanceId}: ${at}`);
        }
      }
    }
    console.log(rows.join('\n'));
    expect(problems).toEqual([]);
    expect(covers).toBeGreaterThanOrEqual(1);
  });

  it('triangle budgets: full stack LOD0 between 1.0 and 1.6 million, LOD2 under 60 k', () => {
    for (const vehicleId of Object.keys(defs.vehicles)) {
      const totals = [0, 0, 0];
      for (const p of vesselPartSnapshots(assembleVessel(defs, vehicleId))) {
        const def = defs.parts[p.def]!;
        for (let lod = 0; lod < 3; lod++) totals[lod] = totals[lod]! + posedTriangles(visualOf(p.def), { def, modules: p.modules }, lod);
      }
      console.log(`${vehicleId}: LOD0 ${totals[0]}, LOD1 ${totals[1]}, LOD2 ${totals[2]} triangles`);
      expect(totals[0]!).toBeGreaterThanOrEqual(1.0e6);
      expect(totals[0]!).toBeLessThanOrEqual(1.6e6);
      expect(totals[2]!).toBeLessThan(60_000);
      expect(totals[1]!).toBeLessThan(totals[0]! * 0.4);
    }
  });

  it('fairing petals follow the debris convention: petal k covers [k, k + 1) * 360 / N degrees from +Z toward +X', () => {
    for (const def of Object.values(defs.parts)) {
      const fairing = def.modules.find((m) => m.type === 'fairing');
      if (!fairing || fairing.type !== 'fairing' || fairing.panels < 2) continue;
      const modules = [{ type: 'fairing' as const, jettisoned: true }];
      const whole = posedTriangles(visualOf(def.id), { def, modules: [{ type: 'fairing', jettisoned: false }] }, 0);
      let sum = 0;
      for (let k = 0; k < fairing.panels; k++) {
        const g = posedPart(visualOf(def.id), { def, modules, panel: k }, 0);
        sum += g.indices.length / 3;
        const lo = (k * 360) / fairing.panels;
        const hi = ((k + 1) * 360) / fairing.panels;
        for (let i = 0; i < g.positions.length; i += 3) {
          const r = Math.hypot(g.positions[i]!, g.positions[i + 2]!);
          if (r < 1) continue;
          const az = Math.atan2(g.positions[i]!, g.positions[i + 2]!) / DEG;
          // Angle from the middle of the sector, wrapped: every vertex (ribs and fittings too) lies inside its own sector.
          let off = az - (lo + hi) / 2;
          off -= 360 * Math.round(off / 360);
          expect(Math.abs(off), `panel ${k} vertex at azimuth ${az.toFixed(3)}`).toBeLessThanOrEqual((hi - lo) / 2 + 1e-3);
        }
      }
      expect(sum).toBe(whole);
    }
  });
});

// --------------------------------------------------------------------------------------------- capsule

/** Signed distance to a rounded rectangle (negative inside). */
function roundRectSdf(a: number, b: number, hw: number, hh: number, rho: number): number {
  const qx = Math.abs(a) - (hw - rho);
  const qy = Math.abs(b) - (hh - rho);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rho;
}

function distToSegment(r: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((r - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(r - a[0] - dx * t, y - a[1] - dy * t);
}

/**
 * The heat shield and the back shell of a capsule as one mesh: they are two models (the shield is drawn at its
 * own temperature) whose rims meet vertex for vertex.
 */
function capsuleShell(visual: PartVisual, lod = 0): Pick<BuiltMesh, 'positions' | 'indices' | 'meta'> {
  const meshes = ['shield', 'body'].map((name) => visual.models[name]!.lods[lod]!);
  const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0));
  const triComponent = new Uint16Array(indices.length / 3);
  const tags: string[] = [];
  const closed: number[] = [];
  let vp = 0;
  let ip = 0;
  for (const m of meshes) {
    positions.set(m.positions, vp * 3);
    for (let k = 0; k < m.indices.length; k++) indices[ip + k] = m.indices[k]! + vp;
    for (let t = 0; t < m.indices.length / 3; t++) triComponent[ip / 3 + t] = m.meta.triComponent[t]! + tags.length;
    tags.push(...m.meta.tags);
    closed.push(...m.meta.closed);
    vp += m.positions.length / 3;
    ip += m.indices.length;
  }
  return { positions, indices, meta: { triComponent, tags, closed: Uint8Array.from(closed) } };
}

describe('capsule exterior and the shared mould line', () => {
  const capsules = (): { def: PartDef; ml: CapsuleMouldLineDef }[] =>
    Object.values(defs.parts)
      .filter((d) => d.visual?.generator === 'capsule.mouldline')
      .map((def) => ({ def, ml: getSection<CapsuleMouldLineDef>(defs, String(def.visual!.params['mouldLine'])) }));

  /** Opening frames built from the file here, independently of the generator. */
  const frames = (ml: CapsuleMouldLineDef) => {
    const rB = ml.heatShield.maxDiameter / 2;
    const k = (rB - ml.cone.radiusTop) / (ml.cone.yTop - ml.cone.yBottom);
    const n = Math.hypot(1, k);
    const make = (id: string, azDeg: number, y: number, w: number, h: number, rho: number) => {
      const phi = azDeg * DEG;
      const er = [Math.sin(phi), 0, Math.cos(phi)];
      const r = rB - k * (y - ml.cone.yBottom);
      return { id, hw: w / 2, hh: h / 2, rho, C: [r * er[0]!, y, r * er[2]!], T: [Math.cos(phi), 0, -Math.sin(phi)], S: [(-k * er[0]!) / n, 1 / n, (-k * er[2]!) / n], N: [er[0]! / n, k / n, er[2]! / n] };
    };
    return [
      ...ml.windows.map((w) => make(w.id, w.azimuthDeg, w.y, w.width, w.shape === 'round' ? w.width : w.height, w.shape === 'round' ? w.width / 2 : w.cornerRadius)),
      make('hatch', ml.hatch.azimuthDeg, ml.hatch.y, ml.hatch.width, ml.hatch.height, ml.hatch.cornerRadius),
    ];
  };

  it('the outer surface follows the shared profile within 2 mm', () => {
    const list = capsules();
    expect(list.length).toBeGreaterThan(0);
    for (const { def, ml } of list) {
      const mesh = capsuleShell(visualOf(def.id));
      const R = ml.heatShield.radiusOfCurvature;
      const centreY = ml.heatShield.apexY + R;
      const shield = ml.profile.filter((p) => p[1] <= ml.heatShield.maxDiameterY + 1e-9);
      // The file's own sphere describes the dome as far as its sample points lie on it (2 mm).
      let onSphere = 0;
      for (const [r, y] of shield) {
        if (Math.abs(Math.hypot(r, y - centreY) - R) <= 0.002) onSphere = r;
        else break;
      }
      const shoulder = shield.filter((p) => p[0] >= onSphere - 1e-9);
      const shell = ml.profile.filter((p) => p[1] >= ml.heatShield.maxDiameterY - 1e-9);
      const polyDist = (r: number, y: number, pts: [number, number][]): number => {
        let d = Infinity;
        for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(r, y, pts[i]!, pts[i + 1]!));
        return d;
      };
      const P = mesh.positions;
      let worst = 0;
      let worstPolyline = 0;
      let checked = 0;
      const seen = new Uint8Array(P.length / 3);
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        const tag = mesh.meta.tags[mesh.meta.triComponent[t]!]!;
        if (tag !== 'capsule-skin' && tag !== 'capsule-door') continue;
        for (let c = 0; c < 3; c++) {
          const v = mesh.indices[t * 3 + c]!;
          if (seen[v]) continue;
          seen[v] = 1;
          const r = Math.hypot(P[v * 3]!, P[v * 3 + 2]!);
          const y = P[v * 3 + 1]!;
          // Inside the parachute bay (the rim and deck under the apex cover) there is no mould line.
          if (y > ml.cone.yTop && r < ml.apexTunnel.radius - 1e-4) continue;
          // The door's edge walls and window bore go inward from the surface.
          if (tag === 'capsule-door' && polyDist(r, y, shell) > 0.004) continue;
          let d: number;
          if (y < ml.heatShield.maxDiameterY - 1e-6) d = r <= onSphere ? Math.abs(Math.hypot(r, y - centreY) - R) : polyDist(r, y, shoulder);
          else d = polyDist(r, y, shell);
          worst = Math.max(worst, d);
          worstPolyline = Math.max(worstPolyline, polyDist(r, y, ml.profile));
          checked++;
        }
      }
      console.log(`${def.id}: ${checked} skin vertices, worst deviation ${(worst * 1000).toFixed(3)} mm from the mould line (${(worstPolyline * 1000).toFixed(2)} mm from the raw sample polyline, whose chords sag inside the ${R} m dome)`);
      expect(checked).toBeGreaterThan(8000);
      expect(worst).toBeLessThanOrEqual(0.002);
      // Stated for the record: the straight chords between the dome samples sag up to 4.6 mm inside the dome.
      expect(worstPolyline).toBeLessThanOrEqual(0.005);
      // And every sample point of the file is on the modelled surface.
      const g = posedPart(visualOf(def.id), { def, modules: [], skip: ['glass', 'lamp'] }, 0);
      for (const [r, y] of ml.profile) {
        let d = Infinity;
        for (const az of [37, 131, 229, 318]) {
          const p: [number, number, number] = [r * Math.sin(az * DEG), y, r * Math.cos(az * DEG)];
          const P2 = g.positions;
          for (let t = 0; t < g.indices.length; t += 3) {
            // Vertex distance is enough: rings pass through every sample point.
            for (let c = 0; c < 3; c++) {
              const v = g.indices[t + c]! * 3;
              const dd = Math.hypot(P2[v]! - p[0], P2[v + 1]! - p[1], P2[v + 2]! - p[2]);
              if (dd < d) d = dd;
            }
          }
        }
        // Between two azimuth grid lines a ring is a chord: allow its sag on top of the 2 mm.
        expect(d, `profile point (${r}, ${y})`).toBeLessThanOrEqual(0.002 + 0.03);
        const ring = Math.abs(Math.hypot(r, y - centreY) - R);
        if (y <= ml.heatShield.maxDiameterY && r <= onSphere) expect(ring).toBeLessThanOrEqual(0.002);
      }
    }
  });

  it('windows and hatch are cut at the azimuth, height and size of the shared file within 2 mm', () => {
    for (const { def, ml } of capsules()) {
      const visual = visualOf(def.id);
      const mesh = capsuleShell(visual);
      const ids = weld(mesh.positions);
      const P = mesh.positions;
      // Boundary edges of the mould-line skin: edges used by exactly one of its triangles.
      const uses = new Map<string, { n: number; a: number; b: number }>();
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (mesh.meta.tags[mesh.meta.triComponent[t]!] !== 'capsule-skin') continue;
        for (let c = 0; c < 3; c++) {
          const a = mesh.indices[t * 3 + c]!;
          const b = mesh.indices[t * 3 + ((c + 1) % 3)]!;
          const key = ids[a]! < ids[b]! ? `${ids[a]}_${ids[b]}` : `${ids[b]}_${ids[a]}`;
          const u = uses.get(key);
          if (u) u.n++;
          else uses.set(key, { n: 1, a, b });
        }
      }
      const boundary: number[] = [];
      for (const u of uses.values()) if (u.n === 1) boundary.push(u.a, u.b);
      const openings = frames(ml);
      const perOpening = openings.map(() => ({ n: 0, minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity, worst: 0 }));
      for (const v of boundary) {
        const p = [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
        let hit = -1;
        let bestD = Infinity;
        openings.forEach((o, i) => {
          const rel = [p[0]! - o.C[0]!, p[1]! - o.C[1]!, p[2]! - o.C[2]!];
          const a = rel[0]! * o.T[0]! + rel[1]! * o.T[1]! + rel[2]! * o.T[2]!;
          const b = rel[0]! * o.S[0]! + rel[1]! * o.S[1]! + rel[2]! * o.S[2]!;
          const d = Math.abs(roundRectSdf(a, b, o.hw, o.hh, o.rho));
          if (Math.hypot(rel[0]!, rel[1]!, rel[2]!) < 1 && d < bestD) {
            bestD = d;
            hit = i;
          }
        });
        // Every boundary edge of the skin belongs to an opening of the file: the skin has no other hole.
        expect(hit, `boundary vertex at (${p.map((x) => x!.toFixed(3)).join(', ')})`).toBeGreaterThanOrEqual(0);
        const o = openings[hit]!;
        const rel = [p[0]! - o.C[0]!, p[1]! - o.C[1]!, p[2]! - o.C[2]!];
        const a = rel[0]! * o.T[0]! + rel[1]! * o.T[1]! + rel[2]! * o.T[2]!;
        const b = rel[0]! * o.S[0]! + rel[1]! * o.S[1]! + rel[2]! * o.S[2]!;
        const s = perOpening[hit]!;
        s.n++;
        s.minA = Math.min(s.minA, a);
        s.maxA = Math.max(s.maxA, a);
        s.minB = Math.min(s.minB, b);
        s.maxB = Math.max(s.maxB, b);
        s.worst = Math.max(s.worst, bestD);
      }
      openings.forEach((o, i) => {
        const s = perOpening[i]!;
        console.log(`${def.id} ${o.id}: ${s.n / 2} boundary edges, outline within ${(s.worst * 1000).toFixed(3)} mm, width ${(s.maxA - s.minA).toFixed(4)} (file ${2 * o.hw}), height ${(s.maxB - s.minB).toFixed(4)} (file ${2 * o.hh})`);
        expect(s.n, `${o.id}: boundary`).toBeGreaterThanOrEqual(32);
        expect(s.worst, `${o.id}: outline`).toBeLessThanOrEqual(0.002);
        expect(Math.abs(s.maxA - o.hw), `${o.id}: +width edge`).toBeLessThanOrEqual(0.002);
        expect(Math.abs(s.minA + o.hw), `${o.id}: -width edge`).toBeLessThanOrEqual(0.002);
        expect(Math.abs(s.maxB - o.hh), `${o.id}: top edge`).toBeLessThanOrEqual(0.002);
        expect(Math.abs(s.minB + o.hh), `${o.id}: bottom edge`).toBeLessThanOrEqual(0.002);
      });
      // No skin triangle lies across an opening.
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (mesh.meta.tags[mesh.meta.triComponent[t]!] !== 'capsule-skin') continue;
        const c = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const v = mesh.indices[t * 3 + k]!;
          c[0] = c[0]! + P[v * 3]! / 3;
          c[1] = c[1]! + P[v * 3 + 1]! / 3;
          c[2] = c[2]! + P[v * 3 + 2]! / 3;
        }
        for (const o of openings) {
          const rel = [c[0]! - o.C[0]!, c[1]! - o.C[1]!, c[2]! - o.C[2]!];
          if (Math.hypot(rel[0]!, rel[1]!, rel[2]!) > 1) continue;
          const a = rel[0]! * o.T[0]! + rel[1]! * o.T[1]! + rel[2]! * o.T[2]!;
          const b = rel[0]! * o.S[0]! + rel[1]! * o.S[1]! + rel[2]! * o.S[2]!;
          expect(roundRectSdf(a, b, o.hw, o.hh, o.rho), `skin triangle inside opening ${o.id}`).toBeGreaterThan(-0.003);
        }
      }
      // The hatch window: the door has a round hole of the file's radius, glazed by a pane of that radius.
      const hatch = openings[openings.length - 1]!;
      const local = (v: number, src: Float32Array): [number, number, number] => {
        const rel = [src[v * 3]! - hatch.C[0]!, src[v * 3 + 1]! - hatch.C[1]!, src[v * 3 + 2]! - hatch.C[2]!];
        return [rel[0]! * hatch.T[0]! + rel[1]! * hatch.T[1]! + rel[2]! * hatch.T[2]!, rel[0]! * hatch.S[0]! + rel[1]! * hatch.S[1]! + rel[2]! * hatch.S[2]!, rel[0]! * hatch.N[0]! + rel[1]! * hatch.N[1]! + rel[2]! * hatch.N[2]!];
      };
      let innerMost = Infinity;
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (mesh.meta.tags[mesh.meta.triComponent[t]!] !== 'capsule-door') continue;
        for (let k = 0; k < 3; k++) {
          const [a, b] = local(mesh.indices[t * 3 + k]!, P);
          innerMost = Math.min(innerMost, Math.hypot(a, b));
        }
      }
      expect(Math.abs(innerMost - ml.hatch.window.radius), `hatch window radius ${innerMost}`).toBeLessThanOrEqual(0.002);
      const glass = visual.models['glass']!.lods[0]!;
      let paneR = 0;
      let panes = 0;
      for (let v = 0; v < glass.positions.length / 3; v++) {
        const [a, b, n] = local(v, glass.positions);
        if (Math.hypot(a, b) > 0.5 || Math.abs(n) > 0.2) continue;
        paneR = Math.max(paneR, Math.hypot(a, b));
        panes++;
      }
      expect(panes).toBeGreaterThan(8);
      expect(Math.abs(paneR - ml.hatch.window.radius)).toBeLessThanOrEqual(0.002);
      // Reveals go through the whole wall of the file.
      let deepest = 0;
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (mesh.meta.tags[mesh.meta.triComponent[t]!] !== 'capsule-reveal') continue;
        for (let k = 0; k < 3; k++) {
          const v = mesh.indices[t * 3 + k]!;
          const o = openings.reduce((best, x) => (Math.hypot(P[v * 3]! - x.C[0]!, P[v * 3 + 1]! - x.C[1]!, P[v * 3 + 2]! - x.C[2]!) < Math.hypot(P[v * 3]! - best.C[0]!, P[v * 3 + 1]! - best.C[1]!, P[v * 3 + 2]! - best.C[2]!) ? x : best));
          const depth = -((P[v * 3]! - o.C[0]!) * o.N[0]! + (P[v * 3 + 1]! - o.C[1]!) * o.N[1]! + (P[v * 3 + 2]! - o.C[2]!) * o.N[2]!);
          deepest = Math.max(deepest, depth);
        }
      }
      expect(deepest).toBeGreaterThanOrEqual(ml.wallThickness);
      expect(deepest).toBeLessThanOrEqual(ml.wallThickness + 0.06);
    }
  });

  it('the heat shield is a model of its own whose glow follows the ablating surface and whose face chars; glazing and lamps stay cold', () => {
    for (const { def } of capsules()) {
      const visual = visualOf(def.id);
      expect(Object.keys(visual.models)).toEqual(expect.arrayContaining(['body', 'shield', 'shieldChar', 'glass', 'lamp']));
      const index = def.modules.findIndex((m) => m.type === 'heatShield');
      expect(index).toBeGreaterThanOrEqual(0);
      const launch = vesselPartSnapshots(assembleVessel(defs, Object.keys(defs.vehicles)[0]!)).find((p) => p.def === def.id)!.modules;
      const pose = (patch: { surfaceTemp?: number; ablatorFraction?: number }) => {
        const seen = new Map<string, { temperature: number | undefined; cold: boolean; emissive: number | undefined }>();
        const modules = launch.map((m) => (m.type === 'heatShield' ? { ...m, ...patch } : m));
        visual.pose({ def, modules, panel: null, anim: { nozzleTemp: 0, soot: 0, frost: 0, clamp: 0, antenna: 0, lamp: 1 } }, (name, _pos, _rot, opts) => void seen.set(name, { temperature: opts?.temperature, cold: opts?.cold === true, emissive: opts?.emissive }));
        return seen;
      };
      // Cold: the shield as built, no emission at all (an emissive scale of exactly 0, not the default 1).
      const cold = pose({});
      expect(cold.get('shield')).toEqual({ temperature: undefined, cold: true, emissive: 0 });
      expect(cold.has('shieldChar')).toBe(false);
      // Hot: the glow is the shield's own emissive map scaled with the surface temperature (the instance has
      // no uniform black-body term), brighter the hotter the surface; the structure behind it stays as it is.
      const warm = pose({ surfaceTemp: 1900 });
      const hot = pose({ surfaceTemp: 3100 });
      expect(warm.get('shield')!.cold).toBe(true);
      expect(warm.get('shield')!.emissive!).toBeGreaterThan(1e4);
      expect(hot.get('shield')!.emissive!).toBeGreaterThan(4 * warm.get('shield')!.emissive!);
      expect(shieldGlowLuminance(600)).toBe(0);
      // The back shell follows the part's own skin temperature (no item temperature of its own).
      expect(hot.get('body')).toEqual({ temperature: undefined, cold: false, emissive: undefined });
      expect(hot.get('glass')!.cold).toBe(true);
      expect(hot.get('lamp')!.cold).toBe(true);
      // Flown: the charred face replaces the face as built.
      const flown = pose({ ablatorFraction: 0.6 });
      expect(flown.has('shield')).toBe(false);
      expect(flown.get('shieldChar')).toEqual({ temperature: undefined, cold: true, emissive: 0 });
      // Both shield models hold the whole heat shield and nothing of the back shell, with planar texture
      // coordinates inside the unit square (the shield's textures are one picture of the face).
      for (const name of ['shield', 'shieldChar']) {
        for (const lod of visual.models[name]!.lods) {
          expect(lod.bounds.max[1], `${name} top`).toBeLessThanOrEqual(0.02 + defs.parts[def.id]!.attachNodes.find((n) => n.id === 'bottom')!.pos[1]);
          expect(lod.indices.length).toBeGreaterThan(0);
        }
        const skin = visual.models[name]!.lods[0]!;
        const pads = skin.meta.tags.indexOf('pad');
        for (let t = 0; t < skin.indices.length / 3; t++) {
          if (pads >= 0 && skin.meta.tags[skin.meta.triComponent[t]!] === 'pad') continue;
          for (let c = 0; c < 3; c++) {
            const v = skin.indices[t * 3 + c]!;
            expect(skin.uvs[v * 2]!).toBeGreaterThan(0);
            expect(skin.uvs[v * 2]!).toBeLessThan(1);
            expect(skin.uvs[v * 2 + 1]!).toBeGreaterThan(0);
            expect(skin.uvs[v * 2 + 1]!).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('the escape system\'s boost cover stays outside the mould line of the capsule under it', () => {
    let covers = 0;
    for (const vehicle of Object.values(defs.vehicles)) {
      const parts = vesselPartSnapshots(assembleVessel(defs, vehicle.id));
      for (const les of parts) {
        const def = defs.parts[les.def]!;
        if (def.visual?.generator !== 'les.tower') continue;
        const key = String(def.visual.params['mouldLine']);
        const ml = getSection<CapsuleMouldLineDef>(defs, key);
        const capsule = parts.find((q) => defs.parts[q.def]!.visual?.generator === 'capsule.mouldline' && String(defs.parts[q.def]!.visual!.params['mouldLine']) === key)!;
        expect(capsule, `${les.instanceId}: capsule under the cover`).toBeDefined();
        covers++;
        // The capsule's outer radius at a height, straight from the file's profile.
        const shell = ml.profile.filter((q) => q[1] >= ml.heatShield.maxDiameterY - 1e-9);
        const mould = (y: number): number => {
          for (let i = 0; i + 1 < shell.length; i++) {
            const a = shell[i]!;
            const c = shell[i + 1]!;
            if (y <= c[1]) return a[0] + ((c[0] - a[0]) * (y - a[1])) / Math.max(1e-9, c[1] - a[1]);
          }
          return shell[shell.length - 1]![0];
        };
        const g = posedPart(visualOf(les.def), { def, modules: les.modules }, 0);
        const dy = les.localPos.y - capsule.localPos.y;
        let worst = Infinity;
        let checked = 0;
        for (let i = 0; i < g.positions.length; i += 3) {
          const y = g.positions[i + 1]! + dy;
          if (y < ml.heatShield.maxDiameterY + 0.005 || y > ml.apexTunnel.yTop - 0.005) continue;
          const r = Math.hypot(g.positions[i]! + les.localPos.x - capsule.localPos.x, g.positions[i + 2]! + les.localPos.z - capsule.localPos.z);
          worst = Math.min(worst, r - mould(y));
          checked++;
        }
        console.log(`${les.instanceId}: ${checked} cover vertices beside the capsule, nearest ${(worst * 1000).toFixed(1)} mm outside its mould line`);
        expect(checked).toBeGreaterThan(1000);
        expect(worst).toBeGreaterThanOrEqual(0.01);
      }
    }
    expect(covers).toBeGreaterThanOrEqual(1);
  });
});
