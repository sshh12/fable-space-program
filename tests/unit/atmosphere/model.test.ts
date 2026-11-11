import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { BodyPose } from '@/core/contracts/render';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { quat } from '@/core/math';
import { channelStd, downsampleVolume, equalise } from '@/render/atmosphere/clouds';
import { CLOUD_PARAM_KEYS, resolveCloudParams } from '@/render/atmosphere/params';
import { distanceToTop, hitsGround, luminanceOf, mediumAt, multiScatter, opticalDepth, referenceAtmosphere, skyRadiance, transmittanceToTop } from '@/render/atmosphere/reference';
import { atmosphereLayers, scissorOf, selectMarchBodies, sphereScreenBounds, type ViewFrustum } from '@/render/atmosphere/select';
import { ATMO_UNIFORM_BYTES, ATMO_UNIFORM_WGSL, AtmoUniforms } from '@/render/atmosphere/uniforms';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const pose = (id: string, center: [number, number, number], altitude: number): BodyPose => ({
  id,
  centerRelCam: { x: center[0], y: center[1], z: center[2] },
  qFixedToRoot: quat.identity(),
  prevCenterRelCam: { x: center[0], y: center[1], z: center[2] },
  prevQFixedToRoot: quat.identity(),
  cameraFixed: { x: -center[0], y: -center[1], z: -center[2] },
  cameraAltitude: altitude,
  sunDir: { x: 1, y: 0, z: 0 },
});

const view: ViewFrustum = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 0, z: -1 }, tanHalfFovX: Math.tan(Math.PI / 6) * (16 / 9), tanHalfFovY: Math.tan(Math.PI / 6) };

describe('atmosphere and cloud definitions of the shipped bodies', () => {
  it('every body with clouds has an atmosphere and tunables that resolve without problems', () => {
    let withClouds = 0;
    for (const b of Object.values(defs.bodies)) {
      if (!b.render.clouds) continue;
      withClouds++;
      expect(b.render.atmosphere, `${b.id}: clouds need an atmosphere`).not.toBeNull();
      const r = resolveCloudParams(b.render.clouds);
      expect(r.problems, b.id).toEqual([]);
      expect(r.params.topAltitude).toBeLessThan(b.render.atmosphere!.topAltitude);
      expect(r.params.bottomAltitude + r.params.lowThicknessM * 1.2).toBeLessThan(r.params.topAltitude);
      // The data file states every tunable explicitly (no silent defaults in shipped content).
      for (const key of CLOUD_PARAM_KEYS) expect(b.render.clouds.params, `${b.id}.clouds.params.${key}`).toHaveProperty(key);
    }
    expect(withClouds).toBeGreaterThan(0);
  });

  it('rejects unknown and invalid tunables with a message', () => {
    const r = resolveCloudParams({ coverageMap: 'c', bottomAltitude: 1000, topAltitude: 9000, params: { lowExtinction: -1, nonsense: 3, shadowMapSize: 1000 } });
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join(' ')).toMatch(/nonsense/);
    expect(r.params.shadowMapSize).toBe(1024);
    expect(resolveCloudParams({ coverageMap: 'c', bottomAltitude: 5000, topAltitude: 4000, params: {} }).problems[0]).toMatch(/empty/);
  });

  it('atmosphere bodies are physically sensible', () => {
    for (const b of Object.values(defs.bodies)) {
      const a = b.render.atmosphere;
      if (!a) continue;
      expect(a.topAltitude).toBeGreaterThan(5 * a.rayleighScaleHeight);
      // Blue scatters more than red.
      expect(a.rayleighScattering[2]).toBeGreaterThan(a.rayleighScattering[0] * 3);
      expect(a.miePhaseG).toBeGreaterThan(0);
      expect(a.miePhaseG).toBeLessThan(1);
      expect(a.groundAlbedo).toBeGreaterThan(0);
      expect(a.groundAlbedo).toBeLessThan(1);
    }
  });
});

describe('uniform block', () => {
  it('WGSL struct and CPU offsets come from one table', () => {
    const fields = [...ATMO_UNIFORM_WGSL.matchAll(/^ {2}(\w+): (vec4f|vec4i),/gm)].map((m) => m[1]!);
    expect(fields.length * 16).toBe(ATMO_UNIFORM_BYTES);
    expect(new Set(fields).size).toBe(fields.length);
    const u = new AtmoUniforms();
    u.set('bodies', 1, -1, 2, 1);
    u.set('steps', 24, 8, 32, 96);
    expect(u.get('bodies')).toEqual([1, -1, 2, 1]);
    expect(u.get('steps')).toEqual([24, 8, 32, 96]);
    // Integer fields are stored as integers: the first field's bytes are 1, -1 as i32.
    expect(new Int32Array(u.buffer, 0, 2)).toEqual(new Int32Array([1, -1]));
    expect(new Float32Array(u.buffer, fields.indexOf('steps') * 16, 1)[0]).toBe(24);
  });
});

describe('body selection', () => {
  it('lists atmosphere bodies as table layers in frame order and ignores airless ones', () => {
    const ids = Object.values(defs.bodies).map((b) => b.id);
    const poses = ids.map((id) => pose(id, [0, 0, -1e9], 1e9));
    const layers = atmosphereLayers(poses, defs, 4);
    const expected = ids.slice(0, 4).filter((id) => defs.bodies[id]!.render.atmosphere);
    expect(layers.map((l) => l.bodyId)).toEqual(expected);
    layers.forEach((l, i) => expect(l.layer).toBe(i));
    for (const l of layers) expect(poses[l.bodyIndex]!.id).toBe(l.bodyId);
  });

  it('marches a body only when its shell reaches into the view, with samples by angular size', () => {
    const body = Object.values(defs.bodies).find((b) => b.render.atmosphere)!;
    const rt = body.radius + body.render.atmosphere!.topAltitude;
    const layers = [{ bodyIndex: 0, layer: 0, bodyId: body.id }];
    const opts = { baseSteps: 24, qualityScale: 1, renderHeight: 1440, fovY: Math.PI / 3 };
    // Standing on it: full screen, full samples.
    const ground = selectMarchBodies(layers, [pose(body.id, [0, -(body.radius + 2), 0], 2)], defs, view, opts);
    expect(ground.bodies).toHaveLength(1);
    expect(ground.bodies[0]!.steps).toBe(24);
    expect(ground.bounds).toEqual([-1, -1, 1, 1]);
    // Behind the camera: not marched at all.
    expect(selectMarchBodies(layers, [pose(body.id, [0, 0, 5e7], 5e7 - body.radius)], defs, view, opts).bodies).toHaveLength(0);
    // In front, 60 radii away: a small disc, fewer samples, a tight rectangle around it.
    const far = selectMarchBodies(layers, [pose(body.id, [0, 0, -60 * body.radius], 59 * body.radius)], defs, view, opts);
    expect(far.bodies[0]!.steps).toBeGreaterThanOrEqual(8);
    expect(far.bodies[0]!.steps).toBeLessThan(24);
    const b = far.bounds!;
    const expectedHalf = Math.tan(Math.asin(rt / (60 * body.radius))) / view.tanHalfFovY;
    expect(b[3]).toBeCloseTo(expectedHalf, 4);
    expect(b[1]).toBeCloseTo(-expectedHalf, 4);
    expect(b[2] - b[0]).toBeLessThan(0.1);
    // The governor scales the samples.
    expect(selectMarchBodies(layers, [pose(body.id, [0, -(body.radius + 2), 0], 2)], defs, view, { ...opts, qualityScale: 0.5 }).bodies[0]!.steps).toBe(12);
    // Too small to matter: under half a pixel.
    expect(selectMarchBodies(layers, [pose(body.id, [0, 0, -1e13], 1e13)], defs, view, opts).bodies).toHaveLength(0);
  });

  it('screen bounds of a sphere are exact tangent bounds', () => {
    // Sphere of radius 1 at distance 2 on the axis: half-angle 30 degrees.
    const b = sphereScreenBounds({ x: 0, y: 0, z: -2 }, 1, view) as [number, number, number, number];
    expect(b[3]).toBeCloseTo(Math.tan(Math.PI / 6) / view.tanHalfFovY, 9);
    expect(sphereScreenBounds({ x: 0, y: 0, z: -0.5 }, 1, view)).toBe('full');
    expect(sphereScreenBounds({ x: 0, y: 0, z: 2 }, 1, view)).toBeNull();
    expect(sphereScreenBounds({ x: 100, y: 0, z: -1 }, 1, view)).toBeNull();
    // Scissor rectangles stay inside the target and include the margin.
    expect(scissorOf([-1, -1, 1, 1], 640, 360, 2)).toEqual([0, 0, 640, 360]);
    const s = scissorOf([-0.1, -0.2, 0.1, 0.2], 1000, 500, 2);
    expect(s).toEqual([448, 198, 104, 104]);
  });
});

describe('cloud noise helpers', () => {
  it('equalise makes any distribution uniform and keeps the order', () => {
    const n = 20000;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = ((Math.sin(i * 12.9898) * 43758.5453) % 1) ** 2 * 0.6 + 0.2;
    for (let i = 0; i < n; i++) v[i] = Math.abs(v[i]!) % 1;
    const before = Float32Array.from(v);
    equalise(v);
    const hist = new Array<number>(10).fill(0);
    for (const x of v) hist[Math.min(9, Math.floor(x * 10))]! += 1 / n;
    for (const h of hist) expect(h).toBeCloseTo(0.1, 1);
    // A threshold at 1 - c selects the fraction c.
    for (const c of [0.1, 0.35, 0.8]) {
      let above = 0;
      for (const x of v) if (x > 1 - c) above++;
      expect(above / n).toBeCloseTo(c, 2);
    }
    // Monotonic: order of any two samples is preserved.
    for (let i = 1; i < 500; i++) {
      if (before[i]! > before[i - 1]! + 1e-3) expect(v[i]!).toBeGreaterThanOrEqual(v[i - 1]!);
    }
  });

  it('downsampling a volume averages 2 x 2 x 2 blocks and lowers the spread', () => {
    const n = 8;
    const src = new Float32Array(n * n * n * 2);
    for (let i = 0; i < n * n * n; i++) {
      src[i * 2] = (i * 7919) % 13 / 12;
      src[i * 2 + 1] = 0.25;
    }
    const half = downsampleVolume(src, n, 2);
    expect(half.length).toBe(4 * 4 * 4 * 2);
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += src[(((k >> 2) * n + ((k >> 1) & 1)) * n + (k & 1)) * 2]!;
    expect(half[0]).toBeCloseTo(sum / 8, 6);
    expect(half[1]).toBeCloseTo(0.25, 6);
    expect(channelStd(half, 2, 0)).toBeLessThan(channelStd(src, 2, 0));
    expect(channelStd(src, 2, 1)).toBeCloseTo(0, 6);
  });
});

describe('reference atmosphere (float64 model)', () => {
  it('reddens the sun at the horizon and barely dims it at the zenith', () => {
    const body = Object.values(defs.bodies).find((b) => b.render.atmosphere)!;
    const a = referenceAtmosphere(body.radius, body.render.atmosphere!);
    const zenith = transmittanceToTop(a, 0, 1);
    expect(zenith[0]).toBeGreaterThan(0.9);
    expect(zenith[2]).toBeGreaterThan(0.6);
    expect(zenith[0]).toBeGreaterThan(zenith[2]);
    const horizon = transmittanceToTop(a, 0, 0.02);
    expect(horizon[0] / Math.max(horizon[2], 1e-12)).toBeGreaterThan(3);
    // Below the horizon: the planet's shadow.
    expect(transmittanceToTop(a, 0, -0.01)).toEqual([0, 0, 0]);
    expect(hitsGround(a, 10000, -0.1)).toBe(true);
    expect(hitsGround(a, 10000, -0.01)).toBe(false);
    expect(distanceToTop(a, 0, 1)).toBeCloseTo(body.render.atmosphere!.topAltitude, 3);
  });

  it('optical depth of the vertical Rayleigh column is beta x scale height', () => {
    const body = Object.values(defs.bodies).find((b) => b.render.atmosphere)!;
    const d = body.render.atmosphere!;
    const a = referenceAtmosphere(body.radius, { ...d, mieScattering: 0, mieAbsorption: 0, ozoneAbsorption: [0, 0, 0] });
    const tau = opticalDepth(a, 0, 1, d.topAltitude, 2000);
    for (let c = 0; c < 3; c++) expect(tau[c]! / (d.rayleighScattering[c]! * d.rayleighScaleHeight)).toBeCloseTo(1, 3);
    expect(mediumAt(a, d.rayleighScaleHeight).scatR[1]).toBeCloseTo(d.rayleighScattering[1] / Math.E, 12);
  });

  it('multi-scattering transfer is positive, grows with the sun and vanishes at night', () => {
    const body = Object.values(defs.bodies).find((b) => b.render.atmosphere)!;
    const a = referenceAtmosphere(body.radius, body.render.atmosphere!);
    const noon = multiScatter(a, 1000, 1, 6, 12);
    const low = multiScatter(a, 1000, 0.1, 6, 12);
    const night = multiScatter(a, 1000, -0.5, 6, 12);
    expect(noon[2]).toBeGreaterThan(0);
    expect(luminanceOf(noon)).toBeGreaterThan(luminanceOf(low));
    expect(luminanceOf(night)).toBe(0);
    // An order-of-magnitude anchor: tenths of a steradian^-1 at noon near the ground.
    expect(luminanceOf(noon)).toBeGreaterThan(0.02);
    expect(luminanceOf(noon)).toBeLessThan(0.5);
  });

  it('clear noon sky: zenith luminance of a few thousand cd/m^2, a brighter horizon, blue', () => {
    const body = Object.values(defs.bodies).find((b) => b.render.atmosphere)!;
    const a = referenceAtmosphere(body.radius, body.render.atmosphere!);
    const sun: [number, number, number] = [1.036 * 128000, 0.994 * 128000, 0.953 * 128000];
    const muS = Math.sin((70 * Math.PI) / 180);
    const ms = (h: number, m: number): [number, number, number] => multiScatter(a, h, m, 4, 8);
    const cache = new Map<string, [number, number, number]>();
    const cached = (h: number, m: number): [number, number, number] => {
      const key = `${Math.round(h / 4000)}:${Math.round(m * 20)}`;
      let v = cache.get(key);
      if (!v) cache.set(key, (v = ms(Math.round(h / 4000) * 4000, Math.round(m * 20) / 20)));
      return v;
    };
    const zenith = skyRadiance(a, 2, 1, muS, muS, sun, { steps: 80, multiScatter: cached });
    const horizon = skyRadiance(a, 2, 0.03, muS, 0.03 * muS, sun, { steps: 120, multiScatter: cached });
    const lz = luminanceOf(zenith.luminance);
    expect(lz).toBeGreaterThan(4000 / 1.5);
    expect(lz).toBeLessThan(8000 * 1.5);
    expect(luminanceOf(horizon.luminance) / lz).toBeGreaterThan(2);
    expect(zenith.luminance[2]).toBeGreaterThan(zenith.luminance[0] * 1.5);
  });
});
