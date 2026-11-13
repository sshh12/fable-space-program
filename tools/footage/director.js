/**
 * Footage director: injected into the game page by tools/footage/record.mjs.
 *
 * CAMERA AND VIEW, plus two things the recorder does for it with real key presses: the HUD (the game's F2, from
 * `hudWant`) and, in the full plan, the heads-down roll in the parking orbit (`routine`). It reads
 * `window.__app.brief()`, `window.__test.pilot.phase()` and (five times a second) `window.__test.state()`; it writes
 * `window.__test.setView(mode)` (what C and M do) and `window.__test.setCameraOrbit(azimuth, elevation, distance)`
 * (what the arrow keys, PgUp/PgDn and the wheel do). Once, in the full plan, the moment the second stage has
 * separated, it stops the pilot and sets the warp to real time (what the '/' key does; the pilot would otherwise
 * warp on rails before the stage has drifted off) and asks the recorder for the roll; the recorder starts the pilot
 * again afterwards.
 *
 * It also says when it wants footage (`wantRec`): the recorder opens a file for every such window, so the long
 * coasts are not recorded. Shots are chosen from the pilot's phase, the time spent in it, the MET (the flight up to
 * orbit is the same every time: the times of the 2026-11-12 flight anticipate the staging events), the altitude
 * and the milestones. A chase shot names the eye direction (from the vessel's centre of mass to the eye, ROOT axes)
 * and the distance, or the rig's own angles (`rig`); the director re-expresses it in the chase rig's reference
 * frame (src/camera/chaseRig.ts: the local vertical is up; azimuth from north in the navball's surface mode, from
 * the horizontal part of the velocity in orbit mode) and eases the rig there every frame. A map shot names the map
 * rig's orbit (azimuth about ROOT +Z, elevation above the ROOT equator, distance from the focus surface).
 *
 * Every shot change, phase, milestone, HUD wish and recorder window is logged with performance.now() so the editor
 * can cut the recording.
 */
(() => {
  if (window.__director) return;
  const T = window.__test;
  const A = window.__app;
  const DEG = Math.PI / 180;
  const RADIUS = { earth: 6371000, moon: 1737400 };
  // MET (s) of events of the flight of 2026-11-12 (docs/qa/mission/browser-mission-2026-11-12.json).
  const REF_MET = { MAX_Q: 79.9, STAGE_SEP_1: 161.9, FAIRING_JETTISON: 182.4 };

  // ------------------------------------------------------------------------------------------ vectors
  const V = (x, y, z) => ({ x, y, z });
  const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, k) => V(a.x * k, a.y * k, a.z * k);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const len = (a) => Math.hypot(a.x, a.y, a.z);
  const anyOrth = (a) => (Math.abs(a.x) < 0.9 ? norm(cross(a, V(1, 0, 0))) : norm(cross(a, V(0, 1, 0))));
  function norm(a) {
    const l = len(a);
    return l > 0 ? mul(a, 1 / l) : V(0, 0, 1);
  }
  const rej = (a, n) => sub(a, mul(n, dot(a, n)));
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const angle = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1));
  const qrot = (q, v) => {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return V(v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx));
  };
  /** Rodrigues rotation of v about the unit axis k. */
  const rotAbout = (v, k, a) => add(add(mul(v, Math.cos(a)), mul(cross(k, v), Math.sin(a))), mul(k, dot(k, v) * (1 - Math.cos(a))));
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // ------------------------------------------------------------------------------------------ state
  const D = (window.__director = {
    enabled: false,
    shot: null,
    events: [],
    errors: [],
    lastSample: null,
    sampleMs: 0,
    sampleCount: 0,
    plan: 'full',
    wantRec: false,
    hudWant: true,
    routine: 'idle',
    override: null,
    padDefault: null,
    drain() {
      const e = this.events;
      this.events = [];
      return e;
    },
    note(type, data) {
      log(type, data ?? {});
    },
    setOverride(o) {
      this.override = o;
      log('override', o ? { ...o } : { off: true });
    },
  });
  const log = (type, data) => D.events.push({ t: performance.now(), type, ...data });

  let g = null; // geometry sampled from state()
  let lastSampleAt = -1e9;
  let phase = null;
  let phaseSince = performance.now();
  let lastMilestones = 0;
  const milestoneAt = {};
  let shot = null; // { id, since }
  let cam = null; // smoothed { az, el, logd, kind }
  let requestedView = null;
  // Entry: peak of the heat flux and of the load.
  const entry = { maxFlux: 0, peakHeatAt: 0, maxG: 0, peakGAt: 0, below40At: 0 };
  // Parachute modules in the order they were first seen open (0 = the drogues).
  const chuteOrder = new Map();

  function sample() {
    const t0 = performance.now();
    const s = T.state();
    D.sampleMs = performance.now() - t0;
    D.sampleCount++;
    if (!s) return null;
    const av = s.vessels.find((x) => x.id === s.activeVesselId);
    if (!av) return null;
    const B = {};
    for (const b of s.bodies) B[b.id] = b;
    const body = B[av.bodyId];
    const com = add(av.rRoot, qrot(av.q, av.comLocal));
    const up = norm(av.r);
    const pole = qrot(body.qFixedToRoot, V(0, 0, 1));
    const star = B[s.starId];
    const vRoot = add(body.vRoot, av.v);
    // Drift over the ground (velocity minus the body's spin), horizontal part: under the mains, the wind.
    const ground = sub(av.v, cross(body.spinRoot ?? V(0, 0, 0), av.r));
    // Parachutes of the active vessel: the open ones and their line direction (ROOT). One module per kind of chute
    // (the capsule's drogue pair, then its three mains): the first module seen open is the drogues, any later one
    // the mains (sorted mains first).
    const chutes = [];
    for (const p of av.parts ?? []) {
      (p.modules ?? []).forEach((m, mi) => {
        if (!m || m.type !== 'parachute' || !(m.state === 'reefed' || m.state === 'full')) return;
        const key = `${p.instanceId ?? p.def}:${mi}`;
        if (!chuteOrder.has(key)) chuteOrder.set(key, chuteOrder.size);
        chutes.push({ key, main: chuteOrder.get(key) >= 1, inflation: m.inflation, age: m.deployAge, dir: norm(qrot(av.q, m.lineDir)) });
      });
    }
    chutes.sort((a, b) => Number(b.main) - Number(a.main));
    const out = {
      ut: s.ut,
      mode: s.navball.mode,
      bodyId: av.bodyId,
      vesselId: av.id,
      situation: av.situation,
      radius: av.boundingRadius,
      r: av.r,
      v: av.v,
      vRoot,
      q: av.q,
      com,
      up,
      pole,
      nose: qrot(av.q, V(0, 1, 0)),
      ax: qrot(av.q, V(1, 0, 0)),
      az: qrot(av.q, V(0, 0, 1)),
      sunDir: norm(sub(star.rRoot, com)),
      earth: B.earth,
      moon: B.moon,
      alt: s.readouts.altitudeAsl,
      radar: s.readouts.altitudeRadar,
      heatFlux: s.readouts.heatFlux ?? 0,
      gLoad: s.readouts.gLoad ?? 0,
      vessels: s.vessels.length,
      chutes,
      drift: rej(ground, up),
    };
    D.lastSample = { ut: out.ut, bodyId: out.bodyId, alt: out.alt, mode: out.mode, situation: out.situation, sampleMs: D.sampleMs, chutes: chutes.length };
    return out;
  }

  /**
   * The chase rig's reference frame (chaseReferenceFrame in src/camera/chaseRig.ts): up = the local vertical
   * in both navball modes; azimuth zero = the horizontal part of the orbital velocity in orbit mode, north on
   * a surface.
   */
  function rigFrame(geo, mode) {
    const u = geo.up;
    if (mode === 'orbit') {
      const h = rej(geo.v, u);
      const sp = len(h);
      if (sp > 1e-3 && sp > 1e-6 * len(geo.v)) {
        const X = mul(h, 1 / sp);
        return { X, Y: cross(u, X), Z: u };
      }
    }
    let e = cross(geo.pole, u);
    e = len(e) < 1e-9 ? anyOrth(u) : norm(e);
    const n = cross(u, e);
    return { X: n, Y: cross(u, n), Z: u };
  }

  /** Local basis at the vessel: up (radial), h (heading: nose, else velocity, projected horizontal), side. */
  function basis(geo, headingFrom) {
    const up = geo.up;
    let h = null;
    const tryDir = (d) => {
      const p = rej(d, up);
      if (len(p) > 0.15 * len(d)) h = norm(p);
    };
    if (headingFrom === 'velocity') tryDir(geo.v);
    if (!h) tryDir(geo.nose);
    if (!h) tryDir(geo.v);
    if (!h) tryDir(geo.ax);
    if (!h) h = anyOrth(up);
    return { up, h, side: cross(up, h) };
  }

  /** Direction with azimuth from the heading (0 = ahead, 90 = right side, 180 = behind) and elevation above the local horizontal. */
  const sph = (bs, azDeg, elDeg) => {
    const a = azDeg * DEG;
    const e = elDeg * DEG;
    return norm(add(mul(add(mul(bs.h, Math.cos(a)), mul(bs.side, Math.sin(a))), Math.cos(e)), mul(bs.up, Math.sin(e))));
  };

  /** Keep the camera from looking into the Sun: turn the eye about `axis` until the view is `minDeg` away from it. */
  function avoidSun(geo, dir, axis, minDeg = 32) {
    const ok = (d) => angle(mul(d, -1), geo.sunDir) >= minDeg * DEG;
    if (ok(dir)) return dir;
    for (const step of [35, -35, 70, -70, 110, -110, 150, -150, 180]) {
      const d = rotAbout(dir, axis, step * DEG);
      if (ok(d)) return d;
    }
    return dir;
  }

  const bodyGeo = (geo, id) => {
    const b = id === 'earth' ? geo.earth : geo.moon;
    const rel = sub(b.rRoot, geo.com);
    const dist = len(rel);
    const tb = mul(rel, 1 / dist);
    const angRad = Math.asin(clamp(RADIUS[id] / dist, 0, 1));
    // Lit fraction of the disc as seen from the vessel.
    const lit = (1 + dot(geo.sunDir, mul(tb, -1))) / 2;
    return { tb, dist, angRad, lit };
  };

  // ------------------------------------------------------------------------------------------ shots
  // Each chase shot returns { dir (unit, COM -> eye, ROOT), dist (m) } or { rig: { az, el } (rad, the rig's
  // frame), dist } for geometry `geo` and shot time `t` (s).
  const chase = {
    // The pad, around the default view of the pad (the rig's own: 70 degrees off the flame trench, on the
    // sunward side, clear of the tower), which is read at the start.
    padDefault: (geo, t) => padRel(geo, 0, null, null),
    padWide: (geo, t) => padRel(geo, -32 + 0.35 * t, 5, 720),
    padLow: (geo, t) => padRel(geo, 24 + 0.45 * t, -13, 78),
    padTop: (geo, t) => padRel(geo, -14 + 0.6 * t, 30, 175),
    padSide: (geo, t) => padRel(geo, 38 - 0.5 * t, 6, 105),
    liftoffPull: (geo, t) => padRel(geo, 0.3 * t, Math.max(-4, (D.padDefault ? D.padDefault.el / DEG : 12) - 1.6 * t), Math.min(260, (D.padDefault ? D.padDefault.dist : 140) + 10 * t)),
    // Ascent (heading = the nose's horizontal part).
    climbSide: (geo, t) => ({ dir: sph(basis(geo), 100, 2), dist: 105 }),
    maxqBelow: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo), 128 - 0.3 * t, -30), geo.up), dist: 125 }),
    climbBehind: (geo, t) => ({ dir: sph(basis(geo), 150 - 0.5 * t, 6), dist: 115 }),
    sepClose: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo), 132, 7), geo.up), dist: 62 }),
    fairingClose: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo), 96, 10), geo.up), dist: 62 }),
    limbAscent: (geo, t) => ({ dir: sph(basis(geo), 160 - 0.6 * t, 16), dist: 90 }),
    sideLimb: (geo, t) => ({ dir: sph(basis(geo), 92, 13), dist: 85 }),
    sep2Close: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo), 152 - 0.3 * t, 11), geo.up), dist: 40 }),
    rollChase: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 205 + 0.2 * t, 20), geo.up), dist: 58 }),
    // Orbit: eye above and behind, looking down at the vessel with the limb across the frame.
    limb: (geo, t, o = {}) => limbShot(geo, t, o),
    limbLow: (geo, t) => limbShot(geo, t, { az: 120, el: 8, dist: 60, drift: 0.4 }),
    burnLimb: (geo, t) => limbShot(geo, t, { az: 140, el: 14, dist: 75, drift: 0.4 }),
    burnSide: (geo, t) => limbShot(geo, t, { az: 95, el: 24, dist: 65, drift: -0.3 }),
    burnHigh: (geo, t) => limbShot(geo, t, { az: 200, el: 34, dist: 70, drift: 0.3 }),
    // Deep space: a body behind the vessel.
    earthBehind: (geo, t) => bodyBehind(geo, t, 'earth', { dist: 42 }),
    moonBehind: (geo, t) => bodyBehind(geo, t, 'moon', { dist: 42 }),
    bestBody: (geo, t) => bodyBehind(geo, t, pickBody(geo), { dist: 42 }),
    earthrise: (geo, t) => earthrise(geo, t),
    // Lunar descent and surface.
    descentSide: (geo, t) => ({ dir: sph(basis(geo, 'velocity'), 90, 16), dist: 55 }),
    descentBehind: (geo, t) => ({ dir: sph(basis(geo, 'velocity'), 160, 24), dist: 60 }),
    descentAbove: (geo, t) => ({ dir: sph(basis(geo, 'velocity'), 230, 34), dist: 70 }),
    landingSide: (geo, t) => ({ dir: earthFacing(geo, 75 + 0.5 * t, 9), dist: 46 }),
    landingLow: (geo, t) => ({ dir: earthFacing(geo, 20 + 0.6 * t, 4), dist: 38 }),
    surfaceOrbit: (geo, t) => ({ dir: earthFacing(geo, 40 + 3 * t, 7), dist: 34 }),
    surfaceHigh: (geo, t) => ({ dir: earthFacing(geo, 160 + 2 * t, 18), dist: 45 }),
    surfaceWide: (geo, t) => ({ dir: earthFacing(geo, 100 + 1.5 * t, 10), dist: 80 }),
    moonLiftoff: (geo, t) => ({ dir: earthFacing(geo, 90, 24), dist: 40 + 3 * t }),
    ascentSide: (geo, t) => ({ dir: sph(basis(geo), 95, 14), dist: 50 }),
    // Entry (heading = velocity).
    entryHigh: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 150, 18), geo.up), dist: 24 }),
    entrySide: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 105 - 0.4 * t, 6), geo.up), dist: 16 }),
    entryBehind: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 168, 10), geo.up), dist: 20 }),
    entryFront: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 35, 4), geo.up), dist: 18 }),
    entryFar: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 120 + 0.3 * t, 12), geo.up), dist: 140 }),
    // Chutes: from below the capsule, up along the canopy lines, so the open canopies are in the frame.
    chuteBelow: (geo, t) => chuteShot(geo, t, { thetaDeg: 36, swing: 0.9 }),
    chuteSide: (geo, t) => chuteShot(geo, t, { thetaDeg: 58, swing: -0.7, far: 1.45 }),
    // Splash and afloat: crosswind of the capsule's last drift, close in. The canopy comes down downwind, about
    // its 52 m of lines away, and so stays outside the frame (it stands on the water like a flat fan).
    splash: (geo, t) => ({ dir: waterSide(geo, 102 + 0.4 * t, 6), dist: 30 }),
    afloat: (geo, t) => ({ dir: waterSide(geo, 112 + 0.8 * t, 9), dist: 26 }),
    afloatWide: (geo, t) => ({ dir: waterSide(geo, 96 + 0.6 * t, 20), dist: 42 }),
  };

  /** The pad: the default view's angles (rig frame) turned by dAz, at elevation el (deg, null = the default's) and distance d (null = the default's). */
  function padRel(geo, dAzDeg, elDeg, dist) {
    const pd = D.padDefault ?? { az: 0, el: 12 * DEG, dist: 140 };
    let az = pd.az + dAzDeg * DEG;
    // Keep clear of the tower (off the vessel's ventral side, -Z), as the rig's default does.
    const fr = rigFrame(geo, 'surface');
    const ventral = mul(geo.az, -1);
    const vAz = Math.atan2(dot(ventral, fr.Y), dot(ventral, fr.X));
    const off = wrapPi(az - vAz);
    if (Math.abs(off) < 55 * DEG) az = vAz + Math.sign(off || 1) * 55 * DEG;
    return { rig: { az, el: elDeg === null ? pd.el : elDeg * DEG }, dist: dist === null ? pd.dist : dist };
  }

  function limbShot(geo, t, o) {
    const az = (o.az ?? 150) + (o.drift ?? 0.5) * t;
    const altKm = Math.max(0, geo.alt) / 1000;
    // Look down a little more than the horizon dip so the limb sits in the upper third.
    const R = RADIUS[geo.bodyId] ?? 6371000;
    const dip = Math.acos(R / (R + Math.max(1, geo.alt))) / DEG;
    const el = o.el ?? clamp(dip + 7, 10, 40);
    const dir = sph(basis(geo, 'velocity'), az, el);
    return { dir: avoidSun(geo, dir, geo.up), dist: o.dist ?? (altKm > 50 ? 70 : 90) };
  }

  function pickBody(geo) {
    const e = bodyGeo(geo, 'earth');
    const m = bodyGeo(geo, 'moon');
    // Apparent size times how much of it is lit, and never a body next to the Sun.
    const score = (b) => b.angRad * (0.15 + b.lit) * (angle(b.tb, geo.sunDir) > 40 * DEG ? 1 : 0.05);
    return score(m) > score(e) ? 'moon' : 'earth';
  }

  /** The body behind the vessel: the eye on the far side, offset a little toward the Sun so the vessel is lit. */
  function bodyBehind(geo, t, id, o) {
    const b = bodyGeo(geo, id);
    const off = clamp(b.angRad * 1.25 + 4 * DEG, 6 * DEG, 18 * DEG) + 0.08 * DEG * t;
    let p = rej(geo.sunDir, b.tb);
    p = len(p) < 1e-6 ? anyOrth(b.tb) : norm(p);
    const dir = norm(add(mul(b.tb, -Math.cos(off)), mul(p, Math.sin(off))));
    return { dir, dist: o.dist, bodyId: id, lit: b.lit, angDeg: b.angRad / DEG };
  }

  /** Earth over the lunar horizon (or any body over the local horizon), when it fits in the frame. */
  function earthrise(geo, t) {
    const b = bodyGeo(geo, geo.bodyId === 'moon' ? 'earth' : 'moon');
    const R = RADIUS[geo.bodyId] ?? 6371000;
    const dip = Math.acos(R / (R + Math.max(1, geo.alt)));
    const eB = Math.asin(clamp(dot(b.tb, geo.up), -1, 1));
    const horiz = norm(rej(b.tb, geo.up));
    // Look between the horizon and the body.
    const pitch = (eB - dip) / 2;
    const fwd = norm(add(mul(horiz, Math.cos(pitch)), mul(geo.up, Math.sin(pitch))));
    const side = norm(cross(geo.up, horiz));
    const dir = norm(add(mul(fwd, -1), mul(side, 0.18)));
    return { dir, dist: 45, fits: eB - -dip < 44 * DEG && eB > -dip, eDeg: eB / DEG, dipDeg: dip / DEG };
  }

  /** On or near the Moon: azimuth measured so that 0 puts the Earth behind the lander when it is low enough. */
  function earthFacing(geo, azDeg, elDeg) {
    const up = geo.up;
    const e = bodyGeo(geo, 'earth');
    const eEl = Math.asin(clamp(dot(e.tb, up), -1, 1)) / DEG;
    if (geo.bodyId === 'moon' && eEl > -2 && eEl < 21) {
      // Eye opposite the Earth's azimuth: the Earth sits above the horizon behind the lander.
      const h = norm(rej(e.tb, up));
      const bs = { up, h: mul(h, -1), side: cross(up, mul(h, -1)) };
      const az = 12 * Math.sin((azDeg * DEG) / 6);
      return sph(bs, az, Math.min(elDeg, 6));
    }
    const bs = basis(geo, 'velocity');
    return avoidSun(geo, sph(bs, azDeg, elDeg), up);
  }

  /**
   * Under open canopies: the eye sits below the capsule, `thetaDeg` off the line from the capsule up to the
   * canopies, on the sunward side, swinging slowly round the line. Seen from there the canopies stand 10-20
   * degrees above the capsule in the frame (the rig always looks at the capsule). Mains: 52 m of lines and
   * 26 m canopies; drogues: 22 m and 5.6 m.
   */
  function chuteShot(geo, t, o) {
    const c = geo.chutes[0];
    const main = !!c && c.main;
    const u = c ? c.dir : geo.up;
    let s = rej(geo.sunDir, u);
    s = len(s) < 1e-6 ? anyOrth(u) : norm(s);
    s = rotAbout(s, u, (o.swing * t + 25) * DEG);
    const th = o.thetaDeg * DEG;
    const dir = norm(add(mul(u, -Math.cos(th)), mul(s, Math.sin(th))));
    const base = main ? 78 : 44;
    return { dir: avoidSun(geo, dir, u, 38), dist: base * (o.far ?? 1) };
  }

  /**
   * On the water: azimuth 0 = downwind (where the canopy comes down), fixed the first time it is asked for: the
   * capsule's drift over the ground when it has one, else the lines' lean, else the sun. The side (+90 or -90)
   * is the one with the sun more behind the camera.
   */
  let water = null;
  function waterSide(geo, azDeg, elDeg) {
    const up = geo.up;
    if (!water) {
      let h = null;
      let how = 'sun';
      if (len(geo.drift) > 0.4) {
        h = norm(geo.drift);
        how = 'drift';
      }
      const c = geo.chutes[0];
      if (!h && c && len(rej(c.dir, up)) > 0.08) {
        h = norm(rej(c.dir, up));
        how = 'lines';
      }
      if (!h) h = len(rej(geo.sunDir, up)) > 1e-6 ? norm(rej(geo.sunDir, up)) : anyOrth(up);
      const side = cross(up, h);
      const sign = dot(side, geo.sunDir) >= 0 ? 1 : -1;
      water = { h, sign };
      log('water', { how, drift: +len(geo.drift).toFixed(2), sign });
    }
    const bs = { up, h: water.h, side: mul(cross(up, water.h), water.sign) };
    return sph(bs, azDeg, elDeg);
  }

  // Map shots: { az, el, dist } of the map rig (pivot = the focus body, the Earth after the first visit).
  const mapShots = {
    parking: (geo, t) => {
      const rE = sub(geo.com, geo.earth.rRoot);
      const vE = sub(geo.vRoot, geo.earth.vRoot);
      const h = norm(cross(rE, vE));
      const d = norm(add(mul(h, Math.sin(52 * DEG)), mul(norm(rE), Math.cos(52 * DEG))));
      return mapOrbit(rotAbout(d, V(0, 0, 1), 1.5 * DEG * t), 1.35e7);
    },
    translunar: (geo, t) => {
      const rE = sub(geo.com, geo.earth.rRoot);
      const vE = sub(geo.vRoot, geo.earth.vRoot);
      const h = norm(cross(rE, vE));
      const m = norm(sub(geo.moon.rRoot, geo.earth.rRoot));
      const line = norm(add(m, mul(norm(rE), -0.6)));
      const w = norm(cross(h, line));
      const d = norm(add(mul(h, Math.sin(48 * DEG)), mul(w, -Math.cos(48 * DEG))));
      return mapOrbit(rotAbout(d, h, 0.8 * DEG * t), 9.0e8);
    },
    returnLeg: (geo, t) => {
      const rE = sub(geo.com, geo.earth.rRoot);
      const vE = sub(geo.vRoot, geo.earth.vRoot);
      let h = norm(cross(rE, vE));
      const m = norm(sub(geo.moon.rRoot, geo.earth.rRoot));
      if (Math.abs(dot(h, m)) > 0.95) h = anyOrth(m);
      const w = norm(cross(h, m));
      const d = norm(add(mul(h, Math.sin(45 * DEG)), mul(w, Math.cos(45 * DEG))));
      return mapOrbit(rotAbout(d, h, -0.8 * DEG * t), 8.5e8);
    },
    lunar: (geo, t) => {
      // Pivot is the Earth: put the eye just beyond the Moon, a little off the Earth-Moon line, so the Moon
      // with the lunar orbit fills a side of the frame and the Earth is a small disc in the middle.
      const em = sub(geo.moon.rRoot, geo.earth.rRoot);
      const k = norm(em);
      const rM = sub(geo.com, geo.moon.rRoot);
      let n = norm(cross(rM, geo.v));
      n = norm(rej(n, k));
      if (!Number.isFinite(n.x) || len(n) < 0.5) n = anyOrth(k);
      const lateral = rotAbout(n, k, 0.6 * DEG * t);
      const eye = add(add(geo.moon.rRoot, mul(k, 1.25e7)), mul(lateral, 3.4e6));
      const rel = sub(eye, geo.earth.rRoot);
      return mapOrbit(norm(rel), len(rel) - RADIUS.earth);
    },
  };

  function mapOrbit(dir, dist) {
    return { az: Math.atan2(dir.y, dir.x), el: Math.asin(clamp(dir.z, -1, 1)), dist };
  }

  // ------------------------------------------------------------------------------------------ the plan
  // Per pilot phase: `at` = a list of [seconds into the phase, shot, rec, hud]; the last entry before `t` wins,
  // and when the list is exhausted the `cycle` (if any) repeats every `every` seconds. rec: true (record while the
  // entry is the shot), a number (record that many seconds of it), false / absent (do not record); recording
  // starts a second before an entry that records, so the file is open at the cut. hud: false hides the HUD (a
  // beauty shot). `rec: 'all'` on the phase records all of it. `dynamic` phases choose in code. Shots:
  // 'chase:<name>', 'map:<name>', 'cockpit'. Phases not listed fall back to their group (not recorded).
  const DEEP = { cycle: ['chase:bestBody', 'chase:earthBehind', 'chase:moonBehind'], every: 16 };
  const LUNAR_ORBIT = { cycle: ['chase:limb', 'chase:burnSide', 'chase:earthrise', 'chase:burnHigh'], every: 15 };
  const EARTH_ORBIT = { cycle: ['chase:limb', 'chase:burnSide', 'chase:burnHigh'], every: 16 };
  const PLAN = {
    test: { rec: 'all', at: [[0, 'chase:padDefault'], [6, 'chase:padWide', true, false], [12, 'cockpit'], [16, 'map:parking'], [20, 'chase:padLow', true, false], [26, 'chase:padTop']] },
    // The pad before the pilot starts (record.mjs: 40 s).
    pad: { rec: 'all', at: [[0, 'chase:padWide', true, false], [11, 'chase:padLow', true, false], [21, 'chase:padSide', true, false], [30, 'chase:padTop', true, true]] },
    prelaunch: { dynamic: 'prelaunch' },
    ignition: { rec: 'all', at: [[0, 'chase:padDefault']] },
    vertical: { rec: 'all', dynamic: 'vertical' },
    pitchProgramme: { rec: 'all', dynamic: 'ascent' },
    m1Separation: { rec: 'all', at: [[0, 'chase:sepClose']] },
    m2Ascent: { dynamic: 'm2' },
    seco: { rec: 'all', at: [[0, 'chase:sep2Close']] },
    dropM2: { rec: 'all', at: [[0, 'chase:sep2Close']] },
    parkingCoast: { at: [[0, 'chase:limb'], [10, 'chase:burnHigh'], [26, 'map:parking'], [40, 'chase:limb']], ...EARTH_ORBIT },
    'tli:plan': { at: [[0, 'chase:limb']] },
    'tli:align': { at: [[0, 'map:parking'], [5, 'map:parking', 7], [18, 'chase:burnSide']] },
    'tli:coast': { at: [[0, 'chase:limb'], [8, 'chase:burnSide'], [40, 'map:parking']], ...EARTH_ORBIT },
    'tli:burn': { at: [[0, 'chase:burnHigh', 10], [16, 'chase:burnSide'], [28, 'map:translunar', 8], [44, 'chase:burnHigh'], [60, 'chase:burnLimb']], cycle: ['chase:burnSide', 'chase:burnLimb', 'chase:burnHigh'], every: 20 },
    'tli:tail': { rec: 'all', at: [[0, 'chase:burnLimb']] },
    postTli: { rec: 'all', at: [[0, 'map:translunar']] },
    'tliTrim:align': { at: [[0, 'chase:earthBehind', 7]], ...DEEP },
    translunar: { at: [[0, 'chase:earthBehind'], [10, 'map:translunar'], [30, 'chase:bestBody', 6], [46, 'chase:earthBehind']], ...DEEP },
    coastToMoon: { at: [[0, 'chase:moonBehind', 6], [20, 'map:translunar'], [50, 'chase:earthBehind'], [80, 'chase:moonBehind', 6]], ...DEEP },
    moonArrival: { at: [[0, 'map:lunar', 8], [12, 'chase:moonBehind'], [30, 'chase:bestBody']] },
    'loi:coast': { at: [[0, 'map:lunar'], [12, 'chase:moonBehind']], ...DEEP },
    'loi:burn': { at: [[0, 'chase:burnLimb', 10], [18, 'chase:burnSide'], [34, 'map:lunar'], [46, 'chase:burnHigh']], cycle: ['chase:burnLimb', 'chase:burnSide'], every: 20 },
    'loi:tail': { at: [[0, 'chase:limb']] },
    lunarOrbit: { at: [[0, 'chase:limb']] },
    'planeTrim:coast': { at: [[0, 'chase:limb', 9, false], [16, 'chase:earthrise', 9, false], [34, 'chase:burnSide']], ...LUNAR_ORBIT },
    'deorbit:burn': { at: [[0, 'chase:burnSide']] },
    pdiCoast: { at: [[0, 'chase:limb'], [16, 'chase:earthrise', 7, false], [40, 'chase:descentAbove'], [70, 'chase:limbLow', 8]], ...LUNAR_ORBIT },
    braking: { dynamic: 'braking' },
    approach: { rec: 'all', at: [[0, 'chase:landingSide']] },
    terminal: { rec: 'all', at: [[0, 'chase:landingSide'], [16, 'chase:landingLow']] },
    touchdown: { rec: 'all', at: [[0, 'chase:landingLow']] },
    surface: { rec: 'all', at: [[0, 'chase:surfaceOrbit', true, false], [11, 'chase:surfaceHigh', true, false], [20, 'chase:surfaceWide', true, true]] },
    lunarLiftoff: { rec: 'all', at: [[0, 'chase:moonLiftoff']] },
    lunarAscent: { at: [[0, 'chase:moonLiftoff', 10], [10, 'chase:ascentSide', 8], [34, 'chase:limb'], [54, 'chase:earthrise', 7, false]], ...LUNAR_ORBIT },
    'tei:coast': { at: [[0, 'chase:limb'], [20, 'chase:earthrise', 8, false], [40, 'chase:burnHigh']], ...LUNAR_ORBIT },
    'tei:burn': { at: [[0, 'chase:burnLimb', 9], [18, 'chase:moonBehind', 8], [34, 'chase:burnSide']], cycle: ['chase:moonBehind', 'chase:burnLimb'], every: 16 },
    coastFromMoon: { at: [[0, 'chase:moonBehind', 8], [18, 'map:returnLeg', 8], [40, 'chase:bestBody']], ...DEEP },
    transEarth: { at: [[0, 'chase:earthBehind'], [30, 'map:returnLeg'], [60, 'chase:moonBehind'], [92, 'chase:earthBehind', 8]], ...DEEP },
    entryPrep: { at: [[0, 'chase:entryHigh']] },
    entry: { dynamic: 'entry' },
    chutes: { rec: 'all', dynamic: 'chutes' },
    splashdown: { dynamic: 'chutes' },
    done: { rec: 'all', dynamic: 'afloat' },
    // The chute test (qa-drogues): the same shots as the flight's chutes and splash.
    chutesTest: { rec: 'all', dynamic: 'chutes' },
  };
  /** Phases without an entry: by prefix and situation (not recorded). */
  function groupOf(ph, geo) {
    if (!geo) return { at: [[0, 'chase:limb']] };
    if (geo.bodyId === 'moon') {
      if (geo.situation === 'landed') return PLAN.surface;
      if (len(geo.r) - RADIUS.moon > 3e6) return DEEP_DEFAULT;
      return ph.endsWith(':burn') ? PLAN['tei:burn'] : LUNAR_ORBIT_DEFAULT;
    }
    if (len(geo.r) - RADIUS.earth > 3e6) return DEEP_DEFAULT;
    if (ph.endsWith(':burn')) return { at: [[0, 'chase:burnSide'], [16, 'chase:burnLimb']], cycle: ['chase:burnHigh', 'chase:burnSide'], every: 16 };
    return EARTH_ORBIT_DEFAULT;
  }
  const LUNAR_ORBIT_DEFAULT = { at: [[0, 'chase:limb']], ...LUNAR_ORBIT };
  const EARTH_ORBIT_DEFAULT = { at: [[0, 'chase:limb']], ...EARTH_ORBIT };
  const DEEP_DEFAULT = { at: [[0, 'chase:bestBody']], ...DEEP };

  /** { id, rec, hud } for phase `ph` at `t` s into it. */
  function chooseShot(ph, t, geo, b) {
    const plan = PLAN[ph] ?? groupOf(ph, geo);
    let pick;
    if (plan.dynamic) pick = dynamicShot(plan.dynamic, t, geo, b);
    else {
      let e = plan.at[0];
      for (const x of plan.at) if (t >= x[0]) e = x;
      pick = { id: e[1], rec: recOf(e, t), hud: e[3] !== false };
      // Open the file a second before an entry that records.
      for (const x of plan.at) if (x[0] > t && x[0] - t < 1.0 && x[2]) pick.rec = true;
      const lastAt = plan.at[plan.at.length - 1][0];
      if (plan.cycle && t - lastAt >= (plan.every ?? 16)) {
        const k = Math.floor((t - lastAt) / (plan.every ?? 16));
        pick = { id: plan.cycle[(k - 1) % plan.cycle.length], rec: false, hud: true };
      }
    }
    if (plan.rec === 'all') pick.rec = true;
    // The chute rehearsal closes and reopens its file once (the duty windows of the flight).
    if (ph === 'chutesTest' && t > 20 && t < 28) pick.rec = false;
    let id = pick.id;
    // A body that sits next to the Sun is seen dark against the glare: take the better one instead.
    if (geo && (id === 'chase:earthBehind' || id === 'chase:moonBehind')) {
      const bg = bodyGeo(geo, id === 'chase:earthBehind' ? 'earth' : 'moon');
      if (angle(bg.tb, geo.sunDir) < 40 * DEG || bg.lit < 0.15) id = 'chase:bestBody';
    }
    // An earthrise that does not fit falls back to a limb shot.
    if (id === 'chase:earthrise' && geo && !earthrise(geo, 0).fits) id = 'chase:burnHigh';
    pick.id = id;
    return pick;
  }
  function recOf(e, t) {
    const r = e[2];
    if (r === true) return true;
    if (typeof r === 'number') return t - e[0] < r;
    return false;
  }

  function dynamicShot(kind, t, geo, b) {
    const met = b.met;
    const now = performance.now();
    switch (kind) {
      case 'prelaunch':
        // The pilot warps to T-15 s; the last real-time seconds in the pad's default view (the trench jets left
        // and right of the vehicle at ignition).
        if (b.warpFactor <= 1 && t > 3) return { id: 'chase:padDefault', rec: true, hud: true };
        return { id: t < 16 ? 'chase:padTop' : 'chase:padSide', rec: t > 8 && t < 15, hud: true };
      case 'vertical':
        return { id: t < 2.5 ? 'chase:padDefault' : 'chase:liftoffPull', rec: true, hud: true };
      case 'ascent':
        if (met >= REF_MET.STAGE_SEP_1 - 14) return { id: 'chase:sepClose', rec: true, hud: true };
        if (met >= REF_MET.MAX_Q - 30 && met < REF_MET.MAX_Q + 22) return { id: 'chase:maxqBelow', rec: true, hud: true };
        return { id: t < 6 ? 'chase:climbSide' : 'chase:climbBehind', rec: true, hud: true };
      case 'm2': {
        const fairingDone = milestoneAt.FAIRING_JETTISON ? (now - milestoneAt.FAIRING_JETTISON) / 1000 : -1;
        if (t < 7) return { id: 'chase:sepClose', rec: true, hud: true };
        if ((b.nextStage <= 2 && met >= REF_MET.FAIRING_JETTISON - 12) || (fairingDone >= 0 && fairingDone < 9)) return { id: 'chase:fairingClose', rec: true, hud: true };
        const k = Math.floor(t / 18) % 2;
        return { id: k ? 'chase:sideLimb' : 'chase:limbAscent', rec: t < 14 || (fairingDone >= 0 && fairingDone < 11) || (t > 72 && t < 86), hud: !(t > 74 && t < 88) };
      }
      case 'braking': {
        const k = Math.floor(t / 20) % 3;
        const id = ['chase:descentSide', 'chase:descentBehind', 'chase:descentAbove'][k];
        const inK = t % 20;
        const rec = (k === 0 && t < 20 && inK < 10) || (k === 2 && inK < 10 && t < 70) || (geo && geo.radar < 2000);
        return { id, rec, hud: true };
      }
      case 'entry':
        return entryShot(t, geo, b);
      case 'chutes':
        return chuteOrSplash(t, geo, b);
      case 'afloat': {
        const ts = milestoneAt.__splash ? (now - milestoneAt.__splash) / 1000 : t;
        if (ts < 22) return { id: 'chase:splash', rec: true, hud: true };
        if (ts < 34) return { id: 'chase:afloat', rec: true, hud: false };
        return { id: 'chase:afloatWide', rec: true, hud: false };
      }
    }
    return { id: 'chase:limb', rec: false, hud: true };
  }

  function entryShot(t, geo, b) {
    const alt = b.altitudeAsl;
    const now = performance.now();
    if (geo) {
      if (geo.heatFlux > entry.maxFlux) entry.maxFlux = geo.heatFlux;
      if (!entry.peakHeatAt && entry.maxFlux > 1e6 && geo.heatFlux < 0.97 * entry.maxFlux) {
        entry.peakHeatAt = now;
        log('peak', { what: 'heatFlux', value: entry.maxFlux, alt });
      }
      if (geo.gLoad > entry.maxG) entry.maxG = geo.gLoad;
      if (!entry.peakGAt && entry.maxG > 3 && geo.gLoad < 0.95 * entry.maxG) {
        entry.peakGAt = now;
        log('peak', { what: 'gLoad', value: entry.maxG, alt });
      }
    }
    if (alt < 40e3 && !entry.below40At) entry.below40At = now;
    if (alt > 100e3) return { id: t % 32 < 16 ? 'chase:entryHigh' : 'chase:entrySide', rec: t < 8, hud: true };
    // Through the plasma: side, behind, front; after the peak of the heating the camera pulls back while the load
    // peaks (the capsule burns out to white close up then), and closes in again once the glow has gone.
    if (entry.peakHeatAt && now - entry.peakHeatAt > 3000 && (!entry.peakGAt || now - entry.peakGAt < 12000) && alt > 30e3) return { id: 'chase:entryFar', rec: true, hud: true };
    if (alt > 40e3) {
      const k = Math.floor(t / 12) % 3;
      return { id: ['chase:entrySide', 'chase:entryBehind', 'chase:entryFront'][k], rec: true, hud: true };
    }
    const since40 = (now - entry.below40At) / 1000;
    return { id: 'chase:entryBehind', rec: since40 < 8 || alt < 11e3, hud: true };
  }

  function chuteOrSplash(t, geo, b) {
    const now = performance.now();
    if (b.situation === 'splashed' || b.milestones.includes('SPLASHDOWN')) {
      if (!milestoneAt.__splash) milestoneAt.__splash = now;
      const ts = (now - milestoneAt.__splash) / 1000;
      if (ts < 22) return { id: 'chase:splash', rec: true, hud: true };
      if (ts < 34) return { id: 'chase:afloat', rec: true, hud: false };
      return { id: 'chase:afloatWide', rec: true, hud: false };
    }
    if (!geo || geo.chutes.length === 0) return { id: 'chase:entryBehind', rec: true, hud: true };
    // Near the water the eye below the capsule would be under the sea: from the side for the splash.
    if (geo.radar < 220) return { id: 'chase:splash', rec: true, hud: true };
    const main = geo.chutes.some((c) => c.main);
    if (main && !milestoneAt.__main) milestoneAt.__main = now;
    const tm = milestoneAt.__main ? (now - milestoneAt.__main) / 1000 : t;
    // The mains' descent is long (about 80 s at 4x): two shots of it and the last 400 m are recorded.
    const rec = !main || tm < 34 || geo.radar < 420;
    if (main && Math.floor(tm / 17) % 2 === 1) return { id: 'chase:chuteSide', rec, hud: true };
    return { id: 'chase:chuteBelow', rec, hud: tm > 50 ? false : true };
  }

  // ------------------------------------------------------------------------------------------ apply
  function applyView(mode) {
    if (requestedView !== mode) {
      requestedView = mode;
      T.setView(mode);
      log('view', { mode });
    }
  }

  function setOrbitSmooth(target, kind, dtS, cut) {
    const logd = Math.log(target.dist);
    if (!cam || cam.kind !== kind || cut) cam = { az: target.az, el: target.el, logd, kind };
    else {
      const k = 1 - Math.exp(-dtS / 0.9);
      cam.az += wrapPi(target.az - cam.az) * k;
      cam.el += (target.el - cam.el) * k;
      cam.logd += (logd - cam.logd) * k;
    }
    T.setCameraOrbit(cam.az, cam.el, Math.exp(cam.logd));
  }

  /** The default chase view as it is at the start, in the rig's frame (the pad: its surface frame). */
  function readDefaultView() {
    const geo = sample();
    if (!geo) return null;
    const c = T.camera();
    if (!c || !c.positionRoot) return null;
    const rel = sub(c.positionRoot, geo.com);
    const dir = norm(rel);
    const fr = rigFrame(geo, A.brief().navballMode);
    return { az: Math.atan2(dot(dir, fr.Y), dot(dir, fr.X)), el: Math.asin(clamp(dot(dir, fr.Z), -1, 1)), dist: len(rel) };
  }

  let lastFrame = performance.now();
  let statusAt = 0;
  let lastWant = null;
  let lastHud = null;
  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dtS = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!D.enabled) return;
    try {
      const b = A.brief();
      if (now - lastSampleAt > 200) {
        g = sample();
        lastSampleAt = now;
      }
      if (b.milestones.length !== lastMilestones) {
        for (const id of b.milestones.slice(lastMilestones)) {
          milestoneAt[id] = now;
          log('milestone', { id, met: b.met, alt: b.altitudeAsl, warp: b.warpFactor });
        }
        lastMilestones = b.milestones.length;
      }
      const pilotPhase = T.pilot && T.pilot.phase ? T.pilot.phase() : null;
      const done = T.pilot && T.pilot.done ? T.pilot.done() : false;
      let ph = D.plan === 'test' ? 'test' : D.plan === 'chutes' ? 'chutesTest' : pilotPhase === null ? 'pad' : done ? 'done' : pilotPhase;
      if (ph === 'chutesTest' && (done || b.situation === 'splashed')) ph = 'done';
      // The full plan's one intervention: the moment the second stage has gone, stop the pilot before it warps
      // on rails, back to real time (the '/' key's command), and hand over to the recorder's heads-down routine.
      if (D.plan === 'full' && D.routine === 'idle' && ((ph === 'dropM2' && b.nextStage >= 4) || ph === 'parkingCoast')) {
        T.pilot.stop();
        if (b.warpIndex !== 0) T.commands.setWarpLevel(0);
        D.routine = 'requested';
        D.setOverride({ shot: 'chase:sep2Close', rec: true, hud: true });
        log('pilot', { action: 'stop', phase: ph, warp: b.warpFactor, why: 'heads-down roll for the cockpit' });
      }
      if (ph !== phase) {
        log('phase', { phase: ph, met: b.met, alt: b.altitudeAsl, warp: b.warpFactor });
        phase = ph;
        phaseSince = now;
      }
      const t = (now - phaseSince) / 1000;
      const pick = D.override ? { id: D.override.shot, rec: !!D.override.rec, hud: D.override.hud !== false } : chooseShot(ph, t, g, b);
      const id = pick.id;
      let cut = false;
      if (!shot || shot.id !== id) {
        shot = { id, since: now };
        cut = true;
        log('shot', { shot: id, phase: ph, alt: b.altitudeAsl, warp: b.warpFactor, met: b.met });
      }
      D.shot = shot.id;
      D.wantRec = !!pick.rec;
      D.hudWant = pick.hud;
      if (D.wantRec !== lastWant) {
        lastWant = D.wantRec;
        log('want', { rec: D.wantRec, shot: id });
      }
      if (D.hudWant !== lastHud) {
        lastHud = D.hudWant;
        log('hudWant', { hud: D.hudWant, shot: id });
      }
      const ts = (now - shot.since) / 1000;
      const [kind, name] = id.split(':');
      if (kind === 'cockpit') {
        applyView('cockpit');
      } else if (kind === 'map') {
        applyView('map');
        if (g && mapShots[name]) setOrbitSmooth(mapShots[name](g, ts), 'map', dtS, cut);
      } else {
        applyView('chase');
        if (g && chase[name] && b.viewMode === 'chase') {
          const r = chase[name](g, ts);
          let target;
          if (r.rig) target = { az: r.rig.az, el: r.rig.el, dist: r.dist };
          else {
            const fr = rigFrame(g, b.navballMode);
            const dir = r.dir;
            target = { az: Math.atan2(dot(dir, fr.Y), dot(dir, fr.X)), el: Math.asin(clamp(dot(dir, fr.Z), -1, 1)), dist: r.dist };
          }
          // Cut on a new shot, and also when the view just came back to the chase rig.
          setOrbitSmooth(target, 'chase', dtS, cut || cam?.kind !== 'chase');
          if (r.bodyId && cut) log('shotInfo', { shot: id, body: r.bodyId, lit: +r.lit.toFixed(2), angDeg: +r.angDeg.toFixed(2) });
        }
      }
      if (now - statusAt > 1000) {
        statusAt = now;
        log('status', { phase: ph, shot: id, view: b.viewMode, rec: D.wantRec, hud: A.hudVisible(), alt: Math.round(b.altitudeAsl), warp: b.warpFactor, met: Math.round(b.met), body: g?.bodyId, situation: g?.situation, chutes: g?.chutes?.length ?? 0, roll: +b.rollDeg.toFixed(1), sampleMs: +D.sampleMs.toFixed(2) });
      }
    } catch (e) {
      if (D.errors.length < 50) D.errors.push(String(e && e.stack ? e.stack : e));
    }
  }
  requestAnimationFrame(tick);

  D.start = (plan) => {
    D.plan = plan ?? 'full';
    try {
      D.padDefault = readDefaultView();
    } catch (e) {
      D.errors.push(String(e));
    }
    log('directorStart', { plan: D.plan, padDefault: D.padDefault ? { az: +(D.padDefault.az / DEG).toFixed(2), el: +(D.padDefault.el / DEG).toFixed(2), dist: +D.padDefault.dist.toFixed(1) } : null });
    D.enabled = true;
    phase = null;
    shot = null;
  };
  D.stop = () => {
    D.enabled = false;
    log('directorStop', {});
  };
})();
