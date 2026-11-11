import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import { NEAR_PLANE } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { mat4, quat, v3, type Vec3 } from '@/core/math';
import {
  buildBodyPoses,
  buildProjection,
  buildVesselPoses,
  discVisibleFraction,
  halton,
  jitterSequenceLength,
  lambertSpherePhase,
  planetshineAt,
  shineVisibleFraction,
  sunAt,
  sunVisibilityAt,
  taaJitter,
} from '@/render/core/frame/math';
import { FRAME_UNIFORM_FLOATS, OFFSET, octEncodeUnit } from '@/render/core/frame/uniforms';
import { expandIncludes } from '@/render/core/shaders/library';
import { FRAME_WGSL, SHADOW_SOFTNESS_MAX_M, SHADOW_SOFTNESS_MIN_M, decodeShadowSoftness, encodeShadowSoftness } from '@/render/core/shaders/chunksFrame';
import { f16ToF32, f32ToF16, generateBlueNoise } from '@/render/core/util/gpu';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const camera = (positionRoot: Vec3, q = quat.identity()): CameraState => ({
  mode: 'chase',
  kind: 'external',
  positionRoot,
  qViewToRoot: q,
  fovY: Math.PI / 3,
  insideVesselId: null,
  focusVesselId: null,
  focusBodyId: null,
  exposureCompensation: 0,
  minEv100: null,
  fillLight: 0,
});

describe('TAA jitter', () => {
  it('halton(2, 3) matches the radical inverse', () => {
    expect([1, 2, 3, 4, 5].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125, 0.625]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 12);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 12);
    expect(halton(3, 3)).toBeCloseTo(1 / 9, 12);
  });
  it('is an 8-sample sub-pixel sequence with a small mean, repeating every 8 frames', () => {
    const seq = Array.from({ length: 8 }, (_, i) => taaJitter(i));
    for (const [x, y] of seq) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
    }
    expect(new Set(seq.map((j) => j.join(','))).size).toBe(8);
    expect(Math.abs(seq.reduce((s, j) => s + j[0], 0) / 8)).toBeLessThan(0.07);
    expect(Math.abs(seq.reduce((s, j) => s + j[1], 0) / 8)).toBeLessThan(0.07);
    expect(taaJitter(8)).toEqual(taaJitter(0));
    expect(jitterSequenceLength(1)).toBe(8);
    expect(jitterSequenceLength(0.5)).toBe(32);
  });
  it('is added to clip xy without touching the reversed-Z depth mapping', () => {
    const p = buildProjection(Math.PI / 3, 1920, 1080, [0.25, -0.5]);
    expect(p.jitterNdc[0]).toBeCloseTo(0.5 / 1920, 15);
    expect(p.jitterNdc[1]).toBeCloseTo(1 / 1080, 15);
    const pt = { x: 3, y: -2, z: -40 };
    const a = mat4.transformPoint(p.projUnjittered, pt);
    const b = mat4.transformPoint(p.proj, pt);
    expect(b.x / b.w - a.x / a.w).toBeCloseTo(p.jitterNdc[0], 14);
    expect(b.y / b.w - a.y / a.w).toBeCloseTo(p.jitterNdc[1], 14);
    expect(b.z).toBe(a.z);
    expect(b.w).toBe(a.w);
    expect(a.z / a.w).toBeCloseTo(NEAR_PLANE / 40, 15);
  });
});

describe('camera-relative poses (float64)', () => {
  it('keep sub-millimetre precision 6,371 km and 384,400 km from the origin', () => {
    const sim = createFakeSim(defs, { scene: 'pad' });
    const s0 = sim.snapshot();
    sim.advance(1 / 60);
    const s1 = sim.snapshot();
    const earth1 = s1.bodies.find((b) => b.id === defs.rootBodyId)!;
    const moon1 = s1.bodies.find((b) => defs.bodies[b.id]?.parent === defs.rootBodyId && defs.bodies[b.id]?.gravityRole === 'attractor')!;
    const v1 = s1.vessels[0]!;
    // Camera 12.3456789 m from the vessel, itself about 6,371 km from the origin.
    const offset = { x: 7.1234567, y: -9.7654321, z: 2.3456789 };
    const cam1 = camera(v3.add(v1.rRoot, offset));
    const cam0 = camera(v3.add(s0.vessels[0]!.rRoot, offset));
    const vessels = buildVesselPoses(s1, s0, cam1, cam0);
    expect(v3.len(v1.rRoot)).toBeGreaterThan(6.3e6);
    expect(vessels[0]!.originRelCam.x).toBeCloseTo(-offset.x, 8);
    expect(vessels[0]!.originRelCam.y).toBeCloseTo(-offset.y, 8);
    expect(vessels[0]!.originRelCam.z).toBeCloseTo(-offset.z, 8);
    // The camera rides with the vessel: the previous-frame pose is the same offset (no spurious motion).
    expect(v3.dist(vessels[0]!.prevOriginRelCam, vessels[0]!.originRelCam)).toBeLessThan(1e-8);

    const bodies = buildBodyPoses(s1, s0, cam1, cam0, defs);
    const e = bodies.find((b) => b.id === earth1.id)!;
    const m = bodies.find((b) => b.id === moon1.id)!;
    expect(v3.len(m.centerRelCam)).toBeGreaterThan(3.5e8);
    // cameraFixed reproduces the camera position through the body frame to well below a millimetre.
    const back = v3.add(earth1.rRoot, quat.rotate(e.qFixedToRoot, e.cameraFixed));
    expect(v3.dist(back, cam1.positionRoot)).toBeLessThan(1e-7);
    expect(e.cameraAltitude).toBeCloseTo(v3.dist(cam1.positionRoot, earth1.rRoot) - defs.bodies[earth1.id]!.radius, 6);
    // A point fixed on the ground moves by the body rotation in ROOT axes but is static relative to a
    // camera fixed on the same ground: reconstruct it from current and previous poses.
    const pFixed = quat.rotateInv(earth1.qFixedToRoot, v3.sub(v1.rRoot, earth1.rRoot));
    const now = v3.add(e.centerRelCam, quat.rotate(e.qFixedToRoot, pFixed));
    const prev = v3.add(e.prevCenterRelCam, quat.rotate(e.prevQFixedToRoot, pFixed));
    expect(v3.dist(now, v3.neg(offset))).toBeLessThan(1e-7);
    expect(v3.dist(prev, now)).toBeLessThan(1e-6);
  });
});

describe('sun, eclipses and planetshine', () => {
  let snap: SimSnapshot;
  beforeAll(() => {
    snap = createFakeSim(defs, { scene: 'translunar' }).snapshot();
  });
  it('derives illuminance and angular radius from BodyDef.emission', () => {
    const sun = sunAt(snap.vessels[0]!.rRoot, snap, defs);
    expect(sun.illuminance).toBeGreaterThan(120000);
    expect(sun.illuminance).toBeLessThan(137000);
    expect(sun.angularRadius).toBeGreaterThan(0.0045);
    expect(sun.angularRadius).toBeLessThan(0.0048);
    expect(v3.len(sun.dirRoot)).toBeCloseTo(1, 12);
    expect(sun.bodyId).toBe(snap.starId);
  });
  it('computes the visible fraction of the solar disc exactly', () => {
    const rs = 0.00465;
    expect(discVisibleFraction(rs, 0.01, 0.02)).toBe(1); // apart
    expect(discVisibleFraction(rs, 0.01, 0.001)).toBe(0); // total
    expect(discVisibleFraction(rs, rs / 2, 0)).toBeCloseTo(0.75, 12); // annular
    expect(discVisibleFraction(rs, rs, rs)).toBeCloseTo(1 - (2 * Math.PI / 3 - Math.sqrt(3) / 2) / Math.PI, 9); // equal discs, centre on the rim
    // A horizon (huge occluder) through the disc centre hides half of it; monotonic through the penumbra.
    expect(discVisibleFraction(rs, 1.5, 1.5)).toBeCloseTo(0.5, 9);
    let last = -1;
    for (let d = 1.5 - rs; d <= 1.5 + rs; d += rs / 10) {
      const f = discVisibleFraction(rs, 1.5, d);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    // The straight-edge form joins the lens form where they switch (ro = 40 rs) to a third of a percent.
    const a = discVisibleFraction(rs, 39.999 * rs, 40.2 * rs);
    const b = discVisibleFraction(rs, 40.001 * rs, 40.2 * rs);
    expect(Math.abs(a - b)).toBeLessThan(0.004);
  });
  it('puts a point behind the Earth in shadow and a point in front in full light', () => {
    const earth = snap.bodies.find((b) => b.id === defs.rootBodyId)!;
    const behind = v3.addScaled(earth.rRoot, earth.sunDir, -2e7);
    const front = v3.addScaled(earth.rRoot, earth.sunDir, 2e7);
    expect(sunVisibilityAt(behind, snap, defs)).toBe(0);
    expect(sunVisibilityAt(front, snap, defs)).toBe(1);
    // On the surface at the terminator the body's own horizon cuts the disc in half.
    const side = v3.normalize(v3.cross(earth.sunDir, { x: 0.3, y: 0.5, z: 0.8 }));
    const term = v3.addScaled(earth.rRoot, side, defs.bodies[earth.id]!.radius);
    // (Not exactly 0.5: from the surface the sun is 4e-5 rad off the direction seen from the centre.)
    expect(Math.abs(sunVisibilityAt(term, snap, defs) - 0.5)).toBeLessThan(0.01);
  });
  it('gives about 15 lux of earthshine at the Moon at full Earth (Lambert-sphere phase)', () => {
    expect(lambertSpherePhase(0)).toBeCloseTo(1, 12);
    expect(lambertSpherePhase(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 12);
    expect(lambertSpherePhase(Math.PI)).toBeCloseTo(0, 12);
    const earth = snap.bodies.find((b) => b.id === defs.rootBodyId)!;
    const receiver = v3.addScaled(earth.rRoot, earth.sunDir, 384.4e6); // sees a full Earth
    const shine = planetshineAt(receiver, null, snap, defs).find((s) => s.bodyId === earth.id)!;
    const lux = 0.2126 * shine.illuminance[0] + 0.7152 * shine.illuminance[1] + 0.0722 * shine.illuminance[2];
    expect(lux).toBeGreaterThan(12);
    expect(lux).toBeLessThan(18);
    expect(shine.illuminance[2]).toBeGreaterThan(shine.illuminance[0]); // bluish
    expect(v3.dot(shine.dir, v3.neg(earth.sunDir))).toBeCloseTo(1, 6);
    // New Earth (receiver on the night side axis... seen from the sun side the disc is dark): almost nothing.
    const dark = planetshineAt(v3.addScaled(earth.rRoot, earth.sunDir, -384.4e6), null, snap, defs).find((s) => s.bodyId === earth.id);
    expect(dark ? dark.illuminance[1] : 0).toBeLessThan(0.01);
    // Close to the body the far-field formula is switched off (the environment probe carries the light).
    expect(planetshineAt(v3.addScaled(earth.rRoot, earth.sunDir, 1.5 * 6371e3), null, snap, defs).some((s) => s.bodyId === earth.id)).toBe(false);
  });
  it('hides a shining body behind the others: the Moon under a 200 km orbit\'s horizon lights nothing (request sky-lighting-8)', () => {
    const earth = snap.bodies.find((b) => b.id === defs.rootBodyId)!;
    const moon = snap.bodies.find((b) => b.id !== earth.id && b.id !== snap.starId)!;
    const R = defs.bodies[earth.id]!.radius;
    const u = v3.normalize(v3.sub(moon.rRoot, earth.rRoot));
    const side = v3.normalize(v3.cross(u, { x: 0.3, y: 0.5, z: 0.8 }));
    // A point of a 200 km orbit at angle theta from the sub-Moon point.
    const at = (theta: number): Vec3 => v3.add(earth.rRoot, v3.scale(v3.add(v3.scale(u, Math.cos(theta)), v3.scale(side, Math.sin(theta))), R + 200e3));
    const vis = (theta: number): number => shineVisibleFraction(at(theta), moon.id, snap, defs);
    const elevation = (theta: number): number => {
      const p = at(theta);
      return Math.PI / 2 - v3.angle(v3.sub(p, earth.rRoot), v3.sub(moon.rRoot, p));
    };
    // Moon at the nadir, behind the Earth: nothing.
    expect(vis(Math.PI)).toBe(0);
    // Moon 10 degrees above the local horizontal (the limb is 14.2 degrees below it): all of it.
    let theta = Math.PI / 2 - (10 * Math.PI) / 180;
    for (let i = 0; i < 4; i++) theta += elevation(theta) - (10 * Math.PI) / 180;
    expect(elevation(theta) * (180 / Math.PI)).toBeCloseTo(10, 3);
    expect(vis(theta)).toBe(1);
    // The Moon's centre on the limb: half of it. Bisection for the angle where the centre touches the limb.
    let lo = Math.PI / 2;
    let hi = Math.PI;
    const onLimb = (t: number): number => {
      const p = at(t);
      const toE = v3.sub(earth.rRoot, p);
      return v3.angle(toE, v3.sub(moon.rRoot, p)) - Math.asin(R / v3.len(toE));
    };
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (onLimb(mid) > 0) lo = mid;
      else hi = mid;
    }
    expect(vis(lo)).toBeCloseTo(0.5, 2);
    // Monotonic through the setting.
    let last = 2;
    for (let t = lo - 0.01; t <= lo + 0.01; t += 0.0005) {
      const f = vis(t);
      expect(f).toBeLessThanOrEqual(last + 1e-12);
      last = f;
    }
    // planetshineAt: the receiver's own body is evaluated at its centre (excluded as a source) and tested as an
    // occluder from `visibleFrom`; without `visibleFrom` the value of an unoccluded light is unchanged.
    const free = planetshineAt(earth.rRoot, earth.id, snap, defs).find((s) => s.bodyId === moon.id)!;
    expect(free.angularRadius).toBeCloseTo(Math.asin(defs.bodies[moon.id]!.radius / v3.dist(moon.rRoot, earth.rRoot)), 12);
    expect(planetshineAt(earth.rRoot, earth.id, snap, defs, 2, at(Math.PI)).some((s) => s.bodyId === moon.id)).toBe(false);
    expect(planetshineAt(earth.rRoot, earth.id, snap, defs, 2, at(theta)).find((s) => s.bodyId === moon.id)!.illuminance).toEqual(free.illuminance);
    const half = planetshineAt(earth.rRoot, earth.id, snap, defs, 2, at(lo)).find((s) => s.bodyId === moon.id)!;
    expect(half.illuminance[1] / free.illuminance[1]).toBeCloseTo(0.5, 2);
  });
});

describe('shader library and utilities', () => {
  it('expands #include once per chunk, recursively, and reports unknown chunks', () => {
    const chunks = new Map([
      ['a', 'A1\n#include "b"\nA2'],
      ['b', 'B'],
    ]);
    const r = expandIncludes('#include "a"\n  #include "b"\nmain', chunks);
    expect(r.includes).toEqual(['a', 'b']);
    expect(r.code.match(/^B$/gm)).toHaveLength(1);
    expect(r.code.indexOf('A1')).toBeLessThan(r.code.indexOf('B'));
    expect(r.code).toContain('main');
    expect(() => expandIncludes('#include "nope"', chunks, 'x')).toThrow(/unknown shader chunk "nope"/);
  });
  it('the WGSL FrameUniforms struct and the TypeScript packer agree on the size', () => {
    // Every member is a vec4 / mat4x4 / array of such, so the size is the sum of the float counts.
    const struct = FRAME_WGSL.slice(FRAME_WGSL.indexOf('struct FrameUniforms'), FRAME_WGSL.indexOf('@group(0) @binding(0)'));
    let floats = 0;
    for (const line of struct.split('\n')) {
      const m = /^\s*\w+:\s*([\w<>, ]+?),\s*(\/\/.*)?$/.exec(line);
      if (!m) continue;
      const t = m[1]!;
      const arr = /^array<(\w+),\s*(\d+)>$/.exec(t);
      const size = (name: string): number => ({ mat4x4f: 16, vec4f: 4, vec4u: 4, BodyUniform: 64, ShineLight: 8, LightUniform: 16 })[name] ?? NaN;
      floats += arr ? size(arr[1]!) * Number(arr[2]) : size(t);
    }
    expect(floats).toBe(FRAME_UNIFORM_FLOATS);
    expect(OFFSET.bodies).toBe(164);
    // 2768 bytes until the LightUniform gained its shape vector (requests vfx-5, vehicle-pad-2).
    expect(FRAME_UNIFORM_FLOATS * 4).toBe(3024);
  });
  it('packs local lights: spots keep their position in endKind (old copies of the loop see a point), axis octahedral, radius in intensity.a (requests vfx-5, vehicle-pad-2)', () => {
    // The WGSL lightAxisDecode, on the CPU.
    const decode = (e: [number, number]): Vec3 => {
      const a = { x: e[0], y: e[1], z: 1 - Math.abs(e[0]) - Math.abs(e[1]) };
      const t = Math.max(-a.z, 0);
      a.x += a.x >= 0 ? -t : t;
      a.y += a.y >= 0 ? -t : t;
      return v3.normalize(a);
    };
    for (const d of [{ x: 0, y: 0, z: -1 }, { x: 0.3, y: -0.8, z: 0.2 }, { x: -0.1, y: 0.2, z: -0.97 }, { x: 1, y: 0, z: 0 }, { x: -0.5, y: -0.5, z: -0.7 }]) {
      expect(v3.dot(decode(octEncodeUnit(d)), v3.normalize(d))).toBeCloseTo(1, 12);
    }
  });
  it('encodes the shadow softness of terrain pixels (RT4.a) in 5.6 % steps from 1.6 cm to 16 km, 0 = none (request terrain-render-4)', () => {
    expect(encodeShadowSoftness(0)).toBe(0);
    expect(encodeShadowSoftness(0.01)).toBe(0);
    expect(decodeShadowSoftness(0)).toBe(0);
    expect(decodeShadowSoftness(encodeShadowSoftness(SHADOW_SOFTNESS_MIN_M))).toBeCloseTo(SHADOW_SOFTNESS_MIN_M, 9);
    expect(decodeShadowSoftness(encodeShadowSoftness(1e9))).toBeCloseTo(SHADOW_SOFTNESS_MAX_M, 6);
    for (const r of [0.02, 0.1, 1, 7.5, 120, 950, 4000]) {
      const e = encodeShadowSoftness(r);
      expect(Math.round(e * 255)).toBe(e * 255); // on the 8-bit grid
      expect(Math.abs(Math.log(decodeShadowSoftness(e) / r))).toBeLessThan(0.028);
    }
  });
  it('converts half floats both ways', () => {
    for (const v of [0, 1, -1, 0.5, 2, 60000, 1 / 3, 6.1e-5, 0.02]) expect(f16ToF32(f32ToF16(v))).toBeCloseTo(v, v > 100 ? -2 : 3);
    expect(f32ToF16(1)).toBe(0x3c00);
    expect(f32ToF16(1e9)).toBe(0x7c00);
    expect(Number.isNaN(f16ToF32(f32ToF16(NaN)))).toBe(true);
  });
  it('generates a deterministic, uniformly distributed blue-noise tile', () => {
    const a = generateBlueNoise(32, 7);
    const b = generateBlueNoise(32, 7);
    expect(a).toEqual(b);
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += a[i]!;
    expect(sum / (a.length / 4)).toBeGreaterThan(120);
    expect(sum / (a.length / 4)).toBeLessThan(135);
    // Blue noise: neighbouring texels differ much more than in white noise on average.
    let diff = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 31; x++) diff += Math.abs(a[(y * 32 + x) * 4]! - a[(y * 32 + x + 1) * 4]!);
    expect(diff / (32 * 31)).toBeGreaterThan(95);
  });
});
