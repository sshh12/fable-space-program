/**
 * Penetration check of the cabin (request cockpit-lead-1): no assembly reaches into the pressure hull, into
 * what lies on it (insulation blankets, frames and stringers, close-out panels) or into another assembly by
 * more than a few millimetres. The method is in src/render/cockpit/penetration.ts; the shared mould line is
 * read from the definitions (no literals).
 *
 * COCKPIT_PENETRATION_REPORT=1 prints every pair found (the working list of a geometry round).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import { getSection } from '@/core/defs/loader';
import type { CockpitModel } from '@/render/cockpit/build';
import { MeshBuilder, frameAt } from '@/render/cockpit/mesh';
import { findPenetrations, groupKind, wallDepthByGroup, type Penetration } from '@/render/cockpit/penetration';
import { testDefs, testModel } from './helpers';

let model: CockpitModel;
let def: CapsuleMouldLineDef;
let found: Penetration[];

/** Deeper than this (m) is a penetration: the request's "a few millimetres". */
const TOLERANCE = 0.003;

beforeAll(async () => {
  const defs = await testDefs();
  model = await testModel('kestrel');
  def = getSection<CapsuleMouldLineDef>(defs, model.layout.mouldLine);
  found = findPenetrations(model.mesh, def, { tolerance: TOLERANCE });
  if (process.env.COCKPIT_PENETRATION_REPORT) {
    for (const f of found) console.log(`${f.group} -> ${f.into}: ${(f.depth * 1000).toFixed(1)} mm, ${f.samples} samples, at (${f.at.x.toFixed(3)}, ${f.at.y.toFixed(3)}, ${f.at.z.toFixed(3)})`);
    console.log(`${found.length} pairs`);
  }
}, 240_000);

describe('the check itself, on boxes', () => {
  const X = { x: 1, y: 0, z: 0 };
  const Y = { x: 0, y: 1, z: 0 };
  const attr = { mat: 0 };
  const boxes = (offset: number): Penetration[] => {
    const b = new MeshBuilder();
    b.group('a');
    b.box(frameAt({ x: 0, y: 1, z: 0 }, X, Y), 0.1, 0.1, 0.1, 0.004, attr);
    b.group('b');
    b.box(frameAt({ x: offset, y: 1, z: 0.02 }, X, Y), 0.1, 0.05, 0.05, 0.004, attr);
    b.mark('lod0');
    return findPenetrations(b.build(), def, { tolerance: TOLERANCE });
  };

  it('finds a box that reaches 20 mm into another, and how deep', () => {
    const f = boxes(0.18);
    const hit = f.find((x) => x.group === 'b' && x.into === 'a');
    expect(hit, 'b reaches into a').toBeDefined();
    expect(hit!.depth).toBeGreaterThan(0.015);
    expect(hit!.depth).toBeLessThan(0.03);
    expect(f.find((x) => x.group === 'a' && x.into === 'b'), 'and a into b').toBeDefined();
  });

  it('finds nothing between boxes that touch or stand apart', () => {
    expect(boxes(0.2).filter((x) => x.into !== 'shell')).toEqual([]);
    expect(boxes(0.26).filter((x) => x.into !== 'shell')).toEqual([]);
  });

  it('finds a box that crosses the pressure wall', () => {
    const b = new MeshBuilder();
    b.group('a');
    // At the cone's mid height, centred a wall thickness inside the outer mould line: half of it is in the wall.
    const y = (def.cone.yBottom + def.cone.yTop) / 2;
    const rOuter = def.heatShield.maxDiameter / 2 + ((def.cone.radiusTop - def.heatShield.maxDiameter / 2) * (y - def.cone.yBottom)) / (def.cone.yTop - def.cone.yBottom);
    b.box(frameAt({ x: rOuter - def.wallThickness, y, z: 0 }, X, Y), 0.05, 0.05, 0.05, 0.004, attr);
    b.mark('lod0');
    const f = findPenetrations(b.build(), def, { tolerance: TOLERANCE });
    expect(f.find((x) => x.group === 'a' && x.into === 'shell')?.depth ?? 0).toBeGreaterThan(0.02);
  });

  // Webbing against the hardware of its own assembly: a band (thin overlay) that runs THROUGH a fitting 5.6 mm
  // thick is found; the same band under the fitting, a millimetre clear of it, is not.
  const threaded = (bandHeight: number): Penetration[] => {
    const b = new MeshBuilder();
    b.group('harness');
    b.box(frameAt({ x: 0, y: 1, z: 0 }, X, Y), 0.028, 0.011, 0.0028, 0.0005, attr);
    b.surface(40, 1, (i, j) => ({ p: { x: (j - 0.5) * 0.045, y: 0.88 + i * 0.006, z: bandHeight }, uv: [i * 0.006, j * 0.045] }), { mat: 0, flags: 64 });
    b.mark('lod0');
    return findPenetrations(b.build(), def, { tolerance: TOLERANCE });
  };

  it('finds webbing that runs through a fitting of its own assembly, and none that passes under it', () => {
    const through = threaded(0).find((x) => x.group === 'harness' && x.into === 'harness (own hardware)');
    expect(through, 'the band through the fitting').toBeDefined();
    expect(through!.depth).toBeGreaterThan(0.002);
    expect(through!.depth).toBeLessThan(0.0029);
    expect(threaded(-0.0038).filter((x) => x.into !== 'shell')).toEqual([]);
  });

  it('tells the kinds of assembly by name', () => {
    expect([groupKind('shell'), groupKind('skin:blankets'), groupKind('mount:panel'), groupKind('console')]).toEqual(['shell', 'skin', 'mount', 'solid']);
  });
});

describe('the cabin', () => {
  it('every vertex of the full detail level belongs to a named assembly', () => {
    expect(found.filter((f) => f.group === '(unnamed)' || f.into === '(unnamed)')).toEqual([]);
    const r = model.mesh.vertexRanges.lod0!;
    let unnamed = 0;
    for (let v = r.start; v < r.start + r.count; v++) if (model.mesh.vertexGroup[v] === 0) unnamed++;
    expect(unnamed).toBe(0);
  });

  it('nothing reaches into the pressure hull or through the floor', () => {
    expect(found.filter((f) => f.into === 'shell').map((f) => `${f.group}: ${(f.depth * 1000).toFixed(1)} mm`)).toEqual([]);
  });

  it('mounting hardware ends at the wall: no assembly, mounts included, has a vertex in the wall or under the floor', () => {
    for (const range of ['lod0', 'lod1', 'lod2']) {
      const deep = Object.entries(wallDepthByGroup(model.mesh, def, range))
        .filter(([, d]) => d > 1e-4)
        .map(([name, d]) => `${range} ${name}: ${(d * 1000).toFixed(1)} mm`);
      expect(deep).toEqual([]);
    }
  });

  it('nothing reaches into the blankets, the frames and stringers or the close-out panels', () => {
    expect(found.filter((f) => f.into.startsWith('skin:')).map((f) => `${f.group} -> ${f.into}: ${(f.depth * 1000).toFixed(1)} mm`)).toEqual([]);
  });

  it('no webbing or other soft overlay runs through the hardware of its own assembly (harness fittings, strap buckles)', () => {
    expect(found.filter((f) => f.into.endsWith('(own hardware)')).map((f) => `${f.group}: ${(f.depth * 1000).toFixed(1)} mm, ${f.samples} samples`)).toEqual([]);
  });

  it('no assembly reaches into another (console, couches, harnesses, hatches, fixtures)', () => {
    expect(found.filter((f) => f.into !== 'shell' && !f.into.startsWith('skin:')).map((f) => `${f.group} -> ${f.into}: ${(f.depth * 1000).toFixed(1)} mm`)).toEqual([]);
  });
});
