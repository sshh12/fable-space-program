/**
 * Crew couches at the shared seat eye points: headrest with wings, back, hip, thigh and shin pans with
 * padded cushions, side rails, attenuator struts to the floor, armrests, a five-point harness lying on the
 * empty couch, and the hand controllers (rotation on the right, translation and throttle on the left) on
 * the couches that have them.
 *
 * Seat frame (SeatFrame): R = right, U = head-up, L = look direction; the back of the couch lies in the
 * plane L = -backOffset behind the eye. Directions in the (U, L) plane are given by an angle beta measured
 * from -U (toward the feet) toward +L: the thigh pan runs at beta = thighDeg from the hip.
 */
import { DEG, v3, type Vec3 } from '@/core/math';
import type { SeatLayoutDef } from '../layout';
import { frameAt, local, type Attr, type Frame } from '../mesh';
import { seatFrames, seatPoint, type CabinContext, type SeatFrame } from './context';

/** Frame at p whose normal faces the occupant (+L); x = -R so that (x, y = U, n = L) is right-handed. */
export const faceL = (p: Vec3, s: SeatFrame): Frame => frameAt(p, v3.neg(s.R), s.U);

/** Unit direction at angle beta (deg) in a seat's (U, L) plane. */
export const seatDir = (s: SeatFrame, betaDeg: number): Vec3 => v3.add(v3.scale(s.U, -Math.cos(betaDeg * DEG)), v3.scale(s.L, Math.sin(betaDeg * DEG)));

export interface CouchPoints {
  hip: Vec3;
  knee: Vec3;
  foot: Vec3;
  thigh: Vec3;
  shin: Vec3;
  /** Outward normals of the thigh and shin pans (toward the occupant). */
  thighN: Vec3;
  shinN: Vec3;
  /** Lateral offsets of the knee and foot toward the cabin centre (R direction, signed). */
  kneeShift: number;
}

export function couchPoints(ctx: CabinContext, s: SeatFrame, cfg: SeatLayoutDef): CouchPoints {
  const c = ctx.layout.couches;
  const hip = seatPoint(s, 0, c.hipU, -c.backOffset);
  const thigh = seatDir(s, cfg.thighDeg);
  const betaShin = cfg.thighDeg - (180 - cfg.kneeDeg);
  const shin = seatDir(s, betaShin);
  // Outboard couches turn their knees toward the centre line.
  const inboard = -Math.sign(s.eye.x) * cfg.kneeShift;
  const knee = v3.add(v3.addScaled(hip, thigh, c.thighLength), v3.scale(s.R, inboard));
  const foot = v3.addScaled(knee, shin, cfg.shinLength);
  return { hip, knee, foot, thigh, shin, thighN: seatDir(s, cfg.thighDeg + 90), shinN: seatDir(s, betaShin + 90), kneeShift: inboard };
}

/**
 * Pillow-shaped cushion over a rectangle of a frame (half sizes hx, hy), crowned by `thick` with soft edges.
 * The shape is smooth in the middle and rolls over at the border, like stitched foam in a cover.
 */
function cushion(ctx: CabinContext, f: Frame, hx: number, hy: number, thick: number, attr: Attr, opts: { dish?: number } = {}): void {
  const n = ctx.detail === 0 ? 18 : 6;
  const dish = opts.dish ?? 0;
  const edge = (x: number): number => {
    const a = Math.abs(x);
    return a < 0.82 ? 1 : Math.sqrt(Math.max(0, 1 - ((a - 0.82) / 0.18) ** 2));
  };
  const remap = (s: number): number => Math.sin((s - 0.5) * Math.PI);
  ctx.b.patch(
    (s, t) => {
      const X = remap(s);
      const Y = remap(t);
      const h = thick * edge(X) * edge(Y) * (1 - dish * (1 - X * X) * 0.5);
      return local(f, X * hx, Y * hy, h);
    },
    n,
    n,
    attr,
    { aoAt: (s, t) => 0.7 + 0.3 * edge(remap(s)) * edge(remap(t)) },
  );
}

/** Rigid pan under a cushion: a thin chamfered plate. */
function pan(ctx: CabinContext, f: Frame, hx: number, hy: number, thick: number): void {
  ctx.b.box({ ...f, o: local(f, 0, 0, -thick / 2) }, hx, hy, thick / 2, Math.min(0.006, thick * 0.4), ctx.m('couchFrame'));
}

export function buildCouches(ctx: CabinContext): void {
  const c = ctx.layout.couches;
  const seats = seatFrames(ctx.def);
  const b = ctx.b;
  const d = ctx.detail;
  for (const s of seats) {
    const cfg = c.seats[s.id]!;
    const pts = couchPoints(ctx, s, cfg);
    const hw = cfg.halfWidth;
    const cush = ctx.m('cushion');
    const backPlane = -c.backOffset;
    // ---- headrest (centre and two wings)
    const hr = c.headrest;
    const headF = faceL(seatPoint(s, 0, 0.06, backPlane - 0.012), s);
    if (d < 2) cushion(ctx, headF, hr.width / 2, hr.height / 2, hr.depth, cush, { dish: 0.4 });
    pan(ctx, { ...headF, o: local(headF, 0, 0, -0.002) }, hr.width / 2 + 0.008, hr.height / 2 + 0.008, c.pan);
    if (d === 0) {
      for (const side of [-1, 1]) {
        const wing = rotateAboutY(faceL(seatPoint(s, side * (hr.width / 2 + 0.03), 0.06, backPlane + 0.01), s), -side * 35 * DEG);
        cushion(ctx, wing, 0.03, hr.height / 2 - 0.01, 0.035, cush);
      }
    }
    // ---- back cushion with bolsters
    const backTop = -0.07;
    const backBot = c.hipU + 0.03;
    const backF = faceL(seatPoint(s, 0, (backTop + backBot) / 2, backPlane - 0.008), s);
    const backHy = (backTop - backBot) / 2;
    if (d < 2) cushion(ctx, backF, hw - 0.035, backHy, c.cushion, cush, { dish: 0.25 });
    pan(ctx, { ...backF, o: local(backF, 0, 0, -0.002) }, hw + 0.008, backHy + 0.02, c.pan);
    if (d === 0) {
      for (const side of [-1, 1]) cushion(ctx, faceL(local(backF, side * (hw - 0.02), 0, 0.004), s), 0.03, backHy - 0.02, c.cushion + 0.025, cush);
    }
    ctx.proxy(backF, [hw, backHy, 0.05], 0.12);
    // ---- hip (seat) cushion bridging back and thigh pans
    const hipN = v3.normalize(v3.add(s.L, pts.thighN));
    const hipFrame: Frame = { o: v3.addScaled(pts.hip, hipN, -0.01), x: s.R, y: v3.normalize(v3.cross(hipN, s.R)), n: hipN };
    if (d < 2) cushion(ctx, hipFrame, hw - 0.04, 0.06, c.cushion * 0.9, cush);
    // ---- thigh and shin pans
    const tMid = v3.lerp(pts.hip, pts.knee, 0.5);
    // The thigh pan runs from the hip to the (possibly inboard-shifted) knee.
    const thighY = v3.normalize(v3.sub(pts.knee, pts.hip));
    const thighNn = v3.normalize(v3.reject(pts.thighN, thighY));
    const thighFs: Frame = { o: v3.addScaled(tMid, thighNn, -0.012), x: v3.cross(thighY, thighNn), y: thighY, n: thighNn };
    const tl = v3.dist(pts.hip, pts.knee) / 2;
    const legHw = cfg.legHalfWidth;
    if (d < 2) cushion(ctx, thighFs, legHw, tl - 0.02, c.cushion * 0.8, cush);
    pan(ctx, { ...thighFs, o: local(thighFs, 0, 0, -0.002) }, legHw + 0.008, tl, c.pan);
    ctx.proxy(thighFs, [legHw, tl, 0.04], 0.12);
    const sMid = v3.lerp(pts.knee, pts.foot, 0.5);
    const shinF: Frame = { o: v3.addScaled(sMid, pts.shinN, -0.012), x: s.R, y: pts.shin, n: pts.shinN };
    const sl = cfg.shinLength / 2;
    if (d < 2) cushion(ctx, shinF, legHw - 0.01, sl - 0.02, c.cushion * 0.7, cush);
    pan(ctx, { ...shinF, o: local(shinF, 0, 0, -0.002) }, legHw, sl, c.pan);
    if (d === 0) {
      // Heel cups and toe strap at the foot end.
      for (const side of [-1, 1]) {
        const heel = { ...shinF, o: local(shinF, side * legHw * 0.5, sl - 0.02, 0.02) };
        b.box(heel, legHw * 0.38, 0.02, 0.025, 0.008, ctx.m('rubber'));
      }
      b.box({ ...shinF, o: local(shinF, 0, sl - 0.06, 0.06) }, legHw - 0.03, 0.022, 0.004, 0.002, ctx.m('webbing'));
    }

    // ---- side rails, cross members and struts
    const rail = ctx.m('couchFrame');
    if (d < 2) {
      for (const side of [-1, 1]) {
        const off = (p: Vec3, half: number, depth: number): Vec3 => v3.add(v3.addScaled(p, s.R, side * (half + 0.02)), v3.scale(s.L, -depth));
        b.tube([off(seatPoint(s, 0, 0.12, backPlane), hw, 0.045), off(seatPoint(s, 0, c.hipU, backPlane), hw, 0.045)], 0.014, d === 0 ? 10 : 6, rail, { caps: true });
        b.tube(
          [off(v3.addScaled(pts.hip, pts.thighN, -0.03), legHw, 0), off(v3.addScaled(pts.knee, pts.thighN, -0.03), legHw, 0), off(v3.addScaled(pts.foot, pts.shinN, -0.03), legHw - 0.01, 0)],
          0.012,
          d === 0 ? 10 : 6,
          rail,
          { caps: true },
        );
      }
    }
    const headCross = [seatPoint(s, -(hw + 0.02), 0.1, backPlane - 0.045), seatPoint(s, hw + 0.02, 0.1, backPlane - 0.045)];
    const hipCross = [seatPoint(s, -(hw + 0.02), c.hipU + 0.05, backPlane - 0.045), seatPoint(s, hw + 0.02, c.hipU + 0.05, backPlane - 0.045)];
    b.tube(headCross, 0.016, 8, rail);
    b.tube(hipCross, 0.016, 8, rail);
    if (d < 2) {
      for (const top of [headCross[0]!, headCross[1]!, hipCross[0]!, hipCross[1]!]) strut(ctx, top, ctx.mould.floorY);
    }

    // ---- armrests and hand controllers
    if (d < 2) {
      for (const k of [0, 1]) {
        const x = cfg.armrests[k]!;
        const p0 = seatPoint(s, x, -0.28, backPlane + 0.07);
        const p1 = seatPoint(s, x, c.hipU + 0.02, backPlane + 0.07);
        const armF = faceL(v3.lerp(p0, p1, 0.5), s);
        b.box(armF, 0.03, v3.dist(p0, p1) / 2, 0.022, 0.012, cush);
        if (d === 0) {
          // Brackets from the rail to the armrest.
          for (const at of [p0, p1]) {
            const base = seatPoint(s, Math.sign(x) * (hw + 0.02), v3.dot(v3.sub(at, s.eye), s.U), backPlane - 0.045);
            b.tube([base, v3.addScaled(at, s.L, -0.02)], 0.009, 8, rail);
          }
        }
      }
    }
    if (cfg.controllers && d === 0) handControllers(ctx, s, cfg);
    if (d === 0) harness(ctx, s, cfg, backF, backHy, pts);
  }
  if (d < 2) pallet(ctx, seats);
}

function rotateAboutY(f: Frame, angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { o: f.o, x: v3.add(v3.scale(f.x, c), v3.scale(f.n, -s)), y: f.y, n: v3.add(v3.scale(f.n, c), v3.scale(f.x, s)) };
}

/** Load-attenuator strut from a couch frame point straight down to the floor. */
function strut(ctx: CabinContext, top: Vec3, floorY: number): void {
  const b = ctx.b;
  const bottom = { x: top.x * 1.04, y: floorY, z: top.z * 1.04 };
  const axis = v3.normalize(v3.sub(top, bottom));
  const len = v3.dist(top, bottom);
  const det = ctx.detail;
  b.cylinder(bottom, axis, 0.024, len * 0.55, det === 0 ? 14 : 8, ctx.m('anodized'));
  b.cylinder(v3.addScaled(bottom, axis, len * 0.55), axis, 0.011, len * 0.45, det === 0 ? 10 : 6, ctx.m('steel'));
  if (det === 0) {
    b.cylinder(bottom, axis, 0.034, 0.02, 14, ctx.m('aluminium'));
    b.box(frameAt(v3.addScaled(top, axis, -0.01), v3.anyOrthogonal(axis), axis), 0.018, 0.02, 0.012, 0.003, ctx.m('aluminium'));
  }
}

/** Transverse pallet beams under the couches, anchored to the wall at both ends. */
function pallet(ctx: CabinContext, seats: SeatFrame[]): void {
  const c = ctx.layout.couches;
  const s = seats[0]!;
  for (const u of [0.1, c.hipU + 0.05]) {
    const p = seatPoint({ ...s, eye: { x: 0, y: s.eye.y, z: s.eye.z } }, 0, u, -c.backOffset - 0.09);
    const r = ctx.mould.innerRadius(p.y);
    const half = Math.sqrt(Math.max(0, r * r - p.z * p.z)) - 0.12;
    const f = frameAt(p, { x: 1, y: 0, z: 0 }, s.U);
    ctx.b.box(f, half, 0.03, 0.025, 0.004, ctx.m('couchFrame'));
    if (ctx.detail === 0) {
      for (const side of [-1, 1]) ctx.b.box(frameAt({ x: side * (half + 0.04), y: p.y, z: p.z }, { x: 1, y: 0, z: 0 }, s.U), 0.04, 0.04, 0.03, 0.004, ctx.m('aluminium'));
    }
  }
}

/** Five-point harness lying on an empty couch: shoulder straps, lap belts, crotch strap and rotary buckle. */
function harness(ctx: CabinContext, s: SeatFrame, cfg: SeatLayoutDef, backF: Frame, backHy: number, pts: CouchPoints): void {
  const c = ctx.layout.couches;
  const web = ctx.m('webbing');
  const b = ctx.b;
  const lift = c.cushion + 0.004;
  const buckle = local(backF, 0, -backHy + 0.1, lift + 0.006);
  const strap = (pathPts: Vec3[], w: number): void => {
    for (let i = 0; i + 1 < pathPts.length; i++) {
      const a = pathPts[i]!;
      const q = pathPts[i + 1]!;
      const dir = v3.normalize(v3.sub(q, a));
      const side = v3.normalize(v3.cross(backF.n, dir));
      const p0 = v3.addScaled(a, side, -w / 2);
      const p1 = v3.addScaled(a, side, w / 2);
      const p2 = v3.addScaled(q, side, w / 2);
      const p3 = v3.addScaled(q, side, -w / 2);
      b.strip(p0, p1, p2, p3, backF.n, dir, web);
    }
  };
  for (const side of [-1, 1]) {
    strap([local(backF, side * 0.1, backHy + 0.02, 0.01), local(backF, side * 0.1, backHy - 0.02, lift), local(backF, side * 0.07, -backHy * 0.2, lift), local(backF, side * 0.02, -backHy + 0.12, lift + 0.003)], 0.045);
    strap([local(backF, side * (cfg.halfWidth - 0.01), -backHy - 0.02, lift - 0.01), local(backF, side * 0.12, -backHy + 0.06, lift), local(backF, side * 0.03, -backHy + 0.09, lift + 0.003)], 0.045);
  }
  strap([v3.addScaled(pts.hip, pts.thighN, c.cushion * 0.9), local(backF, 0, -backHy + 0.05, lift + 0.002)], 0.04);
  const bf = faceL(buckle, s);
  b.cylinder(buckle, backF.n, 0.035, 0.012, 24, ctx.m('steel'));
  b.cylinder(v3.addScaled(buckle, backF.n, 0.012), backF.n, 0.024, 0.006, 20, ctx.m('anodized'));
  b.box({ ...bf, o: local(bf, 0, 0, 0.02) }, 0.016, 0.004, 0.003, 0.001, ctx.m('warning'));
  // Adjusters on the shoulder straps.
  for (const side of [-1, 1]) b.box(faceL(local(backF, side * 0.08, -backHy * 0.1, lift + 0.004), s), 0.026, 0.012, 0.004, 0.002, ctx.m('steel'));
}

/** Rotation hand controller on the right armrest, translation controller and throttle on the left. */
function handControllers(ctx: CabinContext, s: SeatFrame, cfg: SeatLayoutDef): void {
  const c = ctx.layout.couches;
  const b = ctx.b;
  const backPlane = -c.backOffset;
  // ---- RHC: base on the right armrest end, rubber boot, stick and an ergonomic grip
  const rx = cfg.armrests[1]!;
  const rBase = seatPoint(s, rx, -0.36, backPlane + 0.1);
  const baseF = faceL(rBase, s);
  b.box({ ...baseF, o: local(baseF, 0, 0, 0.015) }, 0.042, 0.055, 0.02, 0.008, ctx.m('anodized'));
  const pivot = local(baseF, 0, 0, 0.038);
  const rhc = ctx.control(`rhc:${s.id}`, () => ({ kind: 'rhc', pivot, axis: s.R, binding: 'none', seat: s.id }));
  b.cylinder(local(baseF, 0, 0, 0.034), baseF.n, 0.03, 0.022, 16, ctx.m('rubber'), { radius1: 0.012, caps: 'none' });
  const mov = (extra: Omit<Attr, 'mat'> = {}): ((name: string) => Attr) => (name) => ctx.m(name, { ctl: rhc.index, ...extra });
  const mv = mov();
  b.cylinder(local(baseF, 0, 0, 0.03), baseF.n, 0.008, 0.05, 10, mv('steel'));
  // Grip: a lathe profile tilted slightly forward, with trigger and a hat switch on top.
  const gripBase = local(baseF, 0, 0, 0.075);
  const gripAxis = v3.normalize(v3.add(baseF.n, v3.scale(s.U, 0.25)));
  b.lathe(gripBase, gripAxis, [[0.0, -0.002], [0.019, 0.0], [0.022, 0.02], [0.021, 0.05], [0.024, 0.08], [0.02, 0.1], [0.012, 0.11], [0.0, 0.112]], 18, mv('rubber'), { ref: s.R });
  b.cylinder(v3.addScaled(gripBase, gripAxis, 0.11), gripAxis, 0.005, 0.008, 8, mv('anodized'));
  b.box(frameAt(v3.add(v3.addScaled(gripBase, gripAxis, 0.065), v3.scale(s.U, -0.022)), s.R, gripAxis), 0.006, 0.014, 0.006, 0.002, mv('warning'));
  // ---- THC: T-handle on the left armrest end
  const lx = cfg.armrests[0]!;
  const tBase = seatPoint(s, lx, -0.36, backPlane + 0.1);
  const tF = faceL(tBase, s);
  b.box({ ...tF, o: local(tF, 0, 0, 0.015) }, 0.04, 0.05, 0.02, 0.008, ctx.m('anodized'));
  const thc = ctx.control(`thc:${s.id}`, () => ({ kind: 'thc', pivot: local(tF, 0, 0, 0.035), axis: s.R, binding: 'none', seat: s.id }));
  const tv = (name: string): Attr => ctx.m(name, { ctl: thc.index });
  b.cylinder(local(tF, 0, 0, 0.034), tF.n, 0.009, 0.04, 10, tv('steel'));
  b.cylinder(v3.addScaled(local(tF, 0, 0, 0.08), s.R, -0.045), s.R, 0.012, 0.09, 14, tv('rubber'), { caps: 'both' });
  // ---- throttle quadrant beside the THC
  const qF = frameAt(seatPoint(s, lx - Math.sign(lx) * 0.05, -0.47, backPlane + 0.1), s.U, tF.n);
  b.box({ ...qF, o: local(qF, 0, 0.012, 0) }, 0.05, 0.012, 0.005, 0.002, ctx.m('anodized'));
  const thr = ctx.control(`throttle:${s.id}`, () => ({ kind: 'throttle', pivot: local(qF, -0.04, 0.012, 0), axis: s.R, binding: 'none', seat: s.id }));
  const lever = local(qF, -0.04, 0.06, 0);
  b.tube([local(qF, -0.04, 0.012, 0), lever], 0.005, 8, ctx.m('steel', { ctl: thr.index }));
  b.cylinder(v3.addScaled(lever, s.R, -0.015), s.R, 0.012, 0.03, 14, ctx.m('caution', { ctl: thr.index }));
  ctx.labelQuad(frameAt(seatPoint(s, rx, -0.43, backPlane + 0.13), s.R, v3.neg(s.U)), 0, 0, 0.05, 0.007, 'ROT', 'anodized', { color: 0 });
  ctx.labelQuad(frameAt(seatPoint(s, lx, -0.43, backPlane + 0.13), s.R, v3.neg(s.U)), 0, 0, 0.05, 0.007, 'TRANS', 'anodized', { color: 0 });
}
