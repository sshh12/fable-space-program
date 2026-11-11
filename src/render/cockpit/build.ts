/**
 * Assemble the cockpit interior of one layout: three detail levels (inside, outside near, outside far) in
 * one vertex / index buffer with named index ranges, plus the run-time metadata (controls, displays, the
 * navball instrument, windows and panes, floodlights, ray-cast proxies, label atlas). Pure: runs in vitest.
 */
import type { CapsuleMouldLineDef, DefLibrary } from '@/core/contracts/defs';
import type { BuiltMesh } from './mesh';
import { buildDockingHatch, buildHatch, buildWindows } from './cabin/apertures';
import { buildConsole } from './cabin/console';
import { CabinContext, type ControlMeta, type CouchMeta, type DisplayMeta, type FloodMeta, type LabelAlloc, type ProxyBox, type WindowMeta } from './cabin/context';
import { buildCouches } from './cabin/couches';
import { buildFixtures } from './cabin/fixtures';
import { buildShell, type Region } from './cabin/shell';
import { loadCockpitLayout, type CockpitLayoutDef } from './layout';
import type { Frame } from './mesh';

export const LOD_RANGES = ['lod0', 'lod1', 'lod2'] as const;
export type LodName = (typeof LOD_RANGES)[number];

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
  proxies: ProxyBox[];
  labels: LabelAlloc[];
  regions: Region[];
  /** Triangles per detail level. */
  triangles: Record<LodName, number>;
}

export function buildCockpitModelFrom(layoutId: string, layout: CockpitLayoutDef, mould: CapsuleMouldLineDef): CockpitModel {
  const ctx = new CabinContext(layout, mould);
  let regions: Region[] = [];
  // Near to far as seen from the couches (the console and the couches first, the pressure shell last), so
  // that early depth testing rejects most of the shell's hidden pixels before they are shaded.
  for (const detail of [0, 1, 2] as const) {
    ctx.detail = detail;
    buildConsole(ctx);
    buildCouches(ctx);
    buildFixtures(ctx);
    buildHatch(ctx);
    buildDockingHatch(ctx);
    buildWindows(ctx);
    const r = buildShell(ctx);
    if (detail === 0) regions = r;
    ctx.b.mark(LOD_RANGES[detail]);
  }
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
    proxies: ctx.proxies,
    labels: ctx.labels,
    regions,
    triangles: { lod0: mesh.ranges.lod0!.count / 3, lod1: mesh.ranges.lod1!.count / 3, lod2: mesh.ranges.lod2!.count / 3 },
  };
}

/** Build the interior of cockpit layout `layoutId` from the definition library. */
export function buildCockpitModel(defs: DefLibrary, layoutId: string): CockpitModel {
  const { layout, mould } = loadCockpitLayout(defs, layoutId);
  return buildCockpitModelFrom(layoutId, layout, mould);
}
