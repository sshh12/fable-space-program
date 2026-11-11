/**
 * Every render feature of the game, built through each package's public factory exactly as its hand-off
 * documents it (docs/handoff/core-support.md section 6 item 8; labs/integration/features.ts builds the same set
 * for the integration lab), plus the map view's overlay.
 *
 * Registration order: opaque geometry first (terrain, vessels, launch site), then water, sky, atmosphere and
 * clouds, the effects, and the cockpit last; `RenderFeature.order` decides the order inside each hook (the
 * cockpit's glass, order 100, after the plumes and the plasma, ARCHITECTURE 10.0; the map overlay, order 100,
 * after everything).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import type { TerrainAuthority } from '@/terrain';
import type { CockpitControls, MfdPainter, NavballRenderer } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';
import { createMapView, type MapViewApi } from '@/map';
import { createAtmosphereFeature, type AtmosphereFeature } from '@/render/atmosphere';
import { createCockpitFeature, type CockpitFeature } from '@/render/cockpit';
import { createOceanFeature, type OceanFeature } from '@/render/ocean';
import { createSkyFeature, type SkyFeature } from '@/render/sky';
import { createTerrainFeature, type TerrainFeature } from '@/render/terrain';
import { createSiteFeature, createVesselVisualFeature, type SiteFeature, type VesselVisualFeature } from '@/render/vehicle';
import { createVfxFeature, type VfxFeature } from '@/render/vfx';

/**
 * Largest face of the Milky Way cube kept on the GPU: the full baked 2048 (lead decision on request
 * sky-lighting-2; ARCHITECTURE 17 counts 0.15 GB of VRAM for the sky).
 */
export const MILKY_WAY_FACE_SIZE = 2048;

export interface GameFeatures {
  /** In registration order. */
  list: RenderFeature[];
  terrain: TerrainFeature;
  vessels: VesselVisualFeature;
  site: SiteFeature;
  ocean: OceanFeature;
  sky: SkyFeature;
  atmosphere: AtmosphereFeature;
  vfx: VfxFeature;
  cockpit: CockpitFeature;
  /** The cockpit's display pages, driven by the `mfdCycle:*` actions. */
  cockpitControls: CockpitControls;
  /** The map view's controller (pointer, node editing); its overlay feature is in `list`. */
  map: MapViewApi;
  /** Package of every feature id (the budget table of ARCHITECTURE 17.1 is kept per package). */
  packageOf: Record<string, string>;
}

export interface FeatureDeps {
  ctx: RenderContext;
  gpu: GpuHandle;
  defs: DefLibrary;
  /** The height authority shared with the simulation. */
  terrain: TerrainAuthority;
  /** The navball texture the HUD renders and the cockpit instrument shows. */
  navball: NavballRenderer;
  mfdPainter: MfdPainter;
  /** Element over the canvas whose CSS pixels are the canvas's (the HUD container): the map's node panel. */
  uiRoot: HTMLElement;
}

export function createGameFeatures(deps: FeatureDeps): GameFeatures {
  const { ctx, gpu, defs } = deps;
  const terrain = createTerrainFeature(ctx, () => deps.terrain);
  // The cockpit shows its interior through its own transparent glazing, also from outside: the vehicle must not
  // close the capsule's windows with its opaque outer panes (request cockpit-8).
  const vessels = createVesselVisualFeature({ exteriorGlass: false });
  // The pad is flattened to its elevation across the site (LaunchSiteDef.pad.flatRadius): every structure stands
  // on the pad plane, the factory's default (docs/handoff/vehicle-pad.md, "Integration").
  const site = createSiteFeature();
  const ocean = createOceanFeature();
  const sky = createSkyFeature({ milkyWayFaceSize: MILKY_WAY_FACE_SIZE });
  const atmosphere = createAtmosphereFeature();
  const vfx = createVfxFeature(ctx);
  const cockpit = createCockpitFeature(ctx, { navball: deps.navball, mfdPainter: deps.mfdPainter });
  const map = createMapView(gpu, defs, { uiRoot: deps.uiRoot });

  const entries: [string, RenderFeature][] = [
    ['terrain', terrain],
    ['vehicle', vessels],
    ['vehicle', site],
    ['ocean', ocean],
    ['sky', sky],
    ['atmosphere', atmosphere],
    ['vfx', vfx],
    ['cockpit', cockpit.feature],
    ['map', map.feature],
  ];
  const packageOf: Record<string, string> = {};
  for (const [pkg, f] of entries) {
    if (packageOf[f.id] !== undefined) throw new Error(`Two render features share the id "${f.id}".`);
    packageOf[f.id] = pkg;
  }
  return {
    list: entries.map(([, f]) => f),
    terrain,
    vessels,
    site,
    ocean,
    sky,
    atmosphere,
    vfx,
    cockpit: cockpit.feature,
    cockpitControls: cockpit.controls,
    map: map.view,
    packageOf,
  };
}
