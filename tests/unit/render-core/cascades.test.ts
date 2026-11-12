import { describe, expect, it } from 'vitest';
import { mat4, quat, v3, type Quat, type Vec3 } from '@/core/math';
import {
  CASCADE_RADII,
  CascadeScheduler,
  bandRadius,
  captureCascade,
  cascadeMatrices,
  lightBasis,
  planCascades,
  receiverBand,
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

  it('bounds the receivers of a ground cascade along v tightly (terrain shell inside the reach of the camera)', () => {
    const rIn = R_MOON - 9130;
    const rOut = R_MOON + 10790;
    for (const [alt, reach, elDeg] of [
      [100e3, 200e3, 14],
      [1000e3, 1500e3, 6],
      [20e3, 40e3, 3],
      [2, 8000, 30],
      [300e3, 1500e3, 80],
    ] as const) {
      const D = R_MOON + alt;
      const focus: Vec3 = { x: D, y: 0, z: 0 };
      const el = (elDeg * Math.PI) / 180;
      const lz = v3.normalize({ x: Math.sin(el), y: Math.cos(el) * 0.8, z: Math.cos(el) * 0.6 });
      const lx = v3.normalize(v3.cross(focus, lz));
      const ly = v3.cross(lz, lx);
      const band = receiverBand(focus, ly, reach, rIn, rOut)!;
      expect(band).not.toBeNull();
      // Brute force over the shell: every point inside the ball lies in the band, and the band is not slack.
      let lo = Infinity;
      let hi = -Infinity;
      const capOf = (rho: number): number => Math.acos(Math.max(-1, Math.min(1, (D * D + rho * rho - reach * reach) / (2 * D * rho))));
      const cap = Math.min(Math.PI, 1.05 * Math.max(capOf(rIn), capOf(R_MOON), capOf(rOut)) + 0.01);
      for (let i = 0; i <= 160; i++) {
        const a = (cap * i) / 160;
        for (let j = 0; j < 96; j++) {
          const phi = (2 * Math.PI * j) / 96;
          const dir: Vec3 = { x: Math.cos(a), y: Math.sin(a) * Math.cos(phi), z: Math.sin(a) * Math.sin(phi) };
          for (let k = 0; k <= 48; k++) {
            const p = v3.scale(dir, rIn + ((rOut - rIn) * k) / 48);
            if (v3.dist(p, focus) > reach) continue;
            const v = v3.dot(ly, v3.sub(p, focus));
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      expect(lo).toBeGreaterThanOrEqual(band.min - 1e-6);
      expect(hi).toBeLessThanOrEqual(band.max + 1e-6);
      expect(lo - band.min).toBeLessThan(0.03 * (band.max - band.min));
      expect(band.max - hi).toBeLessThan(0.03 * (band.max - band.min));
    }
    // A shell the ball does not reach has no receivers.
    expect(receiverBand({ x: R_MOON + 500e3, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 300e3, rIn, rOut)).toBeNull();
    // Ladder of band half widths: radius x 2^(-k / 2), the narrowest step that still holds the band.
    expect(bandRadius(200e3, 250e3)).toBe(200e3);
    expect(bandRadius(200e3, 150e3)).toBe(200e3);
    expect(bandRadius(200e3, 140e3)).toBeCloseTo(200e3 / Math.SQRT2, 6);
    expect(bandRadius(200e3, 65e3)).toBeCloseTo(200e3 * 2 ** -1.5, 6);
    expect(bandRadius(200e3, 1)).toBeCloseTo(200e3 / 16, 6);
  });

  it('captures a band: finer texels along v, centred on the band, snapped per axis', () => {
    const focus: Vec3 = { x: R_MOON + 100e3, y: 0, z: 0 };
    const lz = v3.normalize({ x: 0.24, y: 0.97, z: 0 });
    const lx = v3.normalize(v3.cross(focus, lz));
    const shape = { lx, radiusV: 50e3, centerV: -100e3 };
    const c = captureCascade('cam:6', 'camera', { kind: 'body', id: 'moon' }, focus, lz, 200e3, MAP, 0, true, null, shape);
    expect(c.radiusV).toBe(50e3);
    expect(c.texelSizeV).toBeCloseTo(c.texelSize / 4, 12);
    expect(v3.dist(c.lx, lx)).toBeLessThan(1e-12);
    const m = cascadeMatrices(c, { originRelCam: v3.neg(focus), q: quat.identity() }).viewProj;
    // The band's centre line is clip y = 0 and its edges are y = +-1 (to within the snap of one texel).
    const at = (v: number): number => mat4.transformPoint(m, v3.scale(c.ly, v)).y;
    expect(Math.abs(at(-100e3))).toBeLessThan(2 / MAP);
    expect(at(-50e3)).toBeCloseTo(1, 2);
    expect(at(-150e3)).toBeCloseTo(-1, 2);
    // u is unchanged: +-1 at the cascade radius.
    expect(mat4.transformPoint(m, v3.scale(c.lx, 200e3)).x).toBeCloseTo(1, 2);
    // Re-capture with the camera moved: the centre moves by whole texels of each axis.
    const moved = v3.add(v3.addScaled(c.center, c.ly, -shape.centerV), v3.add(v3.scale(c.lx, 3.4 * c.texelSize), v3.scale(c.ly, 7.4 * c.texelSizeV)));
    const c2 = captureCascade('cam:6', 'camera', { kind: 'body', id: 'moon' }, moved, lz, 200e3, MAP, 1, true, c, shape);
    const d = v3.sub(c2.center, c.center);
    expect(v3.dot(d, c.lx) / c.texelSize).toBeCloseTo(3, 6);
    expect(v3.dot(d, c.ly) / c.texelSizeV).toBeCloseTo(7, 6);
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
    // Inside, cascade 0 is 6 m (0.59 cm texels on a 2048 map) instead of 12 m; the others are unchanged, and
    // so is cascade 0 of an exterior camera next to the same vessel.
    expect(plan[0]!.radius).toBe(6);
    expect(plan[0]!.farDistance).toBe(6);
    expect(plan[1]!.radius).toBe(60);
    expect(plan[1]!.everyFrame).toBe(true);
    const outside = planCascades(input(0, [earthAt(200e3)], [vessel]));
    expect(outside[0]!.radius).toBe(12);
    expect(outside[0]!.anchor.kind).toBe('body');
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
    const texelV = new Map<string, number>();
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
        texelV.set(c.desired.key, c.capture.texelSizeV);
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
        // (Texels along v are finer than along u in a cascade fitted to its receivers: here the 1500 km one.)
        const texel = (2 * CASCADE_RADII[Number(key.slice(4))]!) / MAP;
        const drift = spin * (f / 60) * 3400;
        expect(Math.abs(pts[f]!.x - pts[0]!.x) * (MAP / 2)).toBeLessThan(drift / texel + 1e-4);
        expect(Math.abs(pts[f]!.y - pts[0]!.y) * (MAP / 2)).toBeLessThan(drift / texelV.get(key)! + 1e-4);
      }
    }
    expect(texelV.get('cam:4')).toBe((2 * 8000) / MAP); // relief as large as the cascade: no fit
    expect(texelV.get('cam:7')!).toBeLessThan((2 * 1500000) / MAP / 4); // only the ground inside the horizon needs covering
  });

  it('after a reset the same frame gives the same captures whatever came before (frame-exact capture, request lead-3)', () => {
    const spin = 7.2921e-5;
    const at = (f: number): PlanInput => {
      const angle = spin * (f / 60);
      const q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, angle);
      return input(f, [body('earth', R_EARTH, v3.zero(), quat.rotate(q, { x: R_EARTH + 2, y: 0, z: 0 }), angle, sun)]);
    };
    const summary = (frames: ReturnType<CascadeScheduler['update']>): string =>
      JSON.stringify(frames.map((c) => ({ key: c.desired.key, layer: c.layer, render: c.render, focus: c.capture.focus, lz: c.capture.lz, texel: c.capture.texelSize, viewProj: [...c.matrices.viewProj] })));
    // One scheduler has a history (37 frames, then a camera 300 m away for a while), the other has none; both
    // are reset and then run the same eight frames from an aligned frame index.
    const used = new CascadeScheduler();
    for (let f = 0; f < 37; f++) used.update(at(f));
    for (let f = 37; f < 50; f++) used.update(input(f, [body('earth', R_EARTH, v3.zero(), { x: R_EARTH + 300, y: 40, z: 0 }, 0, sun)]));
    const fresh = new CascadeScheduler();
    used.reset();
    fresh.reset();
    for (let k = 0; k < 8; k++) {
      const a = used.update({ ...at(120), frame: 8192 + k });
      const b = fresh.update({ ...at(120), frame: 4096 + k });
      expect(summary(a)).toBe(summary(b));
      // The first frame after a reset renders every cascade, as the first frame of a session does.
      if (k === 0) expect(a.every((c) => c.render)).toBe(true);
    }
  });

  it('fits staggered cascades to the ground they shadow at low sun, covering every receiver, with a stable grid', () => {
    // Low lunar orbit: 100 km above a Moon-sized body with the sun 14 deg above the horizon below the camera,
    // flying 1.6 km/s. The 200 km cascade must become a band along v (finer texels along the light).
    const el = (14 * Math.PI) / 180;
    const sunLow = v3.normalize({ x: Math.sin(el), y: Math.cos(el), z: 0 });
    const moon = (camRoot: Vec3, sunDir: Vec3): PlanBody => ({ id: 'moon', radius: R_MOON, maxElevation: 10790, minElevation: -9130, hasTerrain: true, centerRelCam: v3.neg(camRoot), qFixedToRoot: quat.identity(), sunDirRoot: sunDir });
    const sched = new CascadeScheduler();
    const D = R_MOON + 100e3;
    const camAt = (f: number): Vec3 => {
      const a = (1600 * (f / 60)) / D;
      return { x: D * Math.cos(a), y: 0, z: D * Math.sin(a) };
    };
    const rock: Vec3 = v3.scale(v3.normalize({ x: 1, y: 0.02, z: 0.03 }), R_MOON); // on the ground, 62 km from the sub-camera point
    let renders = 0;
    let radiusV = 0;
    let lastClip: { x: number; y: number } | null = null;
    for (let f = 0; f < 96; f++) {
      const cam = camAt(f);
      const frames = sched.update({ ...input(f, [moon(cam, sunLow)]), sunDirRoot: sunLow });
      const c = frames.find((x) => x.desired.key === 'cam:6')!;
      expect(c.desired.everyFrame).toBe(false);
      if (c.render) renders++;
      // A band three ladder steps narrower than the square: 2.8 times finer along v.
      expect(c.capture.radiusV).toBeCloseTo(200e3 * 2 ** -1.5, 6);
      expect(c.capture.texelSizeV).toBeCloseTo(c.capture.texelSize * 2 ** -1.5, 9);
      if (radiusV) expect(c.capture.radiusV).toBe(radiusV);
      radiusV = c.capture.radiusV;
      // Every piece of ground the cascade is there for (the terrain shell within its reach of the camera) is inside the map.
      for (let k = 0; k < 400; k++) {
        const dir = v3.normalize({ x: 1, y: (((k * 37) % 41) / 20 - 1) * 0.13, z: (((k * 53) % 43) / 21 - 1) * 0.13 });
        const p = v3.scale(dir, R_MOON + [-9130, 0, 10790][k % 3]!);
        if (v3.dist(p, cam) > c.desired.reach) continue;
        const clip = mat4.transformPoint(c.matrices.viewProj, v3.sub(p, cam));
        expect(Math.abs(clip.x)).toBeLessThan(1);
        expect(Math.abs(clip.y)).toBeLessThan(1);
        expect(clip.z).toBeGreaterThan(0);
        expect(clip.z).toBeLessThan(1);
      }
      // The rock moves over the map in whole texels only (re-captures follow the camera on a fixed grid).
      const rc = mat4.transformPoint(c.matrices.viewProj, v3.sub(rock, cam));
      if (lastClip) {
        for (const d of [(rc.x - lastClip.x) * (MAP / 2), (rc.y - lastClip.y) * (MAP / 2)]) expect(Math.abs(d - Math.round(d))).toBeLessThan(1e-6);
      }
      lastClip = { x: rc.x, y: rc.y };
    }
    // Still staggered (the first of the staggered cascades here: its turn every 2nd frame), not re-captured
    // every frame because the band follows the camera.
    expect(renders).toBeLessThanOrEqual(50);

    // High sun: the ground fills the map, the cascade stays a square around the camera.
    const sunHigh = v3.normalize({ x: Math.sin(1.1), y: Math.cos(1.1), z: 0 });
    const high = new CascadeScheduler().update({ ...input(0, [moon(camAt(0), sunHigh)]), sunDirRoot: sunHigh }).find((x) => x.desired.key === 'cam:6')!;
    expect(high.capture.radiusV).toBe(high.capture.radius);
    expect(v3.dist(high.capture.lx, lightBasis(sunHigh).lx)).toBeLessThan(1e-12);
  });

  it('keeps every receiver covered through a descent at low sun, re-fitting a band rarely and never back and forth', () => {
    // From 300 km down to 3 km above a Moon-sized body in 3000 frames, flying 1.6 km/s along the ground
    // towards the sun, which stands 8 deg above the horizon at the start.
    const el = (8 * Math.PI) / 180;
    const sunLow = v3.normalize({ x: Math.sin(el), y: Math.cos(el), z: 0 });
    const rIn = R_MOON - 9130;
    const rOut = R_MOON + 10790;
    const sched = new CascadeScheduler();
    const history = new Map<string, { radiusV: number; frame: number }[]>();
    let checked = 0;
    for (let f = 0; f < 3000; f++) {
      const alt = 300e3 * (0.01 ** (f / 2999));
      const a = (1600 * (f / 60)) / R_MOON;
      const up: Vec3 = { x: Math.cos(a), y: Math.sin(a), z: 0 };
      const cam = v3.scale(up, R_MOON + alt);
      const moon: PlanBody = { id: 'moon', radius: R_MOON, maxElevation: 10790, minElevation: -9130, hasTerrain: true, centerRelCam: v3.neg(cam), qFixedToRoot: quat.identity(), sunDirRoot: sunLow };
      const frames = sched.update({ ...input(f, [moon]), sunDirRoot: sunLow });
      for (const c of frames) {
        if (c.desired.fit !== 'camera' || c.desired.everyFrame) continue;
        const list = history.get(c.desired.key) ?? [];
        if (list.length === 0 || list[list.length - 1]!.radiusV !== c.capture.radiusV) list.push({ radiusV: c.capture.radiusV, frame: f });
        history.set(c.desired.key, list);
        if (f % 7 !== 0) continue;
        // Ground of every height within the cascade's reach, in a fan around the point below the camera.
        const side = v3.normalize(v3.cross(up, { x: 0, y: 0, z: 1 }));
        for (let k = 0; k < 48; k++) {
          const ang = (c.desired.reach / R_MOON) * 1.2 * ((k % 8) + 1) / 8;
          const az = (2 * Math.PI * (k % 6)) / 6 + k;
          const dir = v3.normalize(v3.add(v3.scale(up, Math.cos(ang)), v3.add(v3.scale(side, Math.sin(ang) * Math.cos(az)), { x: 0, y: 0, z: Math.sin(ang) * Math.sin(az) })));
          const p = v3.scale(dir, [rIn, R_MOON, rOut][k % 3]!);
          // Inside the reach, less the distance the camera may have moved since the capture (the drift limit).
          if (v3.dist(p, cam) > 0.8 * c.desired.reach) continue;
          const clip = mat4.transformPoint(c.matrices.viewProj, v3.sub(p, cam));
          expect(Math.abs(clip.x)).toBeLessThan(1);
          expect(Math.abs(clip.y)).toBeLessThan(1);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20000);
    // The far cascades were bands for at least part of the descent ...
    expect(history.get('cam:7')!.some((h) => h.radiusV < 1500e3 / 2)).toBe(true);
    expect(history.get('cam:6')!.some((h) => h.radiusV < 200e3 / 2)).toBe(true);
    for (const [key, list] of history) {
      // ... each changed its band a handful of times in 50 s, not continuously ...
      expect(list.length, key).toBeLessThan(12);
      // ... and never went back to a band it had just left (no flapping around a threshold).
      for (let i = 2; i < list.length; i++) {
        if (list[i]!.radiusV === list[i - 2]!.radiusV) expect(list[i]!.frame - list[i - 1]!.frame, key).toBeGreaterThan(120);
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
