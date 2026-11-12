/**
 * Footage director: injected into the game page (`/` with `capture=0`) by tools/footage/record.mjs.
 *
 * CAMERA AND VIEW ONLY. It reads `window.__app.brief()`, `window.__test.pilot.phase()` and (a few times a second)
 * `window.__test.state()`, and it writes nothing but `window.__test.setView(mode)` (what C and M do) and
 * `window.__test.setCameraOrbit(azimuth, elevation, distance)` (what the arrow keys, PgUp/PgDn and the wheel do).
 * It never touches the flight controls, time warp, pause, the pilot, the map's pointer or any command.
 *
 * Shots are chosen from the pilot's phase, the time spent in it and the milestones. A chase shot names the eye
 * direction (from the vessel's centre of mass to the eye, ROOT axes) and the distance; the director re-expresses
 * it in the chase rig's reference frame (src/camera/chaseRig.ts: the local vertical is up; azimuth from north in
 * the navball's surface mode, from the horizontal part of the velocity in orbit mode) and eases the rig there
 * every frame. A map shot names the map rig's orbit
 * (azimuth about ROOT +Z, elevation above the ROOT equator, distance from the focus surface).
 *
 * Every shot change, phase and milestone is logged with performance.now() so the editor can cut the recording.
 */
(() => {
  if (window.__director) return;
  const T = window.__test;
  const A = window.__app;
  const DEG = Math.PI / 180;
  const RADIUS = { earth: 6371000, moon: 1737400 };

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
  const lerp3 = (a, b, k) => add(mul(a, 1 - k), mul(b, k));
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
    drain() {
      const e = this.events;
      this.events = [];
      return e;
    },
  });
  const log = (type, data) => D.events.push({ t: performance.now(), type, ...data });

  let g = null; // geometry sampled from state()
  let lastSampleAt = -1e9;
  let phase = null;
  let phaseSince = performance.now();
  let lastMilestones = 0;
  const milestoneAt = {};
  let shot = null; // { id, since, spec }
  let cam = null; // smoothed { az, el, logd, kind }
  let requestedView = null;
  let startedAt = 0;

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
      vessels: s.vessels.length,
    };
    D.lastSample = { ut: out.ut, bodyId: out.bodyId, alt: out.alt, mode: out.mode, situation: out.situation, sampleMs: D.sampleMs };
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
  // Each chase shot returns { dir (unit, COM -> eye, ROOT), dist (m) } for geometry `geo` and shot time `t` (s).
  const chase = {
    // Pad: low on the starboard / dorsal side, looking up the stack (the tower behind it at az 90).
    padLow: (geo, t) => ({ dir: padDir(geo, 4 + 0.5 * t, -3), dist: 130 }),
    padUp: (geo, t) => ({ dir: padDir(geo, 22 + 0.7 * t, -24), dist: 46 }),
    padHigh: (geo, t) => ({ dir: padDir(geo, -12 + 0.9 * t, 24), dist: 175 }),
    padPort: (geo, t) => ({ dir: padDir(geo, 178 - 0.6 * t, 3), dist: 120 }),
    ignition: (geo, t) => ({ dir: padDir(geo, 18 + 0.5 * t, -15), dist: 62 }),
    liftoff: (geo, t) => ({ dir: padDir(geo, 22 + 0.6 * t, Math.min(4, -8 + 0.8 * t)), dist: 85 + 3 * t }),
    // Ascent (heading = the nose's horizontal part).
    climbSide: (geo, t) => ({ dir: sph(basis(geo), 100, 2), dist: 95 }),
    climbBehind: (geo, t) => ({ dir: sph(basis(geo), 150 - 0.5 * t, 6), dist: 110 }),
    sepWide: (geo, t) => ({ dir: sph(basis(geo), 125, 7), dist: 150 }),
    fairing: (geo, t) => ({ dir: sph(basis(geo), 65, 8), dist: 70 }),
    limbAscent: (geo, t) => ({ dir: sph(basis(geo), 160 - 0.6 * t, 16), dist: 90 }),
    sideLimb: (geo, t) => ({ dir: sph(basis(geo), 92, 13), dist: 85 }),
    // Orbit: eye above and behind, looking down at the vessel with the limb across the frame.
    limb: (geo, t, o = {}) => limbShot(geo, t, o),
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
    moonLiftoff: (geo, t) => ({ dir: earthFacing(geo, 90, 22), dist: 40 + 3 * t }),
    ascentSide: (geo, t) => ({ dir: sph(basis(geo), 95, 14), dist: 50 }),
    // Entry, chutes, splashdown (heading = velocity).
    entryHigh: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 150, 18), geo.up), dist: 24 }),
    entrySide: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 105 - 0.4 * t, 6), geo.up), dist: 16 }),
    entryBehind: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 168, 10), geo.up), dist: 20 }),
    entryFront: (geo, t) => ({ dir: avoidSun(geo, sph(basis(geo, 'velocity'), 35, 4), geo.up), dist: 18 }),
    drogue: (geo, t) => ({ dir: sunSide(geo, 30 + 1.5 * t, -14), dist: 38 }),
    mains: (geo, t) => ({ dir: sunSide(geo, 60 + 1.2 * t, -10), dist: 60 }),
    mainsHigh: (geo, t) => ({ dir: sunSide(geo, 120 + 1.0 * t, 8), dist: 70 }),
    splash: (geo, t) => ({ dir: sunSide(geo, 20 + 2.5 * t, 5), dist: 26 }),
    splashWide: (geo, t) => ({ dir: sunSide(geo, 140 + 1.5 * t, 9), dist: 55 }),
  };

  /** Pad / landed: azimuth in the plane of the vessel's starboard (+X, 0 deg) and dorsal (+Z, 90 deg) axes. */
  function padDir(geo, azDeg, elDeg) {
    const up = geo.up;
    const x = norm(rej(geo.ax, up));
    const z = norm(rej(geo.az, up));
    const a = azDeg * DEG;
    const e = elDeg * DEG;
    return avoidSun(geo, norm(add(mul(add(mul(x, Math.cos(a)), mul(z, Math.sin(a))), Math.cos(e)), mul(up, Math.sin(e)))), up, 45);
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

  /** Eye on the sunlit side (azimuth 0 = toward the Sun's azimuth). */
  function sunSide(geo, azDeg, elDeg) {
    const up = geo.up;
    let h = rej(geo.sunDir, up);
    h = len(h) < 1e-6 ? anyOrth(up) : norm(h);
    const bs = { up, h, side: cross(up, h) };
    return avoidSun(geo, sph(bs, azDeg % 360 > 180 ? (azDeg % 360) - 360 : azDeg % 360, elDeg), up, 40);
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
  // Per pilot phase: a list of [seconds into the phase, shot]; the last entry before `t` wins, and when a phase's
  // list is exhausted the `cycle` (if any) repeats every `every` seconds. Shots: 'chase:<name>', 'map:<name>',
  // 'cockpit'. Phases not listed fall back to their group.
  const DEEP = { cycle: ['chase:bestBody', 'chase:earthBehind', 'chase:moonBehind'], every: 16 };
  const LUNAR_ORBIT = { cycle: ['chase:limb', 'chase:burnSide', 'chase:earthrise', 'chase:burnHigh'], every: 15 };
  const EARTH_ORBIT = { cycle: ['chase:limb', 'chase:burnSide', 'chase:burnHigh'], every: 16 };
  const PLAN = {
    test: { at: [[0, 'chase:padLow'], [8, 'cockpit'], [12, 'map:parking'], [17, 'chase:padUp']] },
    pad: { at: [[0, 'chase:padLow'], [14, 'chase:padUp'], [26, 'chase:padPort'], [37, 'cockpit'], [44, 'chase:padHigh']] },
    prelaunch: { at: [[0, 'chase:padHigh'], [14, 'chase:padLow']] },
    ignition: { at: [[0, 'chase:ignition']] },
    vertical: { at: [[0, 'chase:liftoff']] },
    pitchProgramme: { at: [[0, 'chase:liftoff'], [7, 'chase:climbSide'], [19, 'cockpit'], [25, 'chase:climbBehind']] },
    m1Separation: { at: [[0, 'chase:sepWide']] },
    m2Ascent: { at: [[0, 'chase:sepWide'], [14, 'chase:limbAscent'], [38, 'chase:sideLimb'], [62, 'chase:limbAscent'], [85, 'chase:sideLimb']] },
    seco: { at: [[0, 'chase:sideLimb']] },
    dropM2: { at: [[0, 'chase:sepWide']] },
    parkingCoast: { at: [[0, 'chase:limb'], [18, 'chase:burnSide'], [34, 'map:parking'], [48, 'chase:burnHigh'], [64, 'cockpit'], [72, 'chase:limb']], ...EARTH_ORBIT },
    'tli:coast': { at: [[0, 'chase:burnSide'], [20, 'map:parking'], [32, 'chase:limb']], ...EARTH_ORBIT },
    'tli:burn': { at: [[0, 'chase:burnLimb'], [24, 'chase:burnSide'], [48, 'chase:burnHigh'], [70, 'chase:burnLimb']], cycle: ['chase:burnSide', 'chase:burnLimb', 'chase:burnHigh'], every: 20 },
    'tli:tail': { at: [[0, 'chase:burnLimb']] },
    postTli: { at: [[0, 'map:translunar']] },
    'tliTrim:align': { at: [[0, 'map:translunar'], [10, 'chase:earthBehind']], ...DEEP },
    translunar: { at: [[0, 'chase:earthBehind'], [20, 'map:translunar'], [36, 'chase:bestBody']], ...DEEP },
    coastToMoon: { at: [[0, 'chase:moonBehind'], [16, 'chase:earthBehind'], [32, 'map:translunar'], [46, 'chase:moonBehind']], ...DEEP },
    moonArrival: { at: [[0, 'chase:moonBehind']] },
    'loi:burn': { at: [[0, 'chase:moonBehind'], [16, 'chase:burnLimb'], [40, 'chase:burnSide'], [62, 'chase:burnHigh']], cycle: ['chase:burnLimb', 'chase:burnSide'], every: 20 },
    'loi:tail': { at: [[0, 'chase:limb']] },
    lunarOrbit: { at: [[0, 'chase:limb']] },
    'planeTrim:coast': { at: [[0, 'chase:limb'], [14, 'map:lunar'], [30, 'chase:earthrise'], [44, 'chase:burnSide']], ...LUNAR_ORBIT },
    pdiCoast: { at: [[0, 'chase:limb'], [20, 'chase:earthrise'], [36, 'chase:burnSide']], ...LUNAR_ORBIT },
    braking: { at: [[0, 'chase:descentSide']], cycle: ['chase:descentBehind', 'chase:descentSide', 'chase:descentAbove'], every: 16 },
    approach: { at: [[0, 'chase:landingSide']] },
    terminal: { at: [[0, 'chase:landingSide'], [14, 'cockpit'], [22, 'chase:landingLow']] },
    touchdown: { at: [[0, 'chase:landingLow']] },
    surface: { at: [[0, 'chase:surfaceOrbit'], [10, 'cockpit'], [17, 'chase:surfaceHigh'], [27, 'chase:surfaceOrbit']] },
    lunarLiftoff: { at: [[0, 'chase:moonLiftoff']] },
    lunarAscent: { at: [[0, 'chase:moonLiftoff'], [14, 'chase:ascentSide'], [34, 'chase:limb'], [54, 'chase:earthrise']], ...LUNAR_ORBIT },
    'lunarCircularise:coast': { at: [[0, 'chase:earthrise'], [16, 'chase:limb']], ...LUNAR_ORBIT },
    'tei:coast': { at: [[0, 'chase:limb'], [16, 'chase:earthrise'], [32, 'chase:burnHigh']], ...LUNAR_ORBIT },
    'tei:burn': { at: [[0, 'chase:burnLimb'], [18, 'chase:burnSide'], [34, 'chase:moonBehind']], cycle: ['chase:moonBehind', 'chase:burnLimb'], every: 16 },
    coastFromMoon: { at: [[0, 'chase:moonBehind'], [18, 'map:returnLeg'], [34, 'chase:bestBody']], ...DEEP },
    transEarth: { at: [[0, 'chase:earthBehind'], [18, 'map:returnLeg'], [32, 'chase:moonBehind'], [48, 'chase:earthBehind']], ...DEEP },
    entryPrep: { at: [[0, 'chase:entryHigh']] },
    entry: { at: [[0, 'chase:entryHigh']], dynamic: 'entry' },
    chutes: { at: [[0, 'chase:drogue']], dynamic: 'chutes' },
    splashdown: { at: [[0, 'chase:mains']], dynamic: 'splash' },
    done: { at: [[0, 'chase:splash']], cycle: ['chase:splash', 'chase:splashWide'], every: 18 },
  };
  /** Phases without an entry: by prefix and situation. */
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

  let cycleCount = 0;
  function chooseShot(ph, t, geo, b) {
    const plan = PLAN[ph] ?? groupOf(ph, geo);
    let id = plan.at[0][1];
    let last = 0;
    for (const [at, s] of plan.at) if (t >= at) {
      id = s;
      last = at;
    }
    if (plan.cycle && t - last >= (plan.every ?? 16) && plan.at[plan.at.length - 1][0] <= t) {
      const k = Math.floor((t - last) / (plan.every ?? 16));
      id = plan.cycle[(k - 1) % plan.cycle.length];
    }
    if (plan.dynamic === 'entry') id = entryShot(t, geo, b);
    if (plan.dynamic === 'chutes') id = chuteShot(t, b);
    if (plan.dynamic === 'splash') id = splashShot(t, b);
    // A body that sits next to the Sun is seen dark against the glare: take the better one instead.
    if (geo && (id === 'chase:earthBehind' || id === 'chase:moonBehind')) {
      const bg = bodyGeo(geo, id === 'chase:earthBehind' ? 'earth' : 'moon');
      if (angle(bg.tb, geo.sunDir) < 40 * DEG || bg.lit < 0.15) id = 'chase:bestBody';
    }
    // An earthrise that does not fit falls back to a limb shot.
    if (id === 'chase:earthrise' && geo && !earthrise(geo, 0).fits) id = 'chase:burnHigh';
    return id;
  }

  function entryShot(t, geo, b) {
    const alt = b.altitudeAsl;
    if (alt > 100e3) return t % 32 < 16 ? 'chase:entryHigh' : 'chase:entrySide';
    // Through the plasma: rotate side / behind / front, with one look out of the window at peak heating.
    if (alt < 72e3 && alt > 58e3 && !milestoneAt.__entryCockpit) {
      milestoneAt.__entryCockpit = performance.now();
    }
    if (milestoneAt.__entryCockpit && performance.now() - milestoneAt.__entryCockpit < 8000) return 'cockpit';
    const k = Math.floor(t / 14) % 3;
    return ['chase:entrySide', 'chase:entryBehind', 'chase:entryFront'][k];
  }
  function chuteShot(t, b) {
    if (b.milestones.includes('MAIN_DEPLOY')) return 'chase:mains';
    return 'chase:drogue';
  }
  function splashShot(t, b) {
    if (b.milestones.includes('SPLASHDOWN')) {
      const ts = (performance.now() - (milestoneAt.SPLASHDOWN ?? performance.now())) / 1000;
      return ts < 20 ? 'chase:splash' : Math.floor(ts / 18) % 2 ? 'chase:splashWide' : 'chase:splash';
    }
    if (!b.milestones.includes('MAIN_DEPLOY')) return 'chase:drogue';
    const ts = (performance.now() - (milestoneAt.MAIN_DEPLOY ?? performance.now())) / 1000;
    return Math.floor(ts / 20) % 2 ? 'chase:mainsHigh' : 'chase:mains';
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

  let lastFrame = performance.now();
  let statusAt = 0;
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
      const ph = D.plan === 'test' ? 'test' : pilotPhase === null ? 'pad' : done ? 'done' : pilotPhase;
      if (ph !== phase) {
        log('phase', { phase: ph, met: b.met, alt: b.altitudeAsl, warp: b.warpFactor });
        phase = ph;
        phaseSince = now;
      }
      const t = (now - phaseSince) / 1000;
      const id = chooseShot(ph, t, g, b);
      let cut = false;
      if (!shot || shot.id !== id) {
        shot = { id, since: now };
        cut = true;
        log('shot', { shot: id, phase: ph, alt: b.altitudeAsl, warp: b.warpFactor, met: b.met });
      }
      D.shot = shot.id;
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
          const fr = rigFrame(g, b.navballMode);
          const dir = r.dir;
          const target = { az: Math.atan2(dot(dir, fr.Y), dot(dir, fr.X)), el: Math.asin(clamp(dot(dir, fr.Z), -1, 1)), dist: r.dist };
          // Cut on a new shot, and also when the view just came back to the chase rig.
          setOrbitSmooth(target, 'chase', dtS, cut || cam?.kind !== 'chase');
          if (r.bodyId && cut) log('shotInfo', { shot: id, body: r.bodyId, lit: +r.lit.toFixed(2), angDeg: +r.angDeg.toFixed(2) });
        }
      }
      if (now - statusAt > 1000) {
        statusAt = now;
        log('status', { phase: ph, shot: id, view: b.viewMode, alt: Math.round(b.altitudeAsl), warp: b.warpFactor, met: Math.round(b.met), body: g?.bodyId, situation: g?.situation, sampleMs: +D.sampleMs.toFixed(2) });
      }
    } catch (e) {
      if (D.errors.length < 50) D.errors.push(String(e && e.stack ? e.stack : e));
    }
  }
  requestAnimationFrame(tick);

  D.start = (plan) => {
    D.plan = plan ?? 'full';
    D.enabled = true;
    startedAt = performance.now();
    phase = null;
    shot = null;
    log('directorStart', { plan: D.plan });
  };
  D.stop = () => {
    D.enabled = false;
    log('directorStop', {});
  };
})();
