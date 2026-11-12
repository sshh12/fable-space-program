/**
 * The reviewed camera placements of the terrain package (brief: ACCEPTANCE). Each one is also a lab URL
 * (see `viewUrl`), so a view can be opened by hand in the dev server.
 */
import type { Page } from '@playwright/test';
import { LUNAR_SITE, PAD, labUrl, type Query } from './util';

export interface View {
  name: string;
  /** Lab scene whose sim state the view runs on (only the body positions matter). */
  body: 'earth' | 'moon';
  cam:
    | { type: 'surface'; lat: number; lon: number; height: number; agl: boolean; heading: number; pitch: number }
    | { type: 'orbitBody'; yaw: number; pitch: number; distance: number }
    | { type: 'orbitSite'; lat: number; lon: number; alt: number; yaw: number; pitch: number; distance: number };
  fov?: number;
  /** Sun by azimuth / elevation at a site, or by the sub-solar point (deg, body-fixed). */
  sun: { az: number; el: number; lat: number; lon: number } | { subsolar: [number, number] };
  /** Forced EV100 (night views: the auto exposure would meter the dark frame differently from a camera). */
  ev?: number;
}

/**
 * Views of the ground by day are exposed as a photographer exposes in daylight ("sunny 16"), not by the
 * lab's meter: it lifts a frame filled with dark lava by two stops and more, to a grey plain, and no
 * photograph of a lava field is taken that way. EV100 15.8 here: the terrain lab has no atmosphere between
 * the sun and the ground and a stand-in sky, and its ground at 15.8 is as bright as the integration lab's
 * (tests/browser/terrain/integrated.spec.ts) at 14.5, the value its own meter finds with the sky in the frame.
 */
const DAYLIGHT_EV = 15.8;

const nadir = (lat: number, lon: number, height: number, heading = 0): View['cam'] => ({ type: 'surface', lat, lon, height, agl: false, heading, pitch: -89.9 });

export const VIEWS: View[] = [
  // ---- Earth
  { name: 'earth-400000km', body: 'earth', cam: nadir(12, -150, 400_000e3), fov: 2.25, sun: { subsolar: [8, -118] } },
  { name: 'earth-leo-pacific', body: 'earth', cam: { type: 'surface', lat: 8, lon: -150, height: 400e3, agl: false, heading: 40, pitch: -22 }, sun: { az: 110, el: 48, lat: 8, lon: -150 } },
  { name: 'earth-leo-hawaii', body: 'earth', cam: { type: 'orbitSite', lat: 19.6, lon: -155.5, alt: 0, yaw: 200, pitch: 48, distance: 420e3 }, sun: { az: 105, el: 42, lat: 19.6, lon: -155.5 } },
  { name: 'earth-leo-nadir-day', body: 'earth', cam: { type: 'surface', lat: 36.6, lon: -117.6, height: 250e3, agl: false, heading: 0, pitch: -89.9 }, sun: { az: 120, el: 38, lat: 36.6, lon: -117.6 } },
  { name: 'earth-leo-nadir-day-2', body: 'earth', cam: { type: 'surface', lat: 28.4, lon: 84.1, height: 250e3, agl: false, heading: 0, pitch: -89.9 }, sun: { az: 120, el: 38, lat: 28.4, lon: 84.1 } },
  // A lowland coast with islands, lagoons and lakes (where the water mask and the imagery must agree).
  { name: 'earth-leo-lowland-coast', body: 'earth', cam: { type: 'surface', lat: 25.3, lon: -80.9, height: 200e3, agl: false, heading: 0, pitch: -89.9 }, sun: { az: 120, el: 45, lat: 25.3, lon: -80.9 } },
  { name: 'earth-leo-nadir-night', body: 'earth', cam: { type: 'surface', lat: 44.5, lon: 9.5, height: 250e3, agl: false, heading: 0, pitch: -89.9 }, sun: { az: 300, el: -40, lat: 44.5, lon: 9.5 }, ev: 1 },
  { name: 'earth-night-side', body: 'earth', cam: nadir(38, 12, 16_000e3), fov: 40, sun: { subsolar: [-38, -168] }, ev: 1 },
  { name: 'earth-40km', body: 'earth', cam: { type: 'surface', ...PAD, height: 40e3, agl: false, heading: 330, pitch: -35 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'earth-10km', body: 'earth', cam: { type: 'surface', ...PAD, height: 10e3, agl: false, heading: 340, pitch: -25 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'pad-inland', body: 'earth', cam: { type: 'surface', lat: PAD.lat - 0.0004, lon: PAD.lon + 0.0003, height: 1.7, agl: true, heading: 2, pitch: 2 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'pad-coast', body: 'earth', cam: { type: 'surface', lat: PAD.lat - 0.0002, lon: PAD.lon + 0.0004, height: 1.7, agl: true, heading: 62, pitch: -1 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  // The ground around the pad at the distances a launch shows it: on the apron looking down, off the apron
  // at eye height, from 30 m, and from 1 km (the detail layers carry the texture, the imagery the colour).
  { name: 'pad-apron-down', body: 'earth', cam: { type: 'surface', lat: PAD.lat - 0.0003, lon: PAD.lon + 0.0003, height: 1.7, agl: true, heading: 300, pitch: -30 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'pad-off-apron', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, height: 1.7, agl: true, heading: 20, pitch: -12 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'pad-ground-close', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, height: 1.7, agl: true, heading: 20, pitch: -50 }, fov: 35, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'pad-30m', body: 'earth', cam: { type: 'surface', lat: PAD.lat - 0.0016, lon: PAD.lon - 0.0012, height: 30, agl: true, heading: 40, pitch: -22 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  // What stands up from the ground (ground cover) where the land cover says grass and trees, 500 to 700 m
  // north-east and north of the pad: at eye height, and the same thickets from 120 m up.
  { name: 'grass-eye', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.0041, lon: PAD.lon + 0.0052, height: 1.7, agl: true, heading: 320, pitch: -5 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'kiawe-eye', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.0062, lon: PAD.lon + 0.0005, height: 1.7, agl: true, heading: 70, pitch: -3 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'kiawe-120m', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.0035, lon: PAD.lon - 0.001, height: 120, agl: true, heading: 15, pitch: -24 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'earth-1km', body: 'earth', cam: { type: 'surface', lat: PAD.lat - 0.004, lon: PAD.lon - 0.004, height: 1000, agl: false, heading: 45, pitch: -35 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  // Broken, stony ground 1 km south-west of the pad at eye height: relief of the height function under the
  // detail layers, and the rock field (the pad's own surroundings are flattened and hold no rocks).
  { name: 'earth-stony-ground', body: 'earth', cam: { type: 'surface', lat: 18.981197, lon: -155.609964, height: 1.7, agl: true, heading: 200, pitch: -8 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'shoreline-200m', body: 'earth', cam: { type: 'surface', lat: PAD.lat + 0.001, lon: PAD.lon + 0.0085, height: 200, agl: false, heading: 30, pitch: -20 }, sun: { az: 105, el: 31, ...PAD }, ev: DAYLIGHT_EV },
  { name: 'earth-edge-5km', body: 'earth', cam: { type: 'surface', lat: 19.93, lon: -155.72, height: 6.2e3, agl: false, heading: 0, pitch: -28 }, sun: { az: 110, el: 35, lat: 20, lon: -155.72 }, ev: DAYLIGHT_EV },
  { name: 'earth-edge-50km', body: 'earth', cam: { type: 'surface', lat: 19.55, lon: -155.72, height: 50e3, agl: false, heading: 0, pitch: -42 }, sun: { az: 110, el: 35, lat: 20, lon: -155.72 }, ev: DAYLIGHT_EV },
  // ---- Moon
  { name: 'moon-60000km', body: 'moon', cam: nadir(2, 5, 60_000e3), fov: 3.7, sun: { subsolar: [3, 9] } },
  { name: 'moon-terminator-20000km', body: 'moon', cam: nadir(-18, 8, 20_000e3), fov: 4.4, sun: { subsolar: [0, 96] } },
  { name: 'moon-terminator-5000km', body: 'moon', cam: nadir(-38, 4, 5_000e3), fov: 16, sun: { subsolar: [0, 93] } },
  { name: 'moon-orbit-100km', body: 'moon', cam: { type: 'surface', lat: 1.5, lon: 21.5, height: 100e3, agl: false, heading: 80, pitch: -30 }, sun: { az: 92, el: 10, lat: 0.66, lon: 23.44 } },
  { name: 'moon-2km', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 2000, agl: true, heading: 280, pitch: -35 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-300m', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 300, agl: true, heading: 285, pitch: -30 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-50m', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 50, agl: true, heading: 290, pitch: -25 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-standing', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 1.7, agl: true, heading: 250, pitch: -6 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-standing-upsun', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 1.7, agl: true, heading: 40, pitch: -8 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-standing-down', body: 'moon', cam: { type: 'surface', ...LUNAR_SITE, height: 1.7, agl: true, heading: 150, pitch: -25 }, sun: { az: 92, el: 11, ...LUNAR_SITE } },
  { name: 'moon-edge-5km', body: 'moon', cam: { type: 'surface', lat: 0.66, lon: 23.3, height: 5e3 - 1900, agl: false, heading: 90, pitch: -40 }, sun: { az: 92, el: 14, ...LUNAR_SITE } },
  { name: 'moon-edge-50km', body: 'moon', cam: { type: 'surface', lat: 0.3, lon: 22.8, height: 50e3, agl: false, heading: 60, pitch: -50 }, sun: { az: 92, el: 14, ...LUNAR_SITE } },
];

export const viewByName = (name: string): View => {
  const v = VIEWS.find((x) => x.name === name);
  if (!v) throw new Error(`unknown view "${name}"`);
  return v;
};

/** Lab URL of a view (camera and sun by query string). */
export function viewUrl(v: View, extra: Query = {}): string {
  const q: Query = { scene: v.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1 };
  const c = v.cam;
  if (c.type === 'surface') {
    Object.assign(q, { body: v.body, lat: c.lat, lon: c.lon, heading: c.heading, pitch: c.pitch });
    if (c.agl) q.agl = c.height;
    else q.alt = c.height;
  } else if (c.type === 'orbitBody') {
    Object.assign(q, { orbit: `${c.yaw},${c.pitch},${c.distance}`, target: `body:${v.body}` });
  } else {
    Object.assign(q, { orbit: `${c.yaw},${c.pitch},${c.distance}`, target: `site:${v.body},${c.lat},${c.lon},${c.alt}` });
  }
  if (v.fov) q.fov = v.fov;
  if ('subsolar' in v.sun) q.subsolar = v.sun.subsolar.join(',');
  else q.sun = `${v.sun.az},${v.sun.el}`;
  if (v.ev !== undefined) q.ev = v.ev;
  return labUrl({ ...q, ...extra });
}

/** Put an open lab page into a view (camera, field of view, sun, exposure) without reloading it. */
export async function applyView(page: Page, v: View): Promise<void> {
  await page.evaluate(
    async ({ v }) => {
      const lab = window.__lab!;
      const t = window.__terrain!;
      const deg = Math.PI / 180;
      const c = v.cam;
      if (c.type === 'surface') await t.placeCamera(v.body, c.lat, c.lon, c.height, c.heading, c.pitch, c.agl);
      else if (c.type === 'orbitBody') lab.camera.spec = { type: 'orbit', target: { bodyId: v.body }, yaw: c.yaw * deg, pitch: c.pitch * deg, distance: c.distance };
      else lab.camera.spec = { type: 'orbit', target: { bodyId: v.body, latDeg: c.lat, lonDeg: c.lon, alt: c.alt }, yaw: c.yaw * deg, pitch: c.pitch * deg, distance: c.distance };
      lab.camera.settings.fovY = (v.fov ?? 60) * deg;
      if ('subsolar' in v.sun) t.setSun({ kind: 'subsolar', bodyId: v.body, latDeg: v.sun.subsolar[0], lonDeg: v.sun.subsolar[1] });
      else t.setSun({ kind: 'site', bodyId: v.body, latDeg: v.sun.lat, lonDeg: v.sun.lon, azDeg: v.sun.az, elDeg: v.sun.el });
      lab.renderer.setExposureOverride(v.ev ?? null);
    },
    { v },
  );
}
