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
import { buildBvh, bvhRay, type Bvh } from '../bvh';
import type { SeatLayoutDef } from '../layout';
import { frameAt, local, type Attr, type Frame } from '../mesh';
import { FLAG_OVERLAY, seatFrames, seatPoint, type CabinContext, type SeatFrame } from './context';
import { upholsteryHeight } from './quilt';

/** Frame at p whose normal faces the occupant (+L); x = -R so that (x, y = U, n = L) is right-handed. */
export const faceL = (p: Vec3, s: SeatFrame): Frame => frameAt(p, v3.neg(s.R), s.U);

/** Unit direction at angle beta (deg) in a seat's (U, L) plane. */
export const seatDir = (s: SeatFrame, betaDeg: number): Vec3 => v3.add(v3.scale(s.U, -Math.cos(betaDeg * DEG)), v3.scale(s.L, Math.sin(betaDeg * DEG)));

/** Share of a couch's knee shift by which the hip end of its leg trough already stands inboard. */
const HIP_SHARE = 0.15;

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
  // Outboard couches turn their legs toward the centre line: the knee by `kneeShift`, the hip end of the leg
  // trough by a share of it (the cone's wall closes in on the outboard hip).
  const inboard = -Math.sign(s.eye.x) * cfg.kneeShift;
  const hip = seatPoint(s, HIP_SHARE * inboard, c.hipU, -c.backOffset);
  const thigh = seatDir(s, cfg.thighDeg);
  const betaShin = cfg.thighDeg - (180 - cfg.kneeDeg);
  const shin = seatDir(s, betaShin);
  const knee = v3.add(v3.addScaled(hip, thigh, c.thighLength), v3.scale(s.R, (1 - HIP_SHARE) * inboard));
  const foot = v3.addScaled(knee, shin, cfg.shinLength);
  return { hip, knee, foot, thigh, shin, thighN: seatDir(s, cfg.thighDeg + 90), shinN: seatDir(s, betaShin + 90), kneeShift: inboard };
}

/**
 * Upholstered pad over a rectangle of a frame (half sizes hx, hy, thickness `thick` along f.n): a squircle
 * top panel, crowned or dished, the cover rolling over a foam edge into a vertical side panel, and a piping
 * cord sewn into the seam between them. One sheet, meshed on a regular grid of its UNFOLDED cover: the
 * surface coordinates are metric and planar on the top panel and run on by arc length over the roll and
 * down the side, so the fabric's weave has one thread pitch everywhere and follows the panel's cut.
 * `sewn`: the cover is stitched down across the pad every UPHOLSTERY.pitch (channels); the mesh carries the
 * channels' relief and the shader shades it per pixel (cabin/quilt.ts).
 */
function cushion(ctx: CabinContext, f: Frame, hx: number, hy: number, thick: number, attr: Attr, opts: { dish?: number; sewn?: boolean } = {}): void {
  const full = ctx.detail === 0;
  const dish = opts.dish ?? 0;
  const roll = Math.min(thick * 0.6, hx * 0.4, hy * 0.4);
  const ax = hx - roll;
  const ay = hy - roll;
  const p = 5;
  const arc = (Math.PI / 2) * roll;
  const side = Math.max(0, thick - roll);
  const reach = arc + side;
  /** Point of the pad for unfolded cover coordinates (x, y), and the same without the channels' relief. */
  const at = (x: number, y: number): { p: Vec3; base: Vec3; uv: [number, number] } => {
    const rho = (Math.abs(x / ax) ** p + Math.abs(y / ay) ** p) ** (1 / p);
    if (rho <= 1) {
      const crown = 1 - dish * 0.5 * (1 - rho * rho);
      // Channels fade out toward the edge of the top panel, where the cover is pulled over the roll.
      const relief = opts.sewn ? upholsteryHeight(y) * Math.min(1, (1 - rho) * Math.min(ax, ay) / 0.025) : 0;
      return { p: local(f, x, y, thick * crown + relief), base: local(f, x, y, thick * crown), uv: [x, y] };
    }
    // Beyond the top panel: its edge point along the ray from the centre, the outline's normal there, and
    // how far the cover has run past the edge.
    const ex = x / rho;
    const ey = y / rho;
    const gx = (Math.sign(ex) * Math.abs(ex / ax) ** (p - 1)) / ax;
    const gy = (Math.sign(ey) * Math.abs(ey / ay) ** (p - 1)) / ay;
    const gl = Math.hypot(gx, gy) || 1;
    const nx = gx / gl;
    const ny = gy / gl;
    const d = Math.min(reach, Math.hypot(x - ex, y - ey));
    let q: Vec3;
    if (d <= arc) {
      const phi = d / roll;
      q = local(f, ex + nx * roll * Math.sin(phi), ey + ny * roll * Math.sin(phi), thick - roll + roll * Math.cos(phi));
    } else q = local(f, ex + nx * roll, ey + ny * roll, Math.max(0, side - (d - arc)));
    return { p: q, base: q, uv: [x, y] };
  };
  // Grid over the unfolded cover: the top panel plus the roll and the side all round.
  const step = full ? 0.018 : 0.07;
  const lines = (half: number): number[] => {
    const n = Math.max(2, Math.round((2 * half) / step));
    const out = full ? [-half - reach, -half - arc * 0.9, -half - arc * 0.45] : [-half - reach];
    for (let i = 0; i <= n; i++) out.push(-half + (2 * half * i) / n);
    out.push(...(full ? [half + arc * 0.45, half + arc * 0.9, half + reach] : [half + reach]));
    return out;
  };
  const X = lines(ax);
  const Y = lines(ay);
  ctx.b.surface(X.length - 1, Y.length - 1, (i, j) => at(X[i]!, Y[j]!), attr);
  if (!full) return;
  // Piping cord in the seam between the top panel and the side panel.
  const path: Vec3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = ax * Math.sign(c) * Math.abs(c) ** (2 / p);
    const y = ay * Math.sign(sn) * Math.abs(sn) ** (2 / p);
    const gx = (Math.sign(x) * Math.abs(x / ax) ** (p - 1)) / ax;
    const gy = (Math.sign(y) * Math.abs(y / ay) ** (p - 1)) / ay;
    const gl = Math.hypot(gx, gy) || 1;
    path.push(local(f, x + (gx / gl) * roll * 0.72, y + (gy / gl) * roll * 0.72, thick - roll + roll * 0.7));
  }
  ctx.b.tube(path, Math.min(0.0028, roll * 0.25), 6, ctx.m('cushion'));
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
    b.group(`couch:${s.id}`);
    const padStart = b.idx.length;
    const cush = ctx.m('cushion');
    const sewn = ctx.m('cushionSewn');
    const backPlane = -c.backOffset;
    // ---- headrest (centre and two wings)
    const hr = c.headrest;
    const headF = faceL(seatPoint(s, 0, 0.06, backPlane - 0.012), s);
    if (d < 2) cushion(ctx, headF, hr.width / 2, hr.height / 2, hr.depth, cush, { dish: 0.4 });
    pan(ctx, { ...headF, o: local(headF, 0, 0, -0.002) }, hr.width / 2 + 0.005, hr.height / 2 + 0.005, c.pan);
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
    if (d < 2) cushion(ctx, backF, hw - 0.035, backHy, c.cushion, sewn, { dish: 0.25, sewn: true });
    pan(ctx, { ...backF, o: local(backF, 0, 0, -0.002) }, hw + 0.006, backHy + 0.006, c.pan);
    if (d === 0) {
      for (const side of [-1, 1]) cushion(ctx, faceL(local(backF, side * (hw - 0.02), 0, 0.004), s), 0.03, backHy - 0.02, c.cushion + 0.025, cush);
    }
    if (d === 0) ctx.couches.push({ seat: s.id, headrest: local(headF, 0, 0, hr.depth), backCentre: local(backF, 0, 0, c.cushion), backNormal: backF.n });
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
    if (d < 2) cushion(ctx, thighFs, legHw, tl - 0.03, c.cushion * 0.8, sewn, { sewn: true });
    pan(ctx, { ...thighFs, o: local(thighFs, 0, 0, -0.002) }, legHw + 0.005, tl - 0.025, c.pan);
    const sMid = v3.lerp(pts.knee, pts.foot, 0.5);
    const shinF: Frame = { o: v3.addScaled(sMid, pts.shinN, -0.012), x: s.R, y: pts.shin, n: pts.shinN };
    const sl = cfg.shinLength / 2;
    if (d < 2) cushion(ctx, shinF, legHw - 0.01, sl - 0.03, c.cushion * 0.7, sewn, { sewn: true });
    pan(ctx, { ...shinF, o: local(shinF, 0, 0, -0.002) }, legHw - 0.005, sl - 0.025, c.pan);
    if (d === 0) {
      // Heel cups and toe strap at the foot end.
      for (const side of [-1, 1]) {
        const heel = { ...shinF, o: local(shinF, side * legHw * 0.5, sl - 0.02, 0.02) };
        b.box(heel, legHw * 0.38, 0.02, 0.025, 0.008, ctx.m('rubber'));
      }
      b.box({ ...shinF, o: local(shinF, 0, sl - 0.06, 0.06) }, legHw - 0.03, 0.022, 0.004, 0.002, ctx.m('webbing'));
    }

    const padEnd = b.idx.length;
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
    if (d < 2) {
      for (const [at, n, half] of [[pts.hip, pts.thighN, legHw], [pts.knee, pts.thighN, legHw], [pts.foot, pts.shinN, legHw - 0.01]] as [Vec3, Vec3, number][]) {
        const c0 = v3.addScaled(v3.addScaled(at, n, -0.03), s.R, -(half + 0.02));
        b.cylinder(c0, s.R, 0.011, 2 * (half + 0.02), d === 0 ? 10 : 6, rail, { caps: 'none' });
      }
    }
    const headCross = [seatPoint(s, -(hw + 0.02), 0.1, backPlane - 0.045), seatPoint(s, hw + 0.02, 0.1, backPlane - 0.045)];
    const hipCross = [seatPoint(s, -(hw + 0.02), c.hipU + 0.05, backPlane - 0.045), seatPoint(s, hw + 0.02, c.hipU + 0.05, backPlane - 0.045)];
    b.tube(headCross, 0.016, 8, rail, { caps: true });
    b.tube(hipCross, 0.016, 8, rail, { caps: true });
    if (d < 2) {
      // The attenuator struts carry the pallet's beams (under the couch's cross tubes): from the beam's far
      // face to the floor, part of the pallet.
      b.group('couchPallet');
      for (const top of [headCross[0]!, headCross[1]!, hipCross[0]!, hipCross[1]!]) strut(ctx, v3.addScaled(top, s.L, -(PALLET_DROP - 0.045 + PALLET_HALF + 0.003)), ctx.mould.floorY);
      b.group(`couch:${s.id}`);
    }

    // ---- armrests and hand controllers
    if (d < 2) {
      for (const k of [0, 1]) {
        const x = cfg.armrests[k]!;
        const rise = armRise(ctx, cfg, x);
        const p0 = seatPoint(s, x, -0.28, backPlane + 0.07 + rise);
        const p1 = seatPoint(s, x, c.hipU + 0.02, backPlane + 0.07 + rise);
        const armF = faceL(v3.lerp(p0, p1, 0.5), s);
        cushion(ctx, { ...armF, o: local(armF, 0, 0, -0.022) }, 0.03, v3.dist(p0, p1) / 2, 0.044, cush);
        if (d === 0) {
          // Brackets from the rail to the armrest.
          for (const at of [p0, p1]) {
            const base = seatPoint(s, Math.sign(x) * (hw + 0.02), v3.dot(v3.sub(at, s.eye), s.U), backPlane - 0.045);
            b.tube([base, v3.addScaled(at, s.L, -0.02)], 0.009, 8, rail, { caps: true });
          }
        }
      }
    }
    if (cfg.controllers && d === 0) handControllers(ctx, s, cfg);
    if (d === 0) {
      b.group(`harness:${s.id}`);
      harness(ctx, s, cfg, backF, backHy, padSurface(ctx, padStart, padEnd, backF));
    }
  }
  b.group('couchPallet');
  if (d < 2) pallet(ctx, seats);
}

/**
 * How far an arm rest at lateral position x (from the seat's centre line) stands above the usual height:
 * one that lies within the couch's own width sits over the back's bolster, clear of it and of the lap belt
 * that runs across the bolster under it.
 */
function armRise(ctx: CabinContext, cfg: SeatLayoutDef, x: number): number {
  if (Math.abs(x) >= cfg.halfWidth + 0.03) return 0;
  // Bolster top (0.004 + cushion + 0.025 over the back frame's plane, which lies 8 mm behind the back plane)
  // plus the webbing and a finger's clearance, against the arm rest pad's underside at 0.048 over the back plane.
  return 0.004 + ctx.layout.couches.cushion + 0.025 - 0.008 + 0.012 - 0.048;
}

function rotateAboutY(f: Frame, angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { o: f.o, x: v3.add(v3.scale(f.x, c), v3.scale(f.n, -s)), y: f.y, n: v3.add(v3.scale(f.n, c), v3.scale(f.x, s)) };
}

/** Load-attenuator strut from a couch frame point straight down to the floor. */
function strut(ctx: CabinContext, top: Vec3, floorY: number): void {
  const b = ctx.b;
  // (The foot stands a few millimetres proud of the floor on its flange: the leaning tube's rim stays above it.)
  const bottom = { x: top.x * 1.04, y: floorY + 0.004, z: top.z * 1.04 };
  const axis = v3.normalize(v3.sub(top, bottom));
  const len = v3.dist(top, bottom);
  const det = ctx.detail;
  b.cylinder(bottom, axis, 0.024, len * 0.55, det === 0 ? 14 : 8, ctx.m('anodized'));
  b.cylinder(v3.addScaled(bottom, axis, len * 0.55), axis, 0.011, len * 0.45, det === 0 ? 10 : 6, ctx.m('steel'));
  if (det === 0) {
    b.cylinder({ x: bottom.x, y: floorY, z: bottom.z }, { x: 0, y: 1, z: 0 }, 0.036, 0.012, 14, ctx.m('aluminium'));
    b.box(frameAt(v3.addScaled(top, axis, -0.022), v3.anyOrthogonal(axis), axis), 0.018, 0.02, 0.012, 0.003, ctx.m('aluminium'));
  }
}

/** The pallet's beams lie this far behind the couches' back plane (their centre line), and are this thick (half). */
const PALLET_DROP = 0.09;
const PALLET_HALF = 0.025;

/** Transverse pallet beams under the couches, anchored to the wall at both ends. */
function pallet(ctx: CabinContext, seats: SeatFrame[]): void {
  const c = ctx.layout.couches;
  const s = seats[0]!;
  for (const u of [0.1, c.hipU + 0.05]) {
    const p = seatPoint({ ...s, eye: { x: 0, y: s.eye.y, z: s.eye.z } }, 0, u, -c.backOffset - PALLET_DROP);
    const r = ctx.mould.innerRadius(p.y);
    const half = Math.sqrt(Math.max(0, r * r - p.z * p.z)) - 0.12;
    const f = frameAt(p, { x: 1, y: 0, z: 0 }, s.U);
    ctx.b.group('couchPallet');
    ctx.b.box(f, half, 0.03, PALLET_HALF, 0.004, ctx.m('couchFrame'));
    if (ctx.detail === 0) {
      // The end fittings reach through the insulation to the hard points on the wall: mounts.
      ctx.b.group('mount:couchPallet');
      for (const side of [-1, 1]) {
        ctx.b.box(frameAt({ x: side * (half + 0.035), y: p.y, z: p.z }, { x: 1, y: 0, z: 0 }, s.U), 0.035, 0.035, PALLET_HALF, 0.004, ctx.m('aluminium'));
        ctx.b.cylinder({ x: side * (half + 0.07), y: p.y, z: p.z }, { x: side, y: 0, z: 0 }, 0.016, 0.03, 10, ctx.m('steel'));
      }
      ctx.b.group('couchPallet');
    }
  }
}

/**
 * The surface of a couch's pads and pans as built (the builder's triangles from `start` to `end`), as a
 * height over the back frame's plane at frame coordinates (x, y): what a strap laid on the couch rests on
 * (the back cushion and its bolsters, the hip cushion, the head rest), 0 where nothing lies under it.
 */
function padSurface(ctx: CabinContext, start: number, end: number, backF: Frame): (x: number, y: number) => number {
  const b = ctx.b;
  const idx = b.idx.slice(start, end);
  const positions = new Float32Array(b.vertexCount * 3);
  for (const v of new Set(idx)) {
    const p = b.position(v);
    positions.set([p.x, p.y, p.z], v * 3);
  }
  const bvh: Bvh = buildBvh(positions, Uint32Array.from(idx), 0, idx.length, () => 0);
  // (From just above the bolsters: the thigh pad leans over the lower back higher up.)
  const top = 0.12;
  const down = v3.neg(backF.n);
  return (x, y) => {
    const h = bvhRay(bvh, local(backF, x, y, top), down, 0, top + 0.05, false);
    return h ? Math.max(0, top - h.t) : 0;
  };
}

/**
 * Five-point harness lying on an empty couch: shoulder straps, lap belts, crotch strap and a metal rotary
 * buckle. The webbing is a band 1.6 mm thick with rounded edges that lies ON the pads: every few millimetres
 * along its path it is set on the highest surface under it (back cushion, bolsters) plus a little slack, so
 * the crowned and channelled pads never show through it, and it bridges their grooves as webbing does.
 */
function harness(ctx: CabinContext, s: SeatFrame, cfg: SeatLayoutDef, backF: Frame, backHy: number, under: (x: number, y: number) => number): void {
  const c = ctx.layout.couches;
  const hw = cfg.halfWidth;
  const web = ctx.m('webbing', { flags: FLAG_OVERLAY });
  const b = ctx.b;
  const thickW = 0.0016;
  /**
   * A strap along a path of (x, y) frame coordinates, laid on the pads. Webbing does not turn a corner in its
   * own plane: the path's corners are rounded off (three rounds of corner cutting), the band is resampled
   * every 6 mm, wanders a few millimetres, lifts off the pad in long soft waves and rolls a little about its
   * own length, as a slack strap lies.
   */
  let strapSeed = 0;
  const strap = (corners: [number, number][], w: number, minLift = 0): void => {
    const seed = ++strapSeed * 1.7 + (s.id.charCodeAt(0) % 7);
    let path = corners;
    for (let round = 0; round < 3 && path.length > 2; round++) {
      const cut: [number, number][] = [path[0]!];
      for (let i = 0; i + 1 < path.length; i++) {
        const [x0, y0] = path[i]!;
        const [x1, y1] = path[i + 1]!;
        if (i > 0) cut.push([x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25]);
        if (i + 2 < path.length) cut.push([x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75]);
      }
      cut.push(path[path.length - 1]!);
      path = cut;
    }
    const xy: [number, number][] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const [x0, y0] = path[i]!;
      const [x1, y1] = path[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.006));
      for (let k = 0; k < n; k++) xy.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
    xy.push(path[path.length - 1]!);
    // The band wanders a little to either side between its ends (never at them: they are sewn down).
    const total = (xy.length - 1) * 0.006;
    const waves = Math.max(1, Math.round(total / 0.13));
    for (let i = 1; i + 1 < xy.length; i++) {
      const t = i / (xy.length - 1);
      const [xa, ya] = xy[i - 1]!;
      const [xb, yb] = xy[i + 1]!;
      const l = Math.hypot(xb - xa, yb - ya) || 1;
      const m = 0.0035 * Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * waves * t * 0.5 + seed);
      xy[i] = [xy[i]![0] - ((yb - ya) / l) * m, xy[i]![1] + ((xb - xa) / l) * m];
    }
    // Its roll about its own length (rad) and its slack: where it stands off the pad in long soft waves.
    const roll = (i: number): number => 0.16 * Math.sin(Math.PI * (i / (xy.length - 1))) * Math.sin(2 * Math.PI * waves * (i / (xy.length - 1)) * 0.7 + 2.1 * seed);
    const slack = (i: number): number => 0.004 * Math.sin(Math.PI * (i / (xy.length - 1))) * (0.5 - 0.5 * Math.cos(2 * Math.PI * waves * (i / (xy.length - 1)) + seed));
    // Height under the band (its middle and both edges), then the band bridges: a running maximum over
    // about two centimetres.
    const raw = xy.map(([x, y], i) => {
      const [xa, ya] = xy[Math.max(0, i - 1)]!;
      const [xb, yb] = xy[Math.min(xy.length - 1, i + 1)]!;
      const l = Math.hypot(xb - xa, yb - ya) || 1;
      const sx = (-(yb - ya) / l) * (w / 2);
      const sy = ((xb - xa) / l) * (w / 2);
      return Math.max(under(x, y), under(x + sx, y + sy), under(x - sx, y - sy), minLift);
    });
    const h = raw.map((_, i) => Math.max(...raw.slice(Math.max(0, i - 2), i + 3)) + 0.0018 + slack(i) + (w / 2) * Math.abs(Math.tan(roll(i))));
    const at = (i: number, j: number): { p: Vec3; uv: [number, number] } => {
      const [x, y] = xy[i]!;
      const [xa, ya] = xy[Math.max(0, i - 1)]!;
      const [xb, yb] = xy[Math.min(xy.length - 1, i + 1)]!;
      const l = Math.hypot(xb - xa, yb - ya) || 1;
      const sx = -(yb - ya) / l;
      const sy = (xb - xa) / l;
      // Cross-section: bottom of the left edge, top left, top right, bottom of the right edge.
      const across = [-0.5, -0.47, 0.47, 0.5][j]! * w;
      const up = (j === 0 || j === 3 ? 0 : thickW) + across * Math.tan(roll(i));
      return { p: local(backF, x + sx * across, y + sy * across, h[i]! + up), uv: [i * 0.006, across + w / 2] };
    };
    b.surface(xy.length - 1, 3, at, web);
  };
  const yb = -backHy;
  for (const side of [-1, 1]) {
    strap([[side * 0.1, backHy + 0.02], [side * 0.1, backHy - 0.02], [side * 0.07, -backHy * 0.2], [side * 0.02, yb + 0.12]], 0.045, 0.01);
    strap([[side * (hw - 0.012), yb + 0.05], [side * 0.12, yb + 0.08], [side * 0.03, yb + 0.1]], 0.045);
  }
  strap([[0, yb + 0.03], [0, yb + 0.07]], 0.04, c.cushion * 0.9);
  // Rotary buckle: a brushed steel body with the four tongues' slots, a turning knob, a red release tab.
  const buckle = local(backF, 0, yb + 0.1, Math.max(under(0, yb + 0.1), under(0.03, yb + 0.1), under(-0.03, yb + 0.1)) + 0.0035);
  const bf = faceL(buckle, s);
  b.lathe(buckle, backF.n, [[0.031, 0], [0.031, 0.006], [0.028, 0.009], [0.021, 0.0095]], 32, ctx.m('steel'));
  for (const k of [0, 1, 2, 3]) {
    const a = (k / 4) * 2 * Math.PI + Math.PI / 4;
    b.box({ ...bf, o: local(bf, Math.cos(a) * 0.029, Math.sin(a) * 0.029, 0.004) }, 0.006, 0.006, 0.0022, 0.001, ctx.m('aluminium'));
  }
  b.lathe(v3.addScaled(buckle, backF.n, 0.0095), backF.n, [[0.02, 0], [0.02, 0.005], [0.017, 0.007], [0, 0.0074]], 28, ctx.m('aluminium'), { ref: bf.x });
  b.box({ ...bf, o: local(bf, 0, 0.012, 0.0172) }, 0.006, 0.0035, 0.0012, 0.0005, ctx.m('warning'));
  // Adjusters on the shoulder straps: a buckle frame round the band.
  for (const side of [-1, 1]) {
    const x = side * 0.083;
    const y = -backHy * 0.1;
    b.box(faceL(local(backF, x, y, under(x, y) + 0.004), s), 0.028, 0.011, 0.0028, 0.0014, ctx.m('steel'));
  }
}

/** Rubber bellows boot over a controller's gimbal: a cone of folds from rBottom to rTop over `height`. */
function bellows(ctx: CabinContext, base: Vec3, axis: Vec3, rBottom: number, rTop: number, height: number, ref: Vec3): void {
  const folds = 6;
  const profile: [number, number][] = [];
  for (let k = 0; k <= folds * 2; k++) {
    const u = k / (folds * 2);
    const r = rBottom + (rTop - rBottom) * u - (k % 2 === 1 ? 0.0028 : 0);
    profile.push([r, u * height]);
  }
  ctx.b.lathe(base, axis, profile, 24, ctx.m('rubber'), { ref });
}

/** Rotation hand controller on the right armrest, translation controller and throttle on the left. */
function handControllers(ctx: CabinContext, s: SeatFrame, cfg: SeatLayoutDef): void {
  const c = ctx.layout.couches;
  const b = ctx.b;
  const backPlane = -c.backOffset;
  // ---- RHC: base on the right armrest end, rubber boot, stick and an ergonomic grip
  const rx = cfg.armrests[1]!;
  const rRise = armRise(ctx, cfg, rx);
  const rBase = seatPoint(s, rx, -0.36, backPlane + 0.1 + rRise);
  const baseF = faceL(rBase, s);
  b.box({ ...baseF, o: local(baseF, 0, 0, 0.015) }, 0.042, 0.055, 0.02, 0.008, ctx.m('anodized'));
  const pivot = local(baseF, 0, 0, 0.038);
  const rhc = ctx.control(`rhc:${s.id}`, () => ({ kind: 'rhc', pivot, axis: s.R, binding: 'none', seat: s.id }));
  bellows(ctx, local(baseF, 0, 0, 0.034), baseF.n, 0.03, 0.012, 0.024, s.R);
  const mov = (extra: Omit<Attr, 'mat'> = {}): ((name: string) => Attr) => (name) => ctx.m(name, { ctl: rhc.index, ...extra });
  const mv = mov();
  b.cylinder(local(baseF, 0, 0, 0.03), baseF.n, 0.008, 0.05, 10, mv('steel'));
  // Grip: sculpted, tilted slightly forward; finger grooves on the front (toward the feet), a palm swell at
  // the back, a pinky flange, the trigger under the index finger, a four-way hat and a thumb button on top.
  const gripBase = local(baseF, 0, 0, 0.075);
  const gripAxis = v3.normalize(v3.add(baseF.n, v3.scale(s.U, 0.25)));
  const front = v3.normalize(v3.reject(v3.neg(s.U), gripAxis));
  const side = v3.cross(gripAxis, front);
  const L = 0.115;
  const gripPoint = (sa: number, t: number): Vec3 => {
    const z = t * L;
    const a = sa * 2 * Math.PI;
    const ca = Math.cos(a);
    const sn = Math.sin(a);
    // Half depth (front-back) and half width, with three finger grooves on the front half.
    const swell = 1 + 0.12 * Math.exp(-(((z - 0.07) / 0.03) ** 2));
    let depth = 0.02 * swell;
    if (ca > 0 && z > 0.018 && z < 0.085) depth -= 0.0026 * ca * (0.5 + 0.5 * Math.cos((2 * Math.PI * (z - 0.018)) / 0.0223));
    const width = 0.0165 * (1 + 0.08 * Math.exp(-(((z - 0.05) / 0.03) ** 2)));
    // Rounded top and a flared base.
    const cap = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1;
    const flare = 1 + 0.25 * Math.exp(-((z / 0.008) ** 2));
    const k = cap * flare;
    return v3.add(v3.addScaled(gripBase, gripAxis, z + 0.004 * ca * Math.min(1, t * 3)), v3.add(v3.scale(front, depth * ca * k), v3.scale(side, width * sn * k)));
  };
  const gh = 1e-3;
  b.patch(gripPoint, 40, 24, mv('rubber'), {
    normalAt: (sa, t) => {
      const tt = Math.min(Math.max(t, 0.02), 0.98);
      return v3.normalize(v3.cross(v3.sub(gripPoint(sa + gh, tt), gripPoint(sa - gh, tt)), v3.sub(gripPoint(sa, tt + gh), gripPoint(sa, tt - gh))));
    },
  });
  // Hat switch (four-way cap on a short stem) and thumb button on the top; trigger under the index finger.
  const top = v3.addScaled(gripBase, gripAxis, L);
  b.cylinder(v3.addScaled(top, gripAxis, -0.004), gripAxis, 0.0055, 0.008, 12, mv('anodized'));
  b.lathe(v3.addScaled(top, gripAxis, 0.004), gripAxis, [[0.0075, 0], [0.0075, 0.0015], [0.006, 0.003], [0, 0.0035]], 16, mv('rubber'), { ref: side });
  b.cylinder(v3.add(v3.addScaled(gripBase, gripAxis, L * 0.86), v3.scale(side, 0.0125)), v3.normalize(v3.add(gripAxis, side)), 0.0042, 0.006, 12, mv('warning'));
  const trig = [0.06, 0.072, 0.083].map((z, k) => v3.add(v3.addScaled(gripBase, gripAxis, z), v3.scale(front, 0.024 + 0.006 * Math.sin((k / 2) * Math.PI))));
  b.tube(trig, 0.0042, 8, mv('anodized'), { caps: true });
  // ---- THC: T-handle on the left armrest end
  const lx = cfg.armrests[0]!;
  const lRise = armRise(ctx, cfg, lx);
  const tBase = seatPoint(s, lx, -0.36, backPlane + 0.1 + lRise);
  const tF = faceL(tBase, s);
  b.box({ ...tF, o: local(tF, 0, 0, 0.015) }, 0.04, 0.05, 0.02, 0.008, ctx.m('anodized'));
  bellows(ctx, local(tF, 0, 0, 0.034), tF.n, 0.026, 0.011, 0.022, s.R);
  const thc = ctx.control(`thc:${s.id}`, () => ({ kind: 'thc', pivot: local(tF, 0, 0, 0.035), axis: s.R, binding: 'none', seat: s.id }));
  const tv = (name: string): Attr => ctx.m(name, { ctl: thc.index });
  b.cylinder(local(tF, 0, 0, 0.034), tF.n, 0.009, 0.046, 10, tv('steel'));
  // Barrel grip across the stem: knurled rubber with rounded ends.
  const barrel: [number, number][] = [];
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    const r = 0.0125 * (0.86 + 0.14 * Math.sin(Math.PI * u)) * Math.sqrt(Math.min(1, Math.min(u, 1 - u) * 14 + 0.02));
    barrel.push([r, u * 0.09]);
  }
  b.lathe(v3.addScaled(local(tF, 0, 0, 0.082), s.R, -0.045), s.R, barrel, 20, tv('knob'), { ref: tF.n });
  // ---- throttle quadrant beside the THC
  const qF = frameAt(seatPoint(s, lx - Math.sign(lx) * 0.05, -0.47, backPlane + 0.1 + lRise), s.U, tF.n);
  b.box({ ...qF, o: local(qF, 0, 0.012, 0) }, 0.05, 0.012, 0.005, 0.002, ctx.m('anodized'));
  const thr = ctx.control(`throttle:${s.id}`, () => ({ kind: 'throttle', pivot: local(qF, -0.04, 0.012, 0), axis: s.R, binding: 'none', seat: s.id }));
  const lever = local(qF, -0.04, 0.06, 0);
  b.tube([local(qF, -0.04, 0.012, 0), lever], 0.005, 8, ctx.m('steel', { ctl: thr.index }));
  b.cylinder(v3.addScaled(lever, s.R, -0.015), s.R, 0.012, 0.03, 14, ctx.m('caution', { ctl: thr.index }));
  ctx.labelQuad(frameAt(seatPoint(s, rx, -0.43, backPlane + 0.13 + rRise), s.R, v3.neg(s.U)), 0, 0, 0.05, 0.007, 'ROT', 'anodized', { color: 0 });
  ctx.labelQuad(frameAt(seatPoint(s, lx, -0.43, backPlane + 0.13 + lRise), s.R, v3.neg(s.U)), 0, 0, 0.05, 0.007, 'TRANS', 'anodized', { color: 0 });
}
