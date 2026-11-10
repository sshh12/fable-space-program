/**
 * Render-core lab. One page, selected by query string:
 *
 *   ?lab=stand        (default) the test stand on a LabPlanet: material sweep, shadows, emissive objects
 *   &scene=<FakeScene>          pad (default), lunarOrbit, translunar, ...
 *   &site=lat,lon[,alt]         where the stand sits (default: the scenario's launch site; `site=moonview`
 *                               picks a spot on the root body from which the moon stands 35 deg high)
 *   &sun=az,el                  pin the sun at this azimuth / elevation (deg) at the site
 *   &planet=0                   no LabPlanet;  &stand=0  no stand
 *   &probe=<name>[,<name>...]   extra lab features (see probes.ts)
 * plus every camera / renderer parameter of createLabApp. Specs drive the rest through window.__lab and
 * window.__rc (this page's own handle).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderFeature } from '@/core/contracts/render';
import type { Sim } from '@/core/contracts/sim';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { dirToLatLon } from '@/core/geo/cubeSphere';
import { quat, RAD, v3 } from '@/core/math';
import { createLabApp, createLabPlanetFeature, type LabApp, type LabCameraSpec } from '@/render/core/lab';
import { createProbes, type Probes } from './probes';
import { createStandFeature, type StandFeature } from './stand';
import { proceduralPlanetMap, sunAtSite, withSunOverride, type Site, type SunOverride } from './world';

export interface RenderCoreLab {
  app: LabApp;
  site: Site;
  stand: StandFeature | null;
  probes: Probes;
  /** Pin the sun at azimuth / elevation (deg) at the site, or release it with null. */
  setSun(azEl: [number, number] | null): void;
  /** Pin the sun along an arbitrary ROOT direction provider. */
  setSunOverride(o: SunOverride | null): void;
}

declare global {
  interface Window {
    __rc?: RenderCoreLab;
  }
}

const query = new URLSearchParams(location.search);
const scene = (query.get('scene') as FakeScene | null) ?? 'pad';
let sunOverride: SunOverride | null = null;
let site!: Site;
let stand: StandFeature | null = null;
let probes!: Probes;

function pickSite(defs: DefLibrary, sim: Sim): Site {
  const root = defs.rootBodyId;
  const arg = query.get('site');
  const vesselBody = sim.peek().vessels[0]?.bodyId ?? root;
  if (arg === 'moonview') {
    // A point on the root body from which its moon is about 35 deg above the horizon.
    const s = sim.peek();
    const earth = s.bodies.find((b) => b.id === root)!;
    const moon = s.bodies.find((b) => defs.bodies[b.id]?.parent === root && defs.bodies[b.id]?.gravityRole === 'attractor')!;
    const toMoon = v3.normalize(quat.rotateInv(earth.qFixedToRoot, v3.sub(moon.rRoot, earth.rRoot)));
    const axis = v3.anyOrthogonal(toMoon);
    const dir = quat.rotate(quat.fromAxisAngle(axis, (55 * Math.PI) / 180), toMoon);
    const ll = dirToLatLon(dir);
    return { bodyId: root, latDeg: ll.lat * RAD, lonDeg: ll.lon * RAD, alt: 1 };
  }
  if (arg) {
    const [lat, lon, alt] = arg.split(',').map(Number);
    return { bodyId: query.get('siteBody') ?? vesselBody, latDeg: lat ?? 0, lonDeg: lon ?? 0, alt: alt ?? 1 };
  }
  const first = Object.values(defs.sites)[0];
  if (vesselBody === root && first) return { bodyId: root, latDeg: first.location.latDeg, lonDeg: first.location.lonDeg, alt: 1 };
  return { bodyId: vesselBody, latDeg: 0.674, lonDeg: 23.473, alt: 1 };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const app = await createLabApp({
    canvas,
    name: 'render-core',
    scene,
    autoReady: false,
    sim: (defs) => {
      const inner = createFakeSim(defs, { scene });
      site = pickSite(defs, inner);
      const sun = query.get('sun');
      if (sun) {
        const [az, el] = sun.split(',').map(Number);
        sunOverride = sunAtSite(site, az ?? 120, el ?? 40);
      }
      return withSunOverride(inner, () => sunOverride);
    },
    features: (defs) => {
      const list: RenderFeature[] = [];
      if (query.get('planet') !== '0') {
        // Synthetic albedo maps by default (deterministic, no dependency on baked tiles); ?maps=tileset uses the real ones.
        const maps: NonNullable<Parameters<typeof createLabPlanetFeature>[0]>['maps'] = {};
        if (query.get('maps') !== 'tileset') {
          let seed = 100;
          for (const b of Object.values(defs.bodies)) if (!b.emission) maps[b.id] = proceduralPlanetMap(seed++, b.ocean !== null);
        }
        list.push(createLabPlanetFeature({ maps }));
      }
      if (query.get('stand') !== '0') {
        stand = createStandFeature({ site, defs, heavyTriangles: Number(query.get('tris') ?? 0) || undefined, vesselSizedObject: query.get('stack') !== '0' });
        list.push(stand);
      }
      probes = createProbes(query, site, defs);
      list.push(...probes.features);
      return list;
    },
    camera: (): LabCameraSpec => ({ type: 'orbit', target: { bodyId: site.bodyId, latDeg: site.latDeg, lonDeg: site.lonDeg, alt: site.alt + 1 }, yaw: (200 * Math.PI) / 180, pitch: (22 * Math.PI) / 180, distance: 16 }),
  });
  probes.attach(app);

  const lab: RenderCoreLab = {
    app,
    site,
    stand,
    probes,
    setSun(azEl) {
      sunOverride = azEl ? sunAtSite(site, azEl[0], azEl[1]) : null;
    },
    setSunOverride(o) {
      sunOverride = o;
    },
  };
  window.__rc = lab;

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      info.textContent =
        `render-core lab   scene ${scene}   ${p.counters.renderWidth ?? 0} x ${p.counters.renderHeight ?? 0}  scale ${p.renderScale.toFixed(2)}  quality ${p.qualityScale.toFixed(2)}\n` +
        `gpu ${p.gpu.p50.toFixed(2)} ms (p99 ${p.gpu.p99.toFixed(2)})   cpu ${p.cpu.p50.toFixed(2)} ms   raf ${p.raf.p50.toFixed(1)} ms\n` +
        `EV100 ${e.ev100.toFixed(2)} (target ${e.targetEv100.toFixed(2)}, lit ${(e.litFraction * 100).toFixed(2)} %)   cascades ${p.counters.shadowCascades ?? 0} (${p.counters.shadowCascadesRendered ?? 0} drawn)`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
});
