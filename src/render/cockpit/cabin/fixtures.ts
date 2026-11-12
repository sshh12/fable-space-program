/**
 * Cabin fixtures: side panels with circuit breakers and switches, LED floodlights, handholds, stowage
 * lockers, flexible air ducts with diffusers, cable runs with clamps, the fire extinguisher, a
 * flight-data-file pouch, soft stowage bags and a checklist card.
 *
 * Everything is placed on the inner wall from azimuth / y (the layout's `fixtures`). A fixture's BODY stands
 * clear of what lies on the wall under it (insulation blankets, ring frames and stringers, close-out
 * panels: shell.ts skinHeight) and clear of the floor; what carries it reaches through the insulation to the
 * structure: stand-offs, legs, feet, strap ends, clamps and grommets are built as their own `mount:*`
 * assemblies (MeshBuilder.group). The penetration check (penetration.ts) holds every body to that.
 */
import { DEG, v3, type Vec3 } from '@/core/math';
import { frameAt, local, offsetFrame, type Frame } from '../mesh';
import { insideDistance } from '../mould';
import { FLAG_EMISSIVE, FLAG_OVERLAY, seatFrames, type CabinContext } from './context';
import { toggleSwitch } from './console';
import { skinHeight, wallInward, wallPoint } from './shell';

/** Correlated colour temperature -> linear sRGB colour normalised to luminance 1 (Planckian locus fit). */
export function cctColor(k: number): [number, number, number] {
  // Kang et al. chromaticity of the Planckian locus, then xyY -> XYZ -> linear sRGB.
  const t = Math.max(1667, Math.min(25000, k));
  const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = 3.2406 * X - 1.5372 - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 + 1.057 * Z;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [Math.max(0, r / lum), Math.max(0, g / lum), Math.max(0, b / lum)];
}

/**
 * Planar frame on the wall at (az, y), normal into the cabin, text up along the crew's head-up direction:
 * the crew lie across the capsule axis, so "up" on a side panel is toward the dorsal side, not the apex.
 */
export function wallFrame(ctx: CabinContext, azDeg: number, y: number, inset: number): Frame {
  const a = azDeg * DEG;
  const n = wallInward(ctx, a, y);
  const U = seatFrames(ctx.def)[0]!.U;
  let up = v3.reject(U, n);
  if (v3.len(up) < 0.2) up = v3.reject({ x: 0, y: 1, z: 0 }, n);
  up = v3.normalize(up);
  const x = v3.cross(up, n);
  return frameAt(wallPoint(ctx, a, y, inset), x, up);
}

/** Gap (m) left between a fixture's body and the highest thing on the wall under it. */
const SKIN_GAP = 0.003;

/**
 * How far (m) a set of points is short of standing clear of the wall and of what lies on it between the
 * points' own heights (shell.ts skinHeight) by `gap`; 0 or less when they are clear.
 */
function wallDeficit(ctx: CabinContext, pts: Vec3[], gap: number): number {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const need = ctx.def.wallThickness + skinHeight(ctx, y0, y1) + gap;
  let worst = Infinity;
  for (const p of pts) worst = Math.min(worst, insideDistance(ctx.def, p));
  return need - worst;
}

/**
 * Inset (m) of the wall frame at (az, y) whose plate of w x h, reaching `t` behind the frame's plane, stands
 * clear of the wall and of what lies on it (blankets, frames, close-out panels) by `gap`.
 */
export function plateInset(ctx: CabinContext, azDeg: number, y: number, w: number, h: number, t: number, gap = SKIN_GAP): number {
  let inset = t + 0.002;
  for (let k = 0; k < 60; k++) {
    const f = wallFrame(ctx, azDeg, y, inset);
    const pts: Vec3[] = [];
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) pts.push(local(f, (sx * w) / 2, (sy * h) / 2, -t));
    const d = wallDeficit(ctx, pts, gap);
    if (d <= 0) return inset;
    inset += d + 0.0005;
  }
  return inset;
}

/**
 * Wall frame of a fixture of w x h reaching `t` behind the frame's plane, clear of the wall's skins, and
 * moved up the wall until the whole of it stands `floorGap` above the floor.
 */
function seatedFrame(ctx: CabinContext, azDeg: number, y: number, w: number, h: number, t: number, floorGap = 0.02): Frame {
  let yy = y;
  let f = wallFrame(ctx, azDeg, yy, plateInset(ctx, azDeg, yy, w, h, t));
  for (let k = 0; k < 20; k++) {
    let lowest = Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [-t, 0.02]) lowest = Math.min(lowest, local(f, (sx * w) / 2, (sy * h) / 2, z).y);
    const short = ctx.mould.floorY + floorGap - lowest;
    if (short <= 0) break;
    yy += short + 0.002;
    f = wallFrame(ctx, azDeg, yy, plateInset(ctx, azDeg, yy, w, h, t));
  }
  return f;
}

/** A stand-off post (a `mount:` assembly) from a point of a fixture back to the wall along -n of its frame. */
function standoff(ctx: CabinContext, group: string, from: Vec3, n: Vec3, radius: number, mat = 'aluminium'): void {
  const b = ctx.b;
  const keep = b.groupName;
  // (Its end stands a fraction of its radius off the wall: where the post meets the wall off its normal, the
  // rim of a flush end would lie in the wall.)
  const hit = fitWall(ctx, from, v3.neg(n));
  const w = v3.dist(from, hit) > 0.003 ? v3.addScaled(hit, v3.normalize(v3.sub(from, hit)), radius * 0.15) : hit;
  if (v3.dist(from, w) > 0.003) {
    b.group(`mount:${group}`);
    b.cylinder(w, v3.sub(from, w), radius, v3.dist(from, w), 8, ctx.m(mat));
    // Its foot on the wall: a boss (a metal post ends in one, never as a bare tube on the cloth).
    // (A collar a few millimetres off the wall: the wall curves away under a foot this wide, and the post
    // may meet it up to some ten degrees off its normal.)
    if (mat === 'aluminium' && v3.dist(from, w) > 0.012) b.cylinder(v3.addScaled(w, v3.normalize(v3.sub(from, w)), 0.0015 + radius * 0.4), v3.sub(from, w), radius * 1.9, 0.003, 12, ctx.m(mat), { caps: 'top' });
    b.group(keep);
  }
}

export function buildFixtures(ctx: CabinContext): void {
  const L = ctx.layout;
  const b = ctx.b;
  const d = ctx.detail;
  // ---- side panels
  for (const p of L.wallPanels) {
    b.group(`panel:${p.id}`);
    const t = 0.02;
    const f = seatedFrame(ctx, p.azDeg, p.y, p.width, p.height, t);
    b.box(offsetFrame(f, 0, 0, -t / 2), p.width / 2, p.height / 2, t / 2, 0.004, ctx.m('panel'));
    if (d === 2) continue;
    // Standoffs to the wall at the corners.
    if (d === 0) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) standoff(ctx, `panel:${p.id}`, local(f, sx * (p.width / 2 - 0.02), sy * (p.height / 2 - 0.02), -t), f.n, 0.008);
      ctx.labelQuad(f, 0, p.height / 2 - 0.012, Math.min(0.24, p.width * 0.8), 0.009, p.title, 'panel', { color: 0, backlit: true });
      p.breakers.forEach((row, ri) => {
        row.labels.forEach((label, i) => {
          const x = -((row.labels.length - 1) * row.pitch) / 2 + i * row.pitch;
          breaker(ctx, offsetFrame(f, x, row.v, 0), label, `${p.id}:${ri}:${i}`);
        });
      });
      p.switchRows.forEach((row, ri) => {
        row.switches.forEach((sw, i) => {
          const x = -((row.switches.length - 1) * row.pitch) / 2 + i * row.pitch;
          toggleSwitch(ctx, offsetFrame(f, x, row.v, 0), sw, `${p.id}:sw:${ri}:${i}`);
        });
      });
    }
  }
  if (d === 2) return;

  // ---- floodlights: housing off the wall on two posts, diffuser lens facing the aim point
  L.lighting.floods.forEach((fl, i) => {
    b.group(`flood:${i}`);
    const wf = wallFrame(ctx, fl.azDeg, fl.y, plateInset(ctx, fl.azDeg, fl.y, fl.length, 0.06, 0.035));
    const aim = v3.fromTuple(fl.aim);
    const toAim = v3.normalize(v3.sub(aim, wf.o));
    // Lens normal: toward the aim point, tilted within the fixture's swivel range around the wall normal.
    const n = v3.normalize(v3.add(wf.n, v3.scale(v3.reject(toAim, wf.n), 1.2)));
    const along = v3.normalize(v3.reject(wf.x, n));
    const f = clearFrame(ctx, frameAt(wf.o, along, v3.cross(n, along)), fl.length / 2 + 0.03, 0.03, -0.03, 0.008, wf.n);
    const c = ctx.control(`flood:${i}`, () => ({ kind: 'flood', pivot: f.o, axis: f.n, binding: 'lights', flood: i }));
    b.box(offsetFrame(f, 0, 0, -0.012), fl.length / 2 + 0.012, 0.028, 0.014, 0.006, ctx.m('closeout'));
    if (d === 0) {
      b.box(offsetFrame(f, 0, 0, 0.0035), fl.length / 2, 0.018, 0.0035, 0.002, ctx.m('floodLens', { ctl: c.index, flags: FLAG_EMISSIVE }));
      for (const s of [-1, 1]) {
        // (The swivel barrel across each end of the housing, centred on it: it stood out 3 cm to one side,
        // an open tube end beside a stringer.)
        b.cylinder(local(f, s * (fl.length / 2 + 0.018), -0.03, -0.012), f.y, 0.008, 0.06, 10, ctx.m('aluminium'), { caps: 'both' });
        standoff(ctx, `flood:${i}`, local(f, s * (fl.length / 2 - 0.02), 0, -0.024), wf.n, 0.006);
      }
      const p0 = local(f, -fl.length / 2, 0, 0.008);
      const p1 = local(f, fl.length / 2, 0, 0.008);
      ctx.floods.push({ p0, p1, n: f.n, lumens: fl.lumens, color: cctColor(fl.cct), control: c.index });
    }
  });

  if (d > 0) return;
  // ---- handholds: U-shaped rails standing off the wall
  L.fixtures.handholds.forEach(([az, y, len], i) => handhold(ctx, i, az, y, len));

  // ---- stowage lockers on the lower cone
  for (const lk of L.fixtures.lockers) {
    b.group(`locker:${lk.label.slice(0, 2)}`);
    locker(ctx, lk.azDeg, lk.y, lk.width, lk.height, lk.label);
  }

  // ---- air ducts from the floor plenum to diffusers near the couch heads
  for (const side of [-1, 1]) {
    const name = `duct:${side < 0 ? 'left' : 'right'}`;
    const radius = 0.032;
    // (Under the couch pallet's wall fitting and the side window, then up to the diffuser by the couch head.)
    const pathAz = [side * 118, side * 116, side * 112, side * 100, side * 88, side * 80, side * 70, side * 62];
    const ys = [ctx.mould.floorY + 0.012, 0.36, 0.5, 0.6, 0.64, 0.68, 0.9, 1.12];
    // The hose runs over the frames it crosses: its underside clear of the highest thing on the wall along its way.
    const inset = skinHeight(ctx, ys[0]!, ys[ys.length - 1]!) + SKIN_GAP + radius;
    const pts = pathAz.map((az, i) => wallPoint(ctx, az * DEG, ys[i]!, inset));
    // Floor collar: the hose comes up out of the plenum through a flanged ring.
    pts[0] = { x: pts[1]!.x, y: ys[0]!, z: pts[1]!.z };
    b.group(`mount:${name}`);
    b.cylinder({ x: pts[0].x, y: ctx.mould.floorY, z: pts[0].z }, { x: 0, y: 1, z: 0 }, radius + 0.014, 0.008, 32, ctx.m('aluminium'), { caps: 'top' });
    b.cylinder({ x: pts[0].x, y: ctx.mould.floorY + 0.008, z: pts[0].z }, { x: 0, y: 1, z: 0 }, radius + 0.004, 0.03, 32, ctx.m('anodized'), { caps: 'top' });
    b.group(name);
    b.tube(pts, radius, 32, ctx.m('duct'), { caps: false });
    const end = pts[pts.length - 1]!;
    const dir = v3.normalize(v3.sub(end, pts[pts.length - 2]!));
    b.cylinder(end, dir, 0.04, 0.03, 32, ctx.m('closeout'), { radius1: 0.05 });
    b.disc(frameAt(v3.addScaled(end, dir, 0.03), v3.anyOrthogonal(dir), v3.cross(dir, v3.anyOrthogonal(dir))), 0.048, 0.0, 32, ctx.m('grille'), { flip: v3.dot(v3.cross(v3.anyOrthogonal(dir), v3.cross(dir, v3.anyOrthogonal(dir))), dir) < 0 });
    // Hose clamps with a stand-off to the wall at two stations.
    for (const k of [2, 4]) {
      const p = pts[k]!;
      const t = v3.normalize(v3.sub(pts[k + 1]!, pts[k - 1]!));
      b.group(`mount:${name}`);
      b.cylinder(v3.addScaled(p, t, -0.009), t, radius + 0.003, 0.018, 32, ctx.m('steel'), { caps: 'none' });
      const n = wallInward(ctx, pathAz[k]! * DEG, ys[k]!);
      b.cylinder(wallPoint(ctx, pathAz[k]! * DEG, ys[k]!, 0.001), n, 0.007, inset - radius - 0.001, 8, ctx.m('aluminium'));
      b.group(name);
    }
  }

  // ---- cable runs: bundles along the wall, with clamps
  L.fixtures.cables.forEach((run, ri) => {
    const name = `cable:${ri}`;
    const steps = Math.ceil(Math.abs(run.az[1] - run.az[0]) / 4);
    const dAz = (run.az[1] - run.az[0]) / steps;
    // The bundle (a main cable with a thinner one on either side) rides clear of what lies on the wall.
    const inset = skinHeight(ctx, run.y - 0.03, run.y + 0.03) + SKIN_GAP + run.r;
    // Between its clamps (every third step) the bundle hangs a little slack, away from the wall.
    const main: Vec3[] = [];
    for (let k = 0; k <= steps; k++) {
      const az = run.az[0] + dAz * k;
      const slack = Math.sin((Math.PI * ((k + 1) % 3)) / 3);
      main.push(wallPoint(ctx, az * DEG, run.y + 0.006 * Math.sin(k * 1.7), inset + 0.009 * slack));
    }
    b.group(name);
    for (const off of [-0.6, 0.6]) b.tube(main.map((p) => v3.addScaled(p, { x: 0, y: 1, z: 0 }, off * run.r * 1.4)), run.r * 0.7, 12, ctx.m(run.mat));
    b.tube(main, run.r, 16, ctx.m(run.mat));
    // At both ends the bundle turns into the wall through a grommet with a connector backshell; clamps hold
    // it to the structure in between. All of that reaches through the insulation: mounts.
    b.group(`mount:${name}`);
    for (const end of [0, 1]) {
      const sgn = end === 0 ? -1 : 1;
      const azEnd = run.az[end]! + sgn * dAz * 0.9;
      const wf = wallFrame(ctx, azEnd, run.y, 0.004);
      b.cylinder(wf.o, wf.n, run.r * 3.2, 0.004, 14, ctx.m('aluminium'), { caps: 'top' });
      b.cylinder(v3.addScaled(wf.o, wf.n, 0.004), wf.n, run.r * 2.3, 0.024, 12, ctx.m('anodized'), { radius1: run.r * 1.9, caps: 'top' });
      for (let k = 0; k < 4; k++) b.cylinder(local(wf, Math.cos(k * 1.5708 + 0.785) * run.r * 2.6, Math.sin(k * 1.5708 + 0.785) * run.r * 2.6, 0.004), wf.n, 0.0022, 0.0015, 6, ctx.m('steel'), { caps: 'top' });
      const stub = [wallPoint(ctx, azEnd * DEG, run.y, 0.012), wallPoint(ctx, (run.az[end]! + sgn * dAz * 0.45) * DEG, run.y, inset * 0.6), main[end === 0 ? 0 : main.length - 1]!];
      for (const off of [-0.6, 0.6]) b.tube(stub.map((p, k) => v3.addScaled(p, { x: 0, y: 1, z: 0 }, off * run.r * 1.4 * (k === 0 ? 0.4 : 1))), run.r * 0.7, 12, ctx.m(run.mat));
      b.tube(stub, run.r, 16, ctx.m(run.mat));
    }
    for (let k = 1; k < steps; k += 3) {
      const az = run.az[0] + ((run.az[1] - run.az[0]) * k) / steps;
      const wf = wallFrame(ctx, az, run.y, inset);
      b.box(offsetFrame(wf, 0, 0, 0), 0.006, run.r * 2.6, run.r * 1.4, 0.002, ctx.m('anodized'));
      b.cylinder(wallPoint(ctx, az * DEG, run.y, 0.001), wf.n, 0.004, inset - run.r * 1.4, 6, ctx.m('aluminium'));
    }
  });

  // ---- fire extinguisher in its bracket by the hatch
  b.group('extinguisher');
  const ex = L.fixtures.extinguisher;
  const ext = seatedFrame(ctx, ex.azDeg, ex.y, 0.08, 0.34, 0.076);
  b.cylinder(local(ext, 0, -0.15, -0.035), ext.y, 0.034, 0.27, 20, ctx.m('extinguisher'), { caps: 'bottom' });
  b.lathe(local(ext, 0, 0.12, -0.035), ext.y, [[0.034, 0], [0.03, 0.02], [0.012, 0.035], [0.01, 0.06], [0, 0.065]], 16, ctx.m('extinguisher'));
  b.box(offsetFrame(ext, 0.02, 0.17, -0.035), 0.03, 0.006, 0.01, 0.002, ctx.m('anodized'));
  for (const v of [-0.08, 0.05]) {
    b.box(offsetFrame(ext, 0, v, -0.035), 0.04, 0.009, 0.04, 0.003, ctx.m('webbing'));
    standoff(ctx, 'extinguisher', local(ext, 0, v, -0.074), ext.n, 0.009);
  }
  ctx.labelQuad(offsetFrame(ext, 0, -0.03, 0), 0, 0, 0.055, 0.02, 'FIRE EXT', 'extinguisher', { color: 0 });

  // ---- flight data file pouch on the wall by the commander
  b.group('fdfPouch');
  const fp = L.fixtures.dataFile;
  const fdf = seatedFrame(ctx, fp.azDeg, fp.y, 0.22, 0.26, 0.05);
  // A sewn document pouch: a flat padded envelope (the books in it give it its lumps), its flap held down by
  // a hook-and-loop strip, a corner tab on each side sewn to the wall's hard points.
  {
    const cover = softCover(ctx, fdf, 0.22, 0.26, 0.05, 'pouch', [], 0.4, 3);
    const flapV = 0.075;
    const flapU = cover.us.filter((u) => Math.abs(u) <= 0.1);
    b.surface(flapU.length - 1, 1, (i, j) => {
      const u = flapU[i]!;
      const v = flapV + (j - 0.5) * 0.022;
      return { p: local(fdf, u, v, cover.colTop(u, flapV - 0.011, flapV + 0.011) + 0.0016), uv: [u, v] };
    }, ctx.m('velcro', { flags: FLAG_OVERLAY }));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) standoff(ctx, 'fdfPouch', local(fdf, sx * 0.1, sy * 0.12, -0.049), fdf.n, 0.006, 'webbing');
    ctx.labelQuad(offsetFrame(fdf, 0, -0.03, Math.max(cover(0, -0.03), cover(-0.06, -0.03), cover(0.06, -0.03)) + 0.0012), 0, 0, 0.12, 0.016, 'FLIGHT DATA FILE', 'pouch', { color: 1 });
  }
  // (The hook-and-loop squares on the blankets are part of the blankets: cabin/shell.ts.)

  // ---- stowage: soft bags strapped to the upper wall, a checklist card on hook-and-loop by the commander
  for (const bag of L.fixtures.bags) {
    b.group(`bag:${bag.label}`);
    stowageBag(ctx, bag.azDeg, bag.y, bag.width, bag.height, bag.strap, bag.label);
  }
  b.group('checklist');
  const ck = L.fixtures.checklist;
  // A cue card of the size of a hand, printed full: a title and the numbered steps.
  const cw = 0.125;
  const chh = 0.175;
  const card = wallFrame(ctx, ck.azDeg, ck.y, plateInset(ctx, ck.azDeg, ck.y, cw, chh, 0.004, 0.0005));
  const cf = { ...card, x: v3.normalize(v3.add(card.x, v3.scale(card.y, 0.06))), y: v3.normalize(v3.add(card.y, v3.scale(card.x, -0.06))) };
  b.box(offsetFrame(cf, 0, 0.0, -0.0025), cw / 2 - 0.006, chh / 2 - 0.008, 0.0015, 0.0006, ctx.m('velcro', { flags: FLAG_OVERLAY }));
  // A second card under the first, a little askew, both under a spring clip on a ring.
  const under = { ...cf, x: v3.normalize(v3.add(cf.x, v3.scale(cf.y, -0.035))), y: v3.normalize(v3.add(cf.y, v3.scale(cf.x, 0.035))) };
  b.box(offsetFrame(under, 0.003, -0.004, -0.0019), cw / 2, chh / 2, 0.0005, 0.0002, ctx.m('card', { ao: 0.8 }));
  b.box(offsetFrame(cf, 0, 0, -0.0006), cw / 2, chh / 2, 0.0006, 0.0002, ctx.m('card'));
  b.box(offsetFrame(cf, 0, chh / 2 - 0.004, 0.0022), 0.019, 0.0075, 0.0022, 0.001, ctx.m('matteBlack'));
  for (const sx of [-1, 1]) b.tube([local(cf, sx * 0.012, chh / 2 - 0.006, 0.0044), local(cf, sx * 0.009, chh / 2 + 0.006, 0.006), local(cf, 0, chh / 2 + 0.012, 0.0045)], 0.0009, 5, ctx.m('steel'));
  b.lathe(local(cf, 0, chh / 2 + 0.019, 0.003), cf.n, [[0.0085, -0.0012], [0.0097, 0], [0.0085, 0.0012], [0.0073, 0], [0.0085, -0.0012]], 20, ctx.m('steel'), { ref: cf.x });
  ctx.labelQuad(cf, 0, chh / 2 - 0.014, cw - 0.012, 0.0105, 'ENTRY CHECKLIST', 'card', { color: 1, style: { weight: 700 } });
  ctx.labelQuad(cf, 0, chh / 2 - 0.0225, cw - 0.012, 0.0008, '#LINE', 'card', { color: 1 });
  const steps = ['1  CM/SM SEP - CONFIRM', '2  ATT HOLD - RETRO', '3  RCS CMD - ON', '4  EI -15 MIN - SUITS', '5  G LIMIT 8 - CHECK', '6  COMM BLK - EXPECT', '7  DROGUE ARM - 24 KM', '8  MAINS - 3 KM AUTO', '9  VENT - OPEN', '10 BEACON - ON'];
  steps.forEach((text, i) => ctx.labelQuad(cf, 0, chh / 2 - 0.034 - i * 0.0128, cw - 0.016, 0.0072, text, 'card', { color: 1, style: { align: 'left' } }));
}

/**
 * The sewn cover of a soft pack on the wall (a stowage bag, a document pouch) as one displaced surface: a
 * pillow that bulges from its seam at the wall side to `depth` over its middle, cinched where a strap runs
 * over it (`straps`: their u positions), gathered into ripples beside each strap, lumpy with what is packed
 * in it (`fill` 0..1). Frame f: the front plane of the pack's envelope (z = 0), the wall side at z = -depth.
 * Returns the cover's height z(u, v) in that frame, for what is sewn or strapped onto it.
 */
interface SoftCover {
  /** Height of the cover's surface over the frame's plane at (u, v). */
  (u: number, v: number): number;
  /** The mesh's columns (u) and rows (v): what lies ON the cover takes its vertices from these. */
  us: number[];
  vs: number[];
  /**
   * The highest vertex of the cover's own mesh over [u0, u1] at row v (a value of `vs`), or over [v0, v1]
   * at column u (a value of `us`): a band laid across the mesh with its vertices on the mesh's rows (or
   * columns) at this height plus its lift is nowhere under the mesh between them either (the mesh is linear
   * in each triangle, so its height between two rows is at most the blend of the rows' highest vertices).
   */
  rowTop(v: number, u0: number, u1: number): number;
  colTop(u: number, v0: number, v1: number): number;
}
/** Half width (m) of the straps a soft cover is pulled down by. */
const COVER_STRAP_HALF = 0.0125;
function softCover(ctx: CabinContext, f: Frame, w: number, h: number, depth: number, mat: string, straps: number[], fill: number, seed: number): SoftCover {
  const edge = (t: number): number => Math.pow(Math.max(0, 1 - Math.min(1, Math.abs(t)) ** 4), 0.45);
  const ni = Math.max(8, Math.round(w / 0.011));
  const nj = Math.max(8, Math.round(h / 0.011));
  // The strap presses a flat-bottomed groove: flat under the band and one cell of the mesh to either side
  // (so the mesh under the band's edges is at the groove's floor), the cloth rising beside it.
  const flat = COVER_STRAP_HALF + w / ni;
  // Under a strap the pack has one height across the band's width (the band is flat across): the pack's own
  // shape is read at the band's centre line there, and catches up with itself beside the groove.
  const pressed = (u: number): number => {
    let x = u;
    const open = Math.max(0, Math.min(1, (w / 2 - Math.abs(u)) / 0.015));
    for (const us of straps) {
      const d = u - us;
      x -= Math.sign(d) * Math.min(Math.abs(d), flat) * Math.exp(-Math.max(0, Math.abs(d) - flat) / 0.03) * open;
    }
    return x;
  };
  const z = (uTrue: number, v: number): number => {
    const u = pressed(uTrue);
    const a = (2 * u) / w;
    const c = (2 * v) / h;
    const rim = edge(a) * edge(c);
    let t = depth * rim * (0.8 + 0.2 * (1 - a * a) * (1 - c * c));
    // What is packed in it: broad lumps, more of them the fuller the pack.
    t += depth * 0.11 * fill * rim * (Math.sin(u * 23 + seed * 1.3) * Math.sin(v * 17 + seed * 0.7) + 0.5 * Math.sin(u * 41 + v * 29 + seed));
    for (const us of straps) {
      const d = uTrue - us;
      const g = Math.exp(-((Math.max(0, Math.abs(d) - flat) / 0.008) ** 2));
      // The strap's groove, and the cloth gathered into ripples on either side of it.
      t -= 0.011 * g * Math.pow(rim, 0.35);
      t += 0.0026 * Math.sin(v / 0.0115 + 9 * us + 2.5 * Math.sin(v / 0.047 + seed)) * Math.exp(-Math.abs(d) / 0.032) * (1 - g) * rim;
    }
    return -depth + Math.max(0, t);
  };
  ctx.b.surface(ni, nj, (i, j) => {
    const u = -w / 2 + (w * i) / ni;
    const v = -h / 2 + (h * j) / nj;
    return { p: local(f, u, v, z(u, v)), uv: [u, v] };
  }, ctx.m(mat));
  // The seam round the pack at the wall side: a piping cord.
  const loop: Vec3[] = [];
  const r = Math.min(w, h) * 0.18;
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    const cu = Math.cos(a);
    const su = Math.sin(a);
    // A rounded rectangle just inside the footprint.
    const px = Math.sign(cu) * (w / 2 - r - 0.004) + cu * r;
    const py = Math.sign(su) * (h / 2 - r - 0.004) + su * r;
    loop.push(local(f, px, py, z(px, py) + 0.0015));
  }
  ctx.b.tube(loop, 0.0022, 6, ctx.m(mat, { ao: 0.8 }));
  const us = Array.from({ length: ni + 1 }, (_, i) => -w / 2 + (w * i) / ni);
  const vs = Array.from({ length: nj + 1 }, (_, j) => -h / 2 + (h * j) / nj);
  /** Grid lines of `grid` from the one at or before a to the one at or after b. */
  const span = (grid: number[], a: number, b: number): number[] => {
    const step = grid[1]! - grid[0]!;
    const i0 = Math.max(0, Math.min(grid.length - 1, Math.floor((a - grid[0]!) / step + 1e-6)));
    const i1 = Math.max(0, Math.min(grid.length - 1, Math.ceil((b - grid[0]!) / step - 1e-6)));
    return grid.slice(i0, i1 + 1);
  };
  return Object.assign(z, {
    us,
    vs,
    rowTop: (v: number, u0: number, u1: number): number => Math.max(...span(us, u0, u1).map((u) => z(u, v))),
    colTop: (u: number, v0: number, v1: number): number => Math.max(...span(vs, v0, v1).map((v) => z(u, v))),
  });
}

/**
 * A soft stowage bag on the wall: a sewn, packed bag (softCover) under two webbing straps that are pulled
 * tight over it (they lie in the grooves they press into it, down to the wall above and below the bag) with
 * a cam buckle each, a zip across its upper third, a name tag on hook-and-loop.
 */
function stowageBag(ctx: CabinContext, az: number, y: number, w: number, h: number, strapMat: string, label: string): void {
  const b = ctx.b;
  const name = b.groupName;
  const depth = 0.085;
  const f = seatedFrame(ctx, az, y, w, h, depth);
  const strapU = [-w * 0.28, w * 0.28];
  const seed = label.length + label.charCodeAt(0);
  const cover = softCover(ctx, f, w, h, depth, 'pouch', strapU, 0.8, seed);
  // Zip across the upper third: its tape follows the cover.
  const zipV = h * 0.31;
  const zipU = cover.us.filter((u) => Math.abs(u) <= w * 0.4);
  b.surface(zipU.length - 1, 1, (i, j) => {
    const u = zipU[i]!;
    const v = zipV + (j - 0.5) * 0.007;
    return { p: local(f, u, v, cover.colTop(u, zipV - 0.0035, zipV + 0.0035) + 0.0012), uv: [u, v] };
  }, ctx.m('cableBlack', { flags: FLAG_OVERLAY }));
  const pullU = zipU[zipU.length - 1]! - 0.007;
  b.box(offsetFrame(f, pullU, zipV, Math.max(...cover.us.filter((u) => Math.abs(u - pullU) <= 0.007 + w / (cover.us.length - 1)).map((u) => cover.colTop(u, zipV - 0.004, zipV + 0.004))) + 0.0012 + 0.0006 + 0.002), 0.007, 0.004, 0.002, 0.001, ctx.m('steel'));
  for (const x of strapU) {
    // The strap in its groove, from the wall side below the bag over the front to the wall side above it.
    // (Its vertices on the cover's own rows, over the highest of the cover under its width: it lies in the
    // groove's flat floor and never dips into the cloth, whose edge against it would be a saw.)
    const half = COVER_STRAP_HALF;
    b.surface(1, cover.vs.length - 1, (i, j) => {
      const v = cover.vs[j]!;
      return { p: local(f, x + (i - 0.5) * 2 * half, v, cover.rowTop(v, x - half, x + half) + 0.0016), uv: [(i - 0.5) * 2 * half, v] };
    }, ctx.m(strapMat, { flags: FLAG_OVERLAY }));
    b.group(`mount:${name}`);
    for (const sy of [-1, 1]) {
      // From where the strap leaves the bag to its footman loop on the wall.
      const top = local(f, x, sy * (h / 2), -depth + 0.0016);
      const atWall = fitWall(ctx, local(f, x, sy * (h / 2 + 0.03), -depth), v3.neg(f.n));
      // (Ends a few millimetres off the wall: the strap's own thickness must not reach into it.)
      const wallEnd = v3.addScaled(atWall, v3.normalize(v3.sub(top, atWall)), 0.004);
      const dir = v3.normalize(v3.sub(wallEnd, top));
      const side = v3.normalize(v3.cross(dir, f.n));
      const ff = frameAt(v3.lerp(top, wallEnd, 0.5), side, dir);
      b.box(ff, half, v3.dist(top, wallEnd) / 2, 0.0012, 0.0006, ctx.m(strapMat));
      b.tube([v3.addScaled(wallEnd, side, -half - 0.003), v3.addScaled(wallEnd, side, half + 0.003)], 0.0022, 6, ctx.m('steel'), { caps: true });
    }
    b.group(name);
    // Cam buckle where the strap crosses the front.
    const bv = -h * 0.18;
    const bz = Math.max(...cover.vs.filter((v) => Math.abs(v - bv) <= 0.011 + h / (cover.vs.length - 1)).map((v) => cover.rowTop(v, x - 0.016, x + 0.016)));
    b.box(offsetFrame(f, x, bv, bz + 0.0052), 0.016, 0.011, 0.0028, 0.0012, ctx.m('aluminium'));
    b.box(offsetFrame(f, x, bv - 0.006, bz + 0.0085), 0.013, 0.0035, 0.0012, 0.0006, ctx.m('steel'));
  }
  // Name tag on hook-and-loop, sewn on over the bag's crown.
  const tagV = h * 0.1;
  // (Over the highest vertex of the cover's mesh under it: a stiff patch on the crown.)
  let top = -Infinity;
  for (const u of cover.us) if (Math.abs(u) <= w * 0.16 + w / (cover.us.length - 1)) top = Math.max(top, cover.colTop(u, tagV - 0.016, tagV + 0.016));
  b.box(offsetFrame(f, 0, tagV, top + 0.0015), w * 0.16, 0.016, 0.0015, 0.0008, ctx.m('velcro', { flags: FLAG_OVERLAY }));
  ctx.labelQuad(offsetFrame(f, 0, tagV, top + 0.003), 0, 0, w * 0.3, 0.012, label, 'pouch', { color: 1 });
}

/**
 * Move a frame along `dir` until the box [-hx, hx] x [-hy, hy] x [z0, z1] around it clears the wall and what
 * lies on it under the box.
 */
export function clearFrame(ctx: CabinContext, f: Frame, hx: number, hy: number, z0: number, z1: number, dir: Vec3): Frame {
  let o = f.o;
  for (let k = 0; k < 60; k++) {
    const g = { ...f, o };
    const pts: Vec3[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [z0, z1]) pts.push(local(g, sx * hx, sy * hy, z));
    const d = wallDeficit(ctx, pts, SKIN_GAP);
    if (d <= 0) return g;
    o = v3.addScaled(o, dir, d + 0.001);
  }
  return { ...f, o };
}

/** Point on the wall reached from p along dir (or p itself when already at the wall). */
function fitWall(ctx: CabinContext, p: Vec3, dir: Vec3): Vec3 {
  const need = ctx.def.wallThickness + 0.0005;
  let lo = 0;
  let hi = 0.3;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, v3.addScaled(p, dir, mid)) > need) lo = mid;
    else hi = mid;
  }
  return v3.addScaled(p, dir, lo);
}

function breaker(ctx: CabinContext, f: Frame, label: string, key: string): void {
  const b = ctx.b;
  b.cylinder(local(f, 0, 0, 0), f.n, 0.0058, 0.002, 12, ctx.m('steel'));
  b.cylinder(local(f, 0, 0, 0.002), f.n, 0.0042, 0.0035, 12, ctx.m('breakerBand'));
  b.cylinder(local(f, 0, 0, 0.0055), f.n, 0.0045, 0.0055, 12, ctx.m('breakerCap'));
  ctx.labelQuad(f, 0, 0.0115, 0.022, 0.0042, label, 'panel', { color: 0, backlit: true });
  void key;
}

/** A handhold: a rail standing over the insulation on two legs that reach through it to their feet on the wall. */
function handhold(ctx: CabinContext, index: number, az: number, y: number, len: number): void {
  const b = ctx.b;
  const r = 0.011;
  // (The feet's flat plates stand clear of the curved wall at their corners.)
  const f = wallFrame(ctx, az, y, 0.011);
  // The rail's underside clears what lies on the wall under it.
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of [-1, 1]) {
    const p = local(f, (s * len) / 2, 0, 0);
    y0 = Math.min(y0, p.y - 0.02);
    y1 = Math.max(y1, p.y + 0.02);
  }
  const rise = Math.max(0.05, skinHeight(ctx, y0, y1) + SKIN_GAP + 2 * r + 0.012);
  const pts = [local(f, -len / 2, 0, -0.004), local(f, -len / 2, 0, rise - 0.02), local(f, -len / 2 + 0.02, 0, rise), local(f, len / 2 - 0.02, 0, rise), local(f, len / 2, 0, rise - 0.02), local(f, len / 2, 0, -0.004)];
  b.group(`handhold:${index}`);
  b.tube(pts.slice(1, 5), r, 12, ctx.m('handhold'), { caps: true });
  b.group(`mount:handhold:${index}`);
  b.tube(pts.slice(0, 2), r, 12, ctx.m('handhold'), { caps: true });
  b.tube(pts.slice(4, 6), r, 12, ctx.m('handhold'), { caps: true });
  for (const s of [-1, 1]) b.box(offsetFrame(f, (s * len) / 2, 0, -0.002), 0.018, 0.018, 0.004, 0.002, ctx.m('aluminium'));
}

function locker(ctx: CabinContext, az: number, y: number, w: number, h: number, label: string): void {
  const depth = 0.1;
  const f = seatedFrame(ctx, az, y, w, h, depth);
  const b = ctx.b;
  b.box(offsetFrame(f, 0, 0, -depth / 2), w / 2, h / 2, depth / 2, 0.006, ctx.m('closeout', { ao: 0.85 }));
  // What carries it (round 6: the lockers hung on nothing): a mounting ear at each corner of the body, above
  // and below it, bolted through to a post that stands on a boss on the wall.
  {
    const keep = b.groupName;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        b.group(`mount:${keep}`);
        const ear = offsetFrame(f, sx * (w / 2 - 0.03), sy * (h / 2 + 0.01), -depth * 0.55);
        b.box(ear, 0.015, 0.012, 0.0025, 0.001, ctx.m('aluminium'));
        b.cylinder(local(ear, 0, sy * 0.002, 0.0025), f.n, 0.0058, 0.0032, 6, ctx.m('steel'), { caps: 'top' });
        b.group(keep);
        standoff(ctx, keep, local(ear, 0, sy * 0.002, -0.0025), f.n, 0.006);
      }
    }
  }
  // The door: a pressed sheet in the body's rim, hung on a piano hinge along one side and held by two
  // quarter-turn fasteners on the other, stiffened by two pressed beads, with a paddle latch, a webbing pull,
  // its stowage label and a data plate. Rivets hold the rim to the body.
  const dw = w / 2 - 0.008;
  const dh = h / 2 - 0.008;
  const steel = ctx.m('steel');
  b.box(offsetFrame(f, 0, 0, 0.003), dw, dh, 0.003, 0.002, ctx.m('closeout'));
  for (const v of [-dh * 0.5, dh * 0.5]) b.box(offsetFrame(f, 0.006, v, 0.0068), dw - 0.03, 0.006, 0.0012, 0.0011, ctx.m('closeout', { ao: 0.9 }));
  // Piano hinge: its pin and alternating knuckles.
  const hingeU = -dw - 0.001;
  const knuckles = Math.max(4, Math.round((2 * dh) / 0.03));
  b.cylinder(local(f, hingeU, -dh + 0.008, 0.0055), f.y, 0.0016, 2 * dh - 0.016, 6, steel, { caps: 'both' });
  for (let k = 0; k < knuckles; k++) {
    const v0 = -dh + 0.01 + ((2 * dh - 0.02) * k) / knuckles;
    b.cylinder(local(f, hingeU, v0 + 0.001, 0.0055), f.y, 0.0034, (2 * dh - 0.02) / knuckles - 0.002, 8, ctx.m(k % 2 === 0 ? 'closeout' : 'aluminium'), { caps: 'both' });
  }
  // Quarter-turn fasteners on the free side: a ringed head with a slot.
  for (const v of [-dh * 0.62, dh * 0.62]) {
    const p = local(f, dw - 0.016, v, 0.006);
    b.cylinder(p, f.n, 0.0085, 0.0016, 14, ctx.m('aluminium'), { caps: 'top' });
    b.cylinder(v3.addScaled(p, f.n, 0.0016), f.n, 0.0058, 0.0018, 12, steel, { caps: 'top' });
    b.box(offsetFrame(f, dw - 0.016, v, 0.0098), 0.0048, 0.0009, 0.0005, 0.0002, ctx.m('matteBlack'));
  }
  // Paddle latch in a dished escutcheon.
  b.box(offsetFrame(f, dw - 0.05, 0, 0.0075), 0.012, 0.03, 0.0025, 0.002, ctx.m('anodized'));
  b.box(offsetFrame(f, dw - 0.05, 0.004, 0.0108), 0.007, 0.02, 0.0011, 0.0008, steel);
  // Rivets round the rim.
  const rim = ctx.m('aluminium');
  const nu = Math.max(2, Math.round(w / 0.07));
  const nv = Math.max(2, Math.round(h / 0.07));
  for (let i = 0; i <= nu; i++) for (const sv of [-1, 1]) b.cylinder(local(f, -w / 2 + 0.004 + ((w - 0.008) * i) / nu, sv * (h / 2 - 0.004), -0.0005), f.n, 0.0022, 0.001, 6, rim, { caps: 'top' });
  for (let j = 1; j < nv; j++) for (const su of [-1, 1]) b.cylinder(local(f, su * (w / 2 - 0.004), -h / 2 + 0.004 + ((h - 0.008) * j) / nv, -0.0005), f.n, 0.0022, 0.001, 6, rim, { caps: 'top' });
  // Webbing pull below the latch.
  {
    const loop: Vec3[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = (Math.PI * k) / 10;
      loop.push(local(f, dw - 0.05, -0.045 - 0.028 * Math.sin(a), 0.0075 + 0.0045 * Math.cos(a) + 0.001));
    }
    b.surface(1, loop.length - 1, (i, j) => ({ p: v3.addScaled(loop[j]!, f.x, (i - 0.5) * 0.02), uv: [i * 0.02, j * 0.006] }), ctx.m('webbingOrange'));
  }
  ctx.labelQuad(offsetFrame(f, -0.02, 0, 0.0062), 0, 0.012, Math.min(w * 0.6, 0.18), 0.018, label, 'closeout', { color: 1, style: { box: true } });
  b.box(offsetFrame(f, -0.02, -0.022, 0.0064), 0.034, 0.009, 0.0004, 0.0002, ctx.m('aluminium'));
  ctx.labelQuad(offsetFrame(f, -0.02, -0.022, 0.0068), 0, 0, 0.062, 0.0055, 'MAX 12 KG  ·  LATCH BEFORE BURN', 'aluminium', { color: 1, lift: 0.0003, style: { weight: 500 } });
}
