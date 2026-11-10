import { describe, expect, it } from 'vitest';
import { mat4, quat, v3, type Quat, type Vec3 } from '@/core/math';
import {
  CASCADE_RADII,
  CascadeScheduler,
  captureCascade,
  cascadeMatrices,
  lightBasis,
  planCascades,
  type PlanBody,
  type PlanInput,
  type PlanVessel,
} from '@/render/core/shadows/cascadeMath';

const R_EARTH = 6371000;
const R_MOON = 1737400;
const MAP = 2048;

/** A body rotating about +Z at `rate` rad/s, centre at `centre` (ROOT), seen from `camRoot`. */
function body(id: string, radius: number, centreRoot: Vec3, camRoot: Vec3, angle: number, sunDirRoot: Vec3, hasTerrain = true): PlanBody {
  return {
    id,
    radius,
    maxElevation: hasTerrain ? 8850 : 0,
    hasTerrain,
    centerRelCam: v3.sub(centreRoot, camRoot),
    qFixedToRoot: quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, angle),
    sunDirRoot,
  };
}

const sun = v3.normalize({ x: 0.6, y: 0.2, z: 0.77 });
const input = (frame: number, bodies: PlanBody[], vessels: PlanVessel[] = [], insideVesselId: string | null = null): PlanInput => ({
  frame,
  bodies,
  vessels,
  insideVesselId,
  fovY: Math.PI / 3,
  renderHeight: 1440,
  mapSize: MAP,
  sunDirRoot: sun,
});

describe('cascade capture and per-frame matrix re-derivation (float64)', () => {
  it('builds an orthonormal right-handed light basis', () => {
    for (const d of [sun, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }]) {
      const { lx, ly, lz } = lightBasis(v3.normalize(d));
      expect(v3.dot(lx, ly)).toBeCloseTo(0, 12);
      expect(v3.dot(lx, lz)).toBeCloseTo(0, 12);
      expect(v3.len(lx)).toBeCloseTo(1, 12);
      expect(v3.dist(v3.cross(lx, ly), lz)).toBeLessThan(1e-12);
    }
  });

  it('snaps the centre to whole texels in the anchor frame', () => {
    const focus = { x: 5123456.789, y: -3234567.891, z: 1876543.21 };
    const c = captureCascade('cam:0', 'camera', { kind: 'body', id: 'earth' }, focus, sun, 12, MAP, 0);
    expect(c.texelSize).toBeCloseTo(24 / MAP, 15);
    for (const axis of [c.lx, c.ly]) {
      const t = v3.dot(axis, c.center) / c.texelSize;
      expect(Math.abs(t - Math.round(t))).toBeLessThan(1e-4);
    }
    expect(v3.dist(c.center, focus)).toBeLessThan(c.texelSize);
    // Moving the focus by less than half a texel does not move the map at all; moving it by 3.3 texels moves
    // the map by exactly 3 (snapping is relative to the previous capture).
    const c2 = captureCascade('cam:0', 'camera', { kind: 'body', id: 'earth' }, v3.addScaled(c.center, c.lx, 0.3 * c.texelSize), sun, 12, MAP, 1, true, c);
    expect(v3.dist(c2.center, c.center)).toBeLessThan(1e-9);
    const c3 = captureCascade('cam:0', 'camera', { kind: 'body', id: 'earth' }, v3.addScaled(c.center, c.ly, 3.3 * c.texelSize), sun, 12, MAP, 2, true, c2);
    expect(v3.dist(c3.center, v3.addScaled(c.center, c.ly, 3 * c.texelSize))).toBeLessThan(1e-9);
    // A sun that moved by a micro-radian must not re-phase the grid: the centre stays within a hair of a texel node.
    const sun2 = v3.normalize(v3.add(sun, { x: 1e-6, y: -2e-6, z: 0 }));
    const c4 = captureCascade('cam:0', 'camera', { kind: 'body', id: 'earth' }, c.center, sun2, 12, MAP, 3, true, c);
    expect(v3.dist(c4.center, c.center)).toBeLessThan(1e-9);
  });

  it('keeps a stale cascade registered to ground that moves in ROOT axes', () => {
    // Capture at t = 0 around a camera standing on the equator of a rotating Earth; then let 8 frames pass
    // with the body rotating (the ground moves 465 m/s) and the camera flying 7.5 km/s relative to it.
    const spin = 7.2921e-5;
    const groundFixed: Vec3 = { x: R_EARTH, y: 0, z: 0 };
    const q0 = quat.identity();
    const cam0Root = v3.add(groundFixed, { x: 30, y: 0, z: 0 });
    const anchor0 = { originRelCam: v3.neg(cam0Root), q: q0 };
    const sunFixed = quat.rotateInv(q0, sun);
    const focus = quat.rotateInv(q0, cam0Root);
    const cap = captureCascade('cam:4', 'camera', { kind: 'body', id: 'earth' }, focus, sunFixed, 8000, MAP, 0);
    const probeFixed = v3.add(groundFixed, { x: 0, y: 812.5, z: -377.25 }); // a rock on the ground
    const clipOf = (q: Quat, camRoot: Vec3): { x: number; y: number; z: number } => {
      const m = cascadeMatrices(cap, { originRelCam: v3.neg(camRoot), q }).viewProj;
      const pRel = v3.sub(quat.rotate(q, probeFixed), camRoot);
      const c = mat4.transformPoint(m, pRel);
      return { x: c.x, y: c.y, z: c.z };
    };
    const ref = clipOf(q0, cam0Root);
    expect(Math.abs(ref.x)).toBeLessThan(1);
    expect(Math.abs(ref.y)).toBeLessThan(1);
    expect(ref.z).toBeGreaterThan(0);
    expect(ref.z).toBeLessThan(1);
    for (let f = 1; f <= 8; f++) {
      const t = f / 60;
      const q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, spin * t);
      const camRoot = v3.add(quat.rotate(q, v3.add(groundFixed, { x: 30, y: 7500 * t, z: 0 })), { x: 0, y: 0, z: 0 });
      const c = clipOf(q, camRoot);
      // The rock stays on the same shadow texel to a millionth of a texel, although it moved 7.7 m in
      // ROOT axes per second of rotation and the camera moved 1 km.
      expect(Math.abs(c.x - ref.x) * (MAP / 2)).toBeLessThan(1e-6);
      expect(Math.abs(c.y - ref.y) * (MAP / 2)).toBeLessThan(1e-6);
      expect(Math.abs(c.z - ref.z)).toBeLessThan(1e-9);
    }
    // The matrix survives narrowing to float32: translations are small (camera-relative), not planet-sized.
    const m = cascadeMatrices(cap, anchor0).viewProj;
    expect(Math.abs(m[12]!)).toBeLessThan(2);
    expect(Math.abs(m[13]!)).toBeLessThan(2);
    const f32 = new Float32Array(m);
    const pRel = v3.sub(probeFixed, cam0Root);
    const exact = mat4.transformPoint(m, pRel);
    const narrow = mat4.transformPoint(new Float64Array(f32), pRel);
    expect(Math.abs(exact.x - narrow.x) * (MAP / 2)).toBeLessThan(0.01);
    expect(Math.abs(exact.y - narrow.y) * (MAP / 2)).toBeLessThan(0.01);
  });

  it('maps the sun side to depth 0 and returns world axes for the receiver-plane bias', () => {
    const cap = captureCascade('cam:1', 'camera', { kind: 'body', id: 'earth' }, v3.zero(), sun, 60, MAP, 0);
    const m = cascadeMatrices(cap, { originRelCam: v3.zero(), q: quat.identity() });
    const nearSun = mat4.transformPoint(m.viewProj, v3.scale(sun, 100));
    const farSide = mat4.transformPoint(m.viewProj, v3.scale(sun, -100));
    expect(nearSun.z).toBeLessThan(farSide.z);
    expect(mat4.transformPoint(m.viewProj, v3.zero()).z).toBeCloseTo(0.5, 9);
    // +u of the texture is +x of clip space; +v (texture y, down) is -y of clip space.
    const du = mat4.transformPoint(m.viewProj, m.axisURoot);
    const dv = mat4.transformPoint(m.viewProj, m.axisVRoot);
    const o = mat4.transformPoint(m.viewProj, v3.zero());
    expect(du.x - o.x).toBeCloseTo(1 / 60, 9);
    expect(dv.y - o.y).toBeCloseTo(-1 / 60, 9);
    expect(v3.dist(m.lightDirRoot, sun)).toBeLessThan(1e-12);
  });
});

describe('cascade planning', () => {
  const earthAt = (camAlt: number, angle = 0): PlanBody => body('earth', R_EARTH, v3.zero(), { x: R_EARTH + camAlt, y: 0, z: 0 }, angle, sun);
  const moonFar = (camAlt: number): PlanBody => body('moon', R_MOON, { x: 3.844e8, y: 0, z: 0 }, { x: R_EARTH + camAlt, y: 0, z: 0 }, 0, sun);

  it('uses all eight camera cascades on the ground, body-anchored, the nearest two every frame', () => {
    const plan = planCascades(input(0, [earthAt(2), moonFar(2)]));
    expect(plan.map((c) => c.radius)).toEqual([...CASCADE_RADII]);
    expect(plan.every((c) => c.fit === 'camera' && c.anchor.kind === 'body' && c.anchor.id === 'earth')).toBe(true);
    expect(plan.map((c) => c.everyFrame)).toEqual([true, true, false, false, false, false, false, false]);
    expect(plan.map((c) => c.farDistance)).toEqual([...CASCADE_RADII]);
  });

  it('re-renders every frame the cascades that hold a moving vessel, and only those', () => {
    const vessel: PlanVessel = { id: 'v', originRelCam: { x: 0, y: 150, z: 0 }, q: quat.identity(), boundingRadius: 30 };
    const plan = planCascades(input(0, [earthAt(40)], [vessel]));
    // The vessel (30 m radius, 150 m away) reaches into the 300 m cascade: it must be every-frame too.
    expect(plan.find((c) => c.radius === 300)!.everyFrame).toBe(true);
    // The 8 km cascade would see it as a couple of texels: stays staggered.
    expect(plan.find((c) => c.radius === 8000)!.everyFrame).toBe(false);
    expect(plan.filter((c) => c.everyFrame).length).toBeLessThanOrEqual(4);
  });

  it('anchors cascade 0 to the vessel frame for an interior camera', () => {
    const vessel: PlanVessel = { id: 'capsule', originRelCam: { x: 0, y: 0.5, z: 0 }, q: quat.identity(), boundingRadius: 3 };
    const plan = planCascades(input(0, [earthAt(200e3)], [vessel], 'capsule'));
    expect(plan[0]!.anchor).toEqual({ kind: 'vessel', id: 'capsule' });
    expect(plan[0]!.everyFrame).toBe(true);
    expect(plan[1]!.anchor.kind).toBe('body');
  });

  it('drops cascades that reach nothing in low orbit and adds a whole-body cascade for ground beyond 1500 km', () => {
    const plan = planCascades(input(0, [earthAt(200e3)]));
    const cam = plan.filter((c) => c.fit === 'camera').map((c) => c.radius);
    // 12 and 60 m always; nothing between them and the ground 191 km below; then the cascades that reach it.
    expect(cam).toEqual([12, 60, 200000, 1500000]);
    const bodyFit = plan.filter((c) => c.fit === 'body');
    expect(bodyFit).toHaveLength(1);
    expect(bodyFit[0]!.anchor.id).toBe('earth');
    expect(bodyFit[0]!.weight).toBeGreaterThan(0.99);
    expect(bodyFit[0]!.farDistance).toBe(Infinity);
    expect(plan[plan.length - 1]!.fit).toBe('body');
  });

  it('fits a cascade to the sunlit disc of a distant terrain body and hands over continuously on approach', () => {
    // 20,000 km from a Moon-sized body, narrow field of view: the body is large on screen.
    const cam = (alt: number): PlanBody => body('moon', R_MOON, v3.zero(), { x: R_MOON + alt, y: 0, z: 0 }, 0, sun);
    const far = planCascades({ ...input(0, [cam(20e6)]), fovY: (10 * Math.PI) / 180 });
    const fit = far.find((c) => c.fit === 'body')!;
    expect(fit.weight).toBe(1);
    expect(fit.radius).toBeGreaterThan(R_MOON);
    expect((2 * fit.radius) / MAP).toBeLessThan(2000); // about 1.9 km per texel
    expect(far.filter((c) => c.fit === 'camera').map((c) => c.radius)).toEqual([12, 60]);

    // Approach through 1500 km: the body cascade's weight is a continuous function of altitude (no pop),
    // it is still fully present when the first camera cascade starts to reach the ground, and it is gone
    // only once the horizon is well inside the camera cascades.
    let prev = 1;
    let sawPartial = false;
    for (let alt = 3000e3; alt >= 20e3; alt -= 5e3) {
      const p = planCascades(input(0, [cam(alt)]));
      const w = p.find((c) => c.fit === 'body')?.weight ?? 0;
      expect(Math.abs(w - prev)).toBeLessThan(0.08);
      if (w > 0 && w < 1) sawPartial = true;
      if (alt > 1400e3) expect(w).toBe(1);
      prev = w;
    }
    expect(sawPartial).toBe(true);
    expect(prev).toBe(0);
  });

  it('never plans more than eight cascades', () => {
    const vessel: PlanVessel = { id: 'v', originRelCam: { x: 0, y: 100, z: 0 }, q: quat.identity(), boundingRadius: 30 };
    const moonBig = body('moon', R_MOON, { x: R_EARTH + 5e6, y: 0, z: 0 }, { x: R_EARTH + 2, y: 0, z: 0 }, 0, sun);
    const plan = planCascades(input(0, [earthAt(2), moonBig], [vessel]));
    expect(plan.length).toBeLessThanOrEqual(8);
    expect(plan.some((c) => c.key === 'body:moon')).toBe(true);
    expect(plan.slice(0, 4).map((c) => c.radius)).toEqual([12, 60, 300, 1500]);
  });
});

describe('cascade scheduler', () => {
  it('staggers re-rendering, keeps layers stable and re-derives matrices every frame', () => {
    const sched = new CascadeScheduler();
    const spin = 7.2921e-5;
    const renders = new Map<string, number[]>();
    const layers = new Map<string, number>();
    const rockFixed: Vec3 = { x: R_EARTH, y: 3000, z: -1500 };
    const clip = new Map<string, { x: number; y: number }[]>();
    for (let f = 0; f < 64; f++) {
      const angle = spin * (f / 60);
      const q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, angle);
      // Camera fixed to the ground 2 m above the surface (pad scene).
      const camRoot = quat.rotate(q, { x: R_EARTH + 2, y: 0, z: 0 });
      const b = body('earth', R_EARTH, v3.zero(), camRoot, angle, sun);
      const frames = sched.update(input(f, [b]));
      expect(frames).toHaveLength(8);
      for (const c of frames) {
        if (!layers.has(c.desired.key)) layers.set(c.desired.key, c.layer);
        expect(c.layer).toBe(layers.get(c.desired.key));
        if (c.render) renders.set(c.desired.key, [...(renders.get(c.desired.key) ?? []), f]);
        const p = mat4.transformPoint(c.matrices.viewProj, v3.sub(quat.rotate(q, rockFixed), camRoot));
        clip.set(c.desired.key, [...(clip.get(c.desired.key) ?? []), { x: p.x, y: p.y }]);
      }
    }
    expect(new Set(layers.values()).size).toBe(8);
    expect(renders.get('cam:0')).toHaveLength(64);
    expect(renders.get('cam:1')).toHaveLength(64);
    // Staggered: every 2nd, 2nd, 4th, 4th, 8th, 8th frame (plus the first frame for all).
    const count = (k: string): number => renders.get(k)!.length;
    expect(count('cam:2')).toBeGreaterThanOrEqual(32);
    expect(count('cam:2')).toBeLessThanOrEqual(33);
    expect(count('cam:4')).toBeGreaterThanOrEqual(16);
    expect(count('cam:4')).toBeLessThanOrEqual(17);
    expect(count('cam:6')).toBeGreaterThanOrEqual(8);
    expect(count('cam:7')).toBeLessThanOrEqual(9);
    // At most four staggered cascades are drawn in any frame after the first.
    for (let f = 1; f < 64; f++) {
      let n = 0;
      for (const [k, list] of renders) if (k !== 'cam:0' && k !== 'cam:1' && list.includes(f)) n++;
      expect(n).toBeLessThanOrEqual(3);
    }
    // A ground-fixed rock keeps its place in every staggered cascade between re-renders: with a camera
    // that is itself fixed to the ground nothing may move at all (no period-2/4/8 crawl).
    for (const key of ['cam:4', 'cam:5', 'cam:6', 'cam:7']) {
      const pts = clip.get(key)!;
      for (let f = 1; f < pts.length; f++) {
        // The only allowed motion is the real one: the light basis follows the sun, which turns 7.3e-5 rad/s in
        // the body frame, moving the rock (3.4 km from the cascade centre) by that angle times its distance.
        const texel = (2 * CASCADE_RADII[Number(key.slice(4))]!) / MAP;
        const allowed = (spin * (f / 60) * 3400) / texel + 1e-4;
        expect(Math.abs(pts[f]!.x - pts[0]!.x) * (MAP / 2)).toBeLessThan(allowed);
        expect(Math.abs(pts[f]!.y - pts[0]!.y) * (MAP / 2)).toBeLessThan(allowed);
      }
    }
  });

  it('re-captures early when the sun moves in the anchor frame or the camera leaves the centre', () => {
    const sched = new CascadeScheduler();
    const mk = (f: number, camY: number, sunDir: Vec3): number[] => {
      const b = { ...body('earth', R_EARTH, v3.zero(), { x: R_EARTH + 2, y: camY, z: 0 }, 0, sunDir) };
      return sched
        .update(input(f, [b]))
        .filter((c) => c.render)
        .map((c) => c.desired.radius);
    };
    mk(0, 0, sun);
    // Frame 1 would normally draw only cascades 0, 1 and one staggered cascade.
    const normal = mk(1, 0, sun);
    expect(normal.length).toBeLessThanOrEqual(4);
    // The sun jumps by 1 degree (time warp): every cascade is re-captured.
    const turned = v3.normalize(v3.add(sun, { x: 0.02, y: 0, z: 0 }));
    expect(mk(2, 0, turned)).toHaveLength(8);
    // The camera moves 100 m: cascades up to 300 m radius (15 % = 45 m) must follow, big ones need not.
    const moved = mk(4, 100, turned);
    expect(moved).toContain(300);
    expect(moved).not.toContain(1500000);
  });
});
