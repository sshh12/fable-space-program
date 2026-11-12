/**
 * Assemble the cockpit interior of one layout: three detail levels (inside, outside near, outside far) in
 * one vertex / index buffer with named index and vertex ranges (plus the cabin sun map's casters of each
 * level and the shadow-only 'plugs'), the run-time metadata (controls,
 * displays, the navball instrument, windows and panes, floodlights, label atlas) and the BVH of the full
 * detail level (sun-patch ray casts, occlusion bake). Pure: runs in vitest.
 */
import type { CapsuleMouldLineDef, DefLibrary } from '@/core/contracts/defs';
import { v3 } from '@/core/math';
import { buildBvh, type Bvh } from './bvh';
import { buildDockingHatch, buildHatch, buildPlugs, buildWindows } from './cabin/apertures';
import { buildConsole } from './cabin/console';
import { CabinContext, FLAG_EMISSIVE, FLAG_ENCLOSURE, FLAG_OVERLAY, type ControlMeta, type CouchMeta, type DisplayMeta, type FloodMeta, type LabelAlloc, type WindowMeta } from './cabin/context';
import { buildCouches } from './cabin/couches';
import { buildFixtures } from './cabin/fixtures';
import { buildShell, type Region } from './cabin/shell';
import { loadCockpitLayout, type CockpitLayoutDef } from './layout';
import { FLAG_LABEL, VERTEX_STRIDE, type BuiltMesh, type Frame } from './mesh';

export const LOD_RANGES = ['lod0', 'lod1', 'lod2'] as const;
export type LodName = (typeof LOD_RANGES)[number];
/** Index range of a detail level's casters in the cabin sun map. */
export const sunRange = (lod: LodName): string => `sun-${lod}`;

export interface CockpitModel {
  layoutId: string;
  layout: CockpitLayoutDef;
  mould: CapsuleMouldLineDef;
  mesh: BuiltMesh;
  materialNames: string[];
  controls: ControlMeta[];
  displays: DisplayMeta[];
  navball: { frame: Frame; radius: number };
  windows: WindowMeta[];
  floods: FloodMeta[];
  couches: CouchMeta[];
  labels: LabelAlloc[];
  regions: Region[];
  /** BVH over the full-detail triangles (part frame). */
  bvh: Bvh;
  /** Triangles per detail level. */
  triangles: Record<LodName, number>;
}

/** Vertex positions (xyz per vertex) of a built mesh. */
export function meshPositions(mesh: BuiltMesh): Float32Array {
  const f32 = new Float32Array(mesh.vertices);
  const out = new Float32Array(mesh.vertexCount * 3);
  for (let i = 0; i < mesh.vertexCount; i++) out.set(f32.subarray((i * VERTEX_STRIDE) / 4, (i * VERTEX_STRIDE) / 4 + 3), i * 3);
  return out;
}

/**
 * BVH over one detail level of a built mesh, without its thin overlays (FLAG_OVERLAY: they do not occlude in
 * the bake); triangles carry their first vertex's material index.
 */
export function meshBvh(mesh: BuiltMesh, lod: LodName, positions = meshPositions(mesh)): Bvh {
  const u8 = new Uint8Array(mesh.vertices);
  const r = mesh.ranges[lod]!;
  const kept: number[] = [];
  for (let i = r.start; i < r.start + r.count; i += 3) {
    if ((u8[mesh.indices[i]! * VERTEX_STRIDE + 42]! & FLAG_OVERLAY) === 0) kept.push(mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!);
  }
  return buildBvh(positions, Uint32Array.from(kept), 0, kept.length, (v) => u8[v * VERTEX_STRIDE + 40]!);
}

export function buildCockpitModelFrom(layoutId: string, layout: CockpitLayoutDef, mould: CapsuleMouldLineDef): CockpitModel {
  const ctx = new CabinContext(layout, mould);
  let regions: Region[] = [];
  // Near to far as seen from the couches (the console and the couches first, the pressure shell last), so
  // that early depth testing rejects most of the shell's hidden pixels before they are shaded.
  for (const detail of [0, 1, 2] as const) {
    ctx.detail = detail;
    // Full detail subdivides large flat faces so that the per-vertex occlusion bake resolves them.
    ctx.b.maxEdge = detail === 0 ? layout.transport.maxEdge : Infinity;
    // Every builder names the assemblies it makes (MeshBuilder.group): what the penetration check tests.
    ctx.b.group('console');
    buildConsole(ctx);
    buildCouches(ctx);
    buildFixtures(ctx);
    ctx.b.group('hatch');
    buildHatch(ctx);
    ctx.b.group('dockingHatch');
    buildDockingHatch(ctx);
    ctx.b.group('windows');
    buildWindows(ctx);
    ctx.b.group('shell');
    const r = buildShell(ctx);
    if (detail === 0) regions = r;
    ctx.b.mark(LOD_RANGES[detail]);
  }
  const b = ctx.b;
  // Labels (not lamp legends, which are lens faces) move to a range of their own at the end of the full
  // detail level: they are drawn as decals over their faces.
  {
    const r = b.ranges.lod0!;
    const opaque: number[] = [];
    const decals: number[] = [];
    for (let i = r.start; i < r.start + r.count; i += 3) {
      const f = b.flagsOf(b.idx[i]!);
      const out = (f & FLAG_LABEL) !== 0 && (f & FLAG_EMISSIVE) === 0 ? decals : opaque;
      out.push(b.idx[i]!, b.idx[i + 1]!, b.idx[i + 2]!);
    }
    opaque.forEach((v, k) => (b.idx[r.start + k] = v));
    decals.forEach((v, k) => (b.idx[r.start + opaque.length + k] = v));
    b.ranges.lod0 = { start: r.start, count: opaque.length };
    b.ranges.labels = { start: r.start + opaque.length, count: decals.length };
  }
  // The cabin sun map's casters per detail level: everything but the enclosure (the windows' apertures
  // bound the light that enters analytically), as further index ranges over the same vertices.
  for (const lod of LOD_RANGES) {
    const r = b.ranges[lod]!;
    for (let i = r.start; i < r.start + r.count; i += 3) {
      if ((b.flagsOf(b.idx[i]!) & FLAG_ENCLOSURE) === 0) b.idx.push(b.idx[i]!, b.idx[i + 1]!, b.idx[i + 2]!);
    }
    b.mark(sunRange(lod));
  }
  // Shadow-only geometry for the core's cascades (apertures.ts): the window openings closed.
  b.maxEdge = Infinity;
  b.group('shell');
  buildPlugs(ctx);
  b.mark('plugs');
  const mesh = ctx.b.build();
  if (!ctx.navball) throw new Error(`cockpit layout ${layoutId}: the console has no navball instrument`);
  if (ctx.displays.length !== layout.console.displays.length || ctx.displays.some((d) => !d)) throw new Error(`cockpit layout ${layoutId}: display bezels missing`);
  return {
    layoutId,
    layout,
    mould,
    mesh,
    materialNames: Object.keys(layout.materials),
    controls: ctx.controls,
    displays: ctx.displays,
    navball: ctx.navball,
    windows: ctx.windows,
    floods: ctx.floods,
    couches: ctx.couches,
    labels: ctx.labels,
    regions,
    bvh: meshBvh(mesh, 'lod0'),
    triangles: { lod0: mesh.ranges.lod0!.count / 3, lod1: mesh.ranges.lod1!.count / 3, lod2: mesh.ranges.lod2!.count / 3 },
  };
}

/** Build the interior of cockpit layout `layoutId` from the definition library. */
export function buildCockpitModel(defs: DefLibrary, layoutId: string): CockpitModel {
  const { layout, mould } = loadCockpitLayout(defs, layoutId);
  return buildCockpitModelFrom(layoutId, layout, mould);
}

/**
 * Vertices of the display screens as the display pipeline draws them: per display two triangles, 9 floats
 * per vertex (position, normal, uv with (0, 0) top-left, layer).
 */
export function displayVertices(model: CockpitModel): Float32Array<ArrayBuffer> {
  const dv: number[] = [];
  for (const d of model.displays) {
    const f = d.frame;
    const hw = d.width / 2;
    const hh = d.height / 2;
    const corner = (a: number, b: number, u: number, vv: number): void => {
      const p = v3.add(f.o, v3.add(v3.scale(f.x, a), v3.scale(f.y, b)));
      dv.push(p.x, p.y, p.z, f.n.x, f.n.y, f.n.z, u, vv, d.index);
    };
    corner(-hw, -hh, 0, 1);
    corner(hw, -hh, 1, 1);
    corner(hw, hh, 1, 0);
    corner(-hw, -hh, 0, 1);
    corner(hw, hh, 1, 0);
    corner(-hw, hh, 0, 0);
  }
  return new Float32Array(dv);
}
