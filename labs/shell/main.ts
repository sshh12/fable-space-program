/**
 * Shell and menu lab (shell-menu): the menu over the live scene, the deploy flow, the visible launch queue, the
 * transit to the pad and the flight menu, against the menu store fixture (no network) and Practice.
 *
 * Query: &queue=free|busy|full (pad load of the lobby), &rules=default|staging|local (the lobby's rules
 * document), &ack=<s> (the spawn's acknowledgement is held that long: the transit's holding drift), &refuse=1
 * (the first spawn is refused with an alternative), &link=<LinkState state>, &admission=queued, &scale=<ui
 * scale>, &reduced=1, &planet=1 (the LabPlanet instead of the render packages, for quick looks), plus the lab
 * app's renderer parameters (governor=off, deterministic=1, ...).
 *
 * window.__shell: hooks() (state, focus, scrim count, spawn phase), the fixture (`fixture`), `camera()`, and
 * `transit()` (progress, holding, the per-frame camera steps for the motion bound).
 */
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { padLocationOf, padOf, padsOf } from '@/core/defs/sites';
import type { LinkState, UniverseRules } from '@/core/contracts/net';
import type { SpawnRequest } from '@/core/contracts/session';
import type { BodySnapshot } from '@/core/contracts/sim';
import type { VehicleCapabilities } from '@/core/contracts/vehicle';
import { presentableVehicles } from '@/core/access/presentable';
import { createIdentityFixture } from '@/core/fakes/identityFixture';
import { deltaVToOrbit } from '@/sim/nav/reach';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { DIAMETER_TOLERANCE, LIMIT_TOLERANCE } from '@/sim/vessel/validate';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { createFakeSession, FAKE_SESSION_DEFAULT_UT } from '@/core/fakes/fakeSession';
import { createMenuFixture, menuShipsFixture } from '@/core/fakes/menuStores';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { holdProgress, lookAt, menuEye, rootToFixed, transitPathLength, transitPose, transitSample, type EyePose, type TransitPlan } from '@/camera';
import { DEFAULT_BINDINGS, keyHelpEntries, keyLabel, MENU_BINDINGS, TRANSIT_BINDINGS } from '@/input';
import { createLabApp, createLabPlanetFeature } from '@/render/core/lab';
import { createShell, loadShellFonts, solarViewAt, type ShellIntent } from '@/shell';
import { createTerrainProvider, createFetchTileSource } from '@/terrain';
import { createMfdPainter, createNavballRenderer } from '@/ui';
import { formatApsis, formatDeltaV, formatDuration, formatMass, formatNumber } from '@/ui/format';
import { buildFeatures, importPackages, type FeaturePackage } from '../integration/features';

const query = new URLSearchParams(location.search);
const MENU_ALTITUDE = 800_000;
const SITE_VIEW_ALTITUDE = 2_500_000;
const GLIDE_S = 1.8;

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  const bootSteps = [
    { label: 'Definitions', done: 0, total: 1, finished: false },
    { label: 'Type', done: 0, total: 1, finished: false },
    { label: 'Render features', done: 0, total: 0, finished: false },
    { label: 'The view from orbit', done: 0, total: 1, finished: false },
  ];
  // &holdboot=1 (the cold-start test): the hangar's data is not resident until the test releases it
  // (`__shell.releaseHangar()`); the title must show the progress and keep Play closed until then.
  const hangarStep = query.get('holdboot') === '1' ? { label: 'Hangar', done: 0, total: 1, finished: false } : null;
  if (hangarStep) bootSteps.push(hangarStep);
  const defs = await loadDefs(fetchDefSource());
  bootSteps[0]!.done = 1;
  bootSteps[0]!.finished = true;
  const site = Object.values(defs.sites).sort((a, b) => a.name.localeCompare(b.name))[0]!;
  const loc = padLocationOf(site);
  const padElevation = typeof loc.padElevation === 'number' ? loc.padElevation : 0;
  // &padhour=<h>: the local solar hour at the pad (a night pad for the exposure at the hand-over); the fake's own start otherwise.
  const padHour = query.get('padhour');
  let ut = FAKE_SESSION_DEFAULT_UT;
  if (padHour !== null) {
    const probe = createFakeSession(defs, { scene: 'pad', siteId: site.id, ground: { height: padElevation, originHeight: 0 } });
    const earth0 = probe.snapshot().bodies.find((b) => b.id === site.bodyId)!;
    const now = solarViewAt(earth0, loc.latDeg, loc.lonDeg).localSolarHours;
    ut += ((((Number(padHour) - now) % 24) + 24) % 24) * 3600;
  }
  // The vessel on the pad, and the Hangar's turntable: the first PRESENTABLE vehicle of the library (every part has
  // a visual; today the lunar stack), assembled with the frozen facade. A vehicle that cannot be shown is never built here.
  const displayVehicle = presentableVehicles(defs)[0] ?? null;
  const displayId = displayVehicle?.id ?? null;
  const displayParts = displayId ? vesselPartSnapshots(assembleVessel(defs, displayId)) : [];
  // The stack stands on the pad's mount: its lowest point (part bounds along +Y) at the mount height above the pad.
  let stackLow = 0;
  let stackHigh = 0;
  for (const p of displayParts) {
    const bounds = defs.parts[p.def]?.bounds;
    if (!bounds) continue;
    stackLow = Math.min(stackLow, p.localPos.y + bounds.yMin);
    stackHigh = Math.max(stackHigh, p.localPos.y + bounds.yMax);
  }
  const display = displayId ? { vehicleId: displayId, parts: displayParts } : {};
  const sim = createFakeSession(defs, { scene: 'pad', siteId: site.id, ut, ground: { height: padElevation, originHeight: -stackLow, clearance: padOf(site).mountHeight }, ...display });
  const app = await createLabApp({ canvas, name: 'shell', defs, sim, features: [], autoReady: false });
  const errors = (m: string): void => app.testApi.reportError(m);
  const fonts = loadShellFonts('/assets/ui/fonts/', errors).then(() => {
    bootSteps[1]!.done = 1;
    bootSteps[1]!.finished = true;
  });

  // The lobby: the menu fixture (no network). Practice: the same fixture on the local rules, its own pads, never queuing.
  const rulesId = query.get('rules') ?? 'default';
  const lobbyRules: UniverseRules | undefined = defs.rules?.[rulesId];
  const fixture = createMenuFixture(defs, {
    rulesId,
    padLoad: (query.get('queue') as 'free' | 'busy' | 'full' | null) ?? 'busy',
    ships: menuShipsFixture(defs, Date.now(), lobbyRules),
    ackDelaySeconds: Number(query.get('ack') ?? '0'),
    link: (query.get('link') as LinkState['state'] | null) ?? 'online',
    admission: query.get('admission') === 'queued' ? { status: 'queued', position: 214, etaSeconds: 190 } : undefined,
  });
  // &refuse=1: the first launch is refused with another pad of the first pad's class as the alternative.
  const altPad = padsOf(site).find((p) => p.id !== padOf(site).id && p.class === padOf(site).class) ?? padOf(site);
  if (query.get('refuse') === '1') fixture.refuseNext('The pad was taken a moment before you.', { site: site.id, pad: altPad.id });
  const practice = createMenuFixture(defs, { rulesId: 'local', padLoad: 'free', link: 'local' });

  // ------------------------------------------------------------------------------------------------ camera
  const earthOf = (): BodySnapshot => app.snapshot().bodies.find((b) => b.id === site.bodyId)!;
  const radius = defs.bodies[site.bodyId]!.radius;
  const reduced = query.get('reduced') === '1';
  let t0 = performance.now();
  type Subject = Extract<ShellIntent, { kind: 'frame' }>['subject'];
  let subject: Subject = 'earth';
  let lensX = 0;
  let glide: { from: EyePose; t: number } | null = null;
  /** The transit, and what a test reads of it: per frame the camera's step (m, body-fixed), its bound from the path, the frame time and the exposure. */
  interface TransitRun {
    plan: TransitPlan;
    u: number;
    speed: number;
    holdAngle: number;
    acknowledged: boolean;
    practice: boolean;
    request: SpawnRequest;
    steps: number[];
    bounds: number[];
    frameMs: number[];
    last: { u: number; angle: number; fixed: Vec3 } | null;
    holding: boolean;
    /** True once the path is below the hold: the pad's exposure is the meter's reading from then on. */
    metering: boolean;
  }
  let transit: TransitRun | null = null;
  /** The last transit's record and the exposure at its hand-over (EV100), kept for the test after the transit ends. */
  let lastTransit: (TransitRun & { handOverEv: number | null; handOverTarget: number | null; handOverAt: number | null }) | null = null;
  let flightCamera = false;
  /** The transit's last point, body-fixed: the lab's flight camera stands there (it turns with the Earth). */
  let flightSample: ReturnType<typeof transitSample> | null = null;
  const eyeFor = (s: Subject): EyePose => {
    const earth = earthOf();
    if (s === 'site') {
      const up = quat.rotate(earth.qFixedToRoot, v3.new(Math.cos(loc.latDeg * (Math.PI / 180)) * Math.cos(loc.lonDeg * (Math.PI / 180)), Math.cos(loc.latDeg * (Math.PI / 180)) * Math.sin(loc.lonDeg * (Math.PI / 180)), Math.sin(loc.latDeg * (Math.PI / 180))));
      const north = v3.normalize(v3.reject(quat.rotate(earth.qFixedToRoot, v3.new(0, 0, 1)), up));
      const pos = v3.add(earth.rRoot, v3.add(v3.scale(up, radius + SITE_VIEW_ALTITUDE), v3.scale(north, -SITE_VIEW_ALTITUDE * 0.35)));
      return { positionRoot: pos, qViewToRoot: lookAt(pos, v3.add(earth.rRoot, v3.scale(up, radius)), up) };
    }
    if (s === 'turntable') {
      const pose = turntablePose(earth);
      if (pose) return pose;
    }
    return menuEye(earth, radius, { altitude: MENU_ALTITUDE, sunBehindLimbDeg: 2, t: (performance.now() - t0) / 1000, drift: !reduced });
  };
  /**
   * The turntable: the display vessel on its pad seen from a slow orbit about it (the player turns it with J / L
   * and zooms with I / K), at a distance from its height. Null without a display vessel.
   */
  const turntable = { yaw: 0.9, zoom: 1 };
  const displayHeight = displayVehicle ? analyzeVehicle(defs, displayVehicle, {}).height : 0;
  function turntablePose(earth: BodySnapshot): EyePose | null {
    const snap = app.snapshot();
    const vessel = snap.vessels.find((v) => v.id === snap.activeVesselId);
    if (!vessel || displayHeight <= 0) return null;
    const up = v3.normalize(v3.sub(vessel.rRoot, earth.rRoot));
    const north = v3.normalize(v3.reject(quat.rotate(earth.qFixedToRoot, v3.new(0, 0, 1)), up));
    const east = v3.cross(north, up);
    const yaw = turntable.yaw + (reduced ? 0 : ((performance.now() - t0) / 1000) * 0.05);
    const pitch = 0.1;
    const dist = displayHeight * 1.3 * turntable.zoom;
    const target = v3.add(vessel.rRoot, v3.scale(up, (stackLow + stackHigh) / 2));
    const around = v3.add(v3.scale(east, Math.cos(yaw)), v3.scale(north, Math.sin(yaw)));
    const eye = v3.add(target, v3.add(v3.scale(around, dist * Math.cos(pitch)), v3.scale(up, dist * Math.sin(pitch))));
    return { positionRoot: eye, qViewToRoot: lookAt(eye, target, up) };
  }
  const current = (): EyePose => {
    const c = app.camera.spec;
    return c.type === 'free' ? { positionRoot: c.positionRoot, qViewToRoot: c.qViewToRoot } : eyeFor(subject);
  };
  const smooth = (x: number): number => x * x * x * (x * (6 * x - 15) + 10);
  const place = (pose: EyePose, hint: { targetEv100: number; rateEvPerS: number } | null): void => {
    app.camera.spec = { type: 'free', positionRoot: pose.positionRoot, qViewToRoot: pose.qViewToRoot };
    app.camera.settings.exposureHint = hint;
    app.camera.settings.lensShift = lensX !== 0 ? [lensX, 0] : null;
  };

  const ev = (): number => app.renderer.exposureInfo().ev100;
  const analyses = new WeakMap<UniverseRules, Map<string, VehicleCapabilities>>();
  let vesselFeature: { status?(): unknown; stats?: unknown } | null = null;
  // The reach ladder's costs: solar-system-sim's deltaVToOrbit from the launch body's parking orbit; passing a
  // body costs the transfer without its last leg (the capture), being bound about it the whole of it.
  const reachCosts = new Map<string, { flyby: number; orbit: number } | null>();
  const reachCost = (bodyId: string, refuelled: boolean): { flyby: number; orbit: number } | null => {
    if (refuelled) return null;
    if (!reachCosts.has(bodyId)) {
      const r = deltaVToOrbit(defs, bodyId);
      const capture = r.legs[r.legs.length - 1]?.deltaV ?? 0;
      reachCosts.set(bodyId, Number.isFinite(r.total) ? { flyby: Math.max(0, r.total - capture), orbit: r.total } : null);
    }
    return reachCosts.get(bodyId)!;
  };
  // The account: an existing one by default (Play goes straight to the deploy flow); &identity=new is the first Play.
  const identity = createIdentityFixture({ callsign: query.get('identity') === 'new' ? null : 'PLOVER-7', taken: ['KESTREL-41', 'ORION', 'VEGA'], answerSeconds: 0.25 });
  const shell = createShell({
    root: uiRoot,
    canvas,
    defs,
    format: { number: formatNumber, apsis: formatApsis, duration: formatDuration, deltaV: formatDeltaV, mass: formatMass },
    keys: {
      menu: MENU_BINDINGS,
      transit: TRANSIT_BINDINGS,
      flightMenu: DEFAULT_BINDINGS.filter((b) => b.action === 'flightMenu').map((b) => b.code),
      label: keyLabel,
      flightHelp: keyHelpEntries(DEFAULT_BINDINGS, { flightMenu: true }).map((e) => ({ group: e.group, keys: e.keys, text: e.text })),
    },
    lobby: fixture,
    practice,
    publishScrim: (rects) => app.setScrim(rects.length > 0 ? rects : null),
    boot: () => ({ steps: bootSteps, playReady: bootSteps.every((s) => s.finished) }),
    snapshot: () => app.snapshot(),
    padLimitTolerance: { massShare: LIMIT_TOLERANCE, diameter: DIAMETER_TOLERANCE },
    capabilities: (vehicle, rules) => {
      // fleet-data's analysis of the definition the menu lists, under the rules in force (its pad class from the
      // rules' class limits), once per vehicle and rules document.
      let byVehicle = analyses.get(rules);
      if (!byVehicle) analyses.set(rules, (byVehicle = new Map()));
      let caps = byVehicle.get(vehicle.id);
      if (!caps) byVehicle.set(vehicle.id, (caps = analyzeVehicle(defs, vehicle, { rules, reachCost })));
      return caps;
    },
    settings: null,
    identity,
    padCycleSeconds: () => null,
    capacityReport: () => null,
    wallNow: () => Date.now(),
    captured: () => document.fullscreenElement !== null,
    reportError: errors,
    reducedMotion: reduced,
    uiScale: Number(query.get('scale') ?? '1'),
    intent(i) {
      switch (i.kind) {
        case 'frame': {
          if (transit || flightCamera) return;
          glide = { from: current(), t: 0 };
          // The turntable shows the display vessel only: the shell offers presentable vehicles, and this lab's is the first of them.
          subject = i.subject === 'flight' || (i.subject === 'turntable' && i.vehicleId !== displayId) ? 'earth' : i.subject;
          const w = window.innerWidth;
          lensX = i.subject === 'earth' ? 0 : ((i.free.x0 + i.free.x1) / 2 / w) * 2 - 1;
          return;
        }
        case 'transit': {
          const earth = earthOf();
          const startFixed = rootToFixed(earth, current().positionRoot);
          const padEv = sunEvAtPad(earth);
          transit = { plan: { radius, padLatDeg: loc.latDeg, padLonDeg: loc.lonDeg, padHeight: padElevation, startFixed, endOffsetEnu: v3.new(-60, -160, 60), holdAltitude: 3000, startEv: ev(), padEv, duration: 10 }, u: 0, speed: 1, holdAngle: 0, acknowledged: false, practice: i.practice, request: i.request, steps: [], bounds: [], frameMs: [], last: null, holding: false, metering: false };
          lastTransit = null;
          lensX = 0;
          return;
        }
        case 'spawnAcknowledged':
          if (transit) transit.acknowledged = true;
          return;
        case 'riseBack':
          if (transit && i.reason === 'skip') transit.speed = 4;
          else if (transit) {
            transit = null;
            glide = { from: current(), t: 0 };
          }
          return;
        case 'leave':
          flightCamera = false;
          glide = { from: current(), t: 0 };
          subject = 'earth';
          setTimeout(() => shell.left(), GLIDE_S * 1000);
          return;
        case 'turntable':
          turntable.yaw += i.turn * (Math.PI / 6);
          turntable.zoom = Math.min(2.5, Math.max(0.45, turntable.zoom * 0.8 ** i.zoom));
          return;
        case 'capture':
          if (i.on) void document.documentElement.requestFullscreen().catch(() => undefined);
          else if (document.fullscreenElement) void document.exitFullscreen();
          return;
        default:
          return;
      }
    },
  });

  /** A first estimate of the pad's exposure: sunny 16 by the sun's elevation, a flood-lit prior below the horizon. */
  function sunEvAtPad(earth: BodySnapshot): number {
    const upFixed = v3.new(Math.cos(loc.latDeg * (Math.PI / 180)) * Math.cos(loc.lonDeg * (Math.PI / 180)), Math.cos(loc.latDeg * (Math.PI / 180)) * Math.sin(loc.lonDeg * (Math.PI / 180)), Math.sin(loc.latDeg * (Math.PI / 180)));
    const s = v3.dot(quat.rotate(earth.qFixedToRoot, upFixed), v3.normalize(earth.sunDir));
    return s > 0.05 ? 14 + Math.min(1, s) : 5;
  }

  // Features: the render packages of the integration lab (opaque geometry, sky, atmosphere, ocean), or the LabPlanet.
  const wanted: FeaturePackage[] = ['terrain', 'vehicle', 'ocean', 'sky', 'atmosphere'];
  if (query.get('planet') === '1') {
    bootSteps[2]!.total = 1;
    await app.renderer.addFeature(createLabPlanetFeature({ defaultMap: 'tileset' }));
    bootSteps[2]!.done = 1;
  } else {
    const terrain = await createTerrainProvider(defs, createFetchTileSource('/tiles'));
    const imported = await importPackages(wanted);
    const navball = createNavballRenderer(app.gpu);
    app.renderer.context.resources.publish('ui.navball', navball.view);
    const built = buildFeatures(imported.modules, { defs, sim, ctx: app.renderer.context, gpu: app.gpu, terrain, navball, mfdPainter: createMfdPainter(), query });
    for (const p of [...imported.problems, ...built.problems]) errors(p);
    // The vessel feature warms and draws presentable vehicles only (src/core/access/presentable.ts).
    vesselFeature = (built.handles['vehicle.createVesselVisualFeature'] as { status?(): unknown; stats?: unknown } | undefined) ?? null;
    const features = built.features;
    bootSteps[2]!.total = features.length;
    for (const f of features) {
      await app.renderer.addFeature(f);
      bootSteps[2]!.done++;
    }
  }
  bootSteps[2]!.finished = true;
  await fonts;

  // ------------------------------------------------------------------------------------------- the loop
  shell.booted();
  shell.gatePassed();
  let idleFrames = 0;
  let lastFrameAt: number | null = null;
  let frameMs = 0;
  /** True while a test measures the page without the menu: the shell is not updated and its root is hidden. */
  let menuHidden = false;
  app.onFrame((_s, dt) => {
    const now = performance.now();
    frameMs = lastFrameAt === null ? 0 : now - lastFrameAt;
    lastFrameAt = now;
    if (!bootSteps[3]!.finished) {
      idleFrames = app.testApi.api.isIdle() ? idleFrames + 1 : 0;
      if (idleFrames > 6) {
        bootSteps[3]!.done = 1;
        bootSteps[3]!.finished = true;
      }
    }
    const earth = earthOf();
    if (transit) {
      const tr = transit;
      const hold = holdProgress(tr.plan);
      const gatesOpen = !tr.acknowledged;
      tr.holding = gatesOpen && tr.u >= hold;
      if (tr.holding) tr.holdAngle += 0.5 * (Math.PI / 180) * dt;
      else tr.u = Math.min(1, tr.u + (dt * tr.speed) / tr.plan.duration);
      if (gatesOpen && tr.u > hold) tr.u = hold;
      shell.transitStatus(tr.holding ? 'Securing range · waiting for the launch to be confirmed' : tr.u < hold ? `${site.name} · ${padOf(site, tr.request.pad).name}` : 'Pad clear', tr.holding);
      // Below the hold the pad is in view: the exposure heads for what the meter reads there (it keeps metering
      // under a hint), so the hand-over lands on the pad's settled exposure, by day or by night.
      if (tr.u >= hold) {
        const metered = app.renderer.exposureInfo().targetEv100;
        if (!tr.metering) {
          tr.metering = true;
          tr.plan.padEv = metered;
        } else tr.plan.padEv += (metered - tr.plan.padEv) * Math.min(1, dt * 4);
      }
      const sample = transitSample(tr.plan, tr.u, tr.holdAngle);
      const pose = transitPose(earth, sample);
      const fixed = rootToFixed(earth, pose.positionRoot);
      if (tr.last) {
        tr.steps.push(v3.len(v3.sub(fixed, tr.last.fixed)));
        tr.bounds.push(transitPathLength(tr.plan, tr.last.u, tr.last.angle, tr.u, tr.holdAngle));
        tr.frameMs.push(frameMs);
      }
      tr.last = { u: tr.u, angle: tr.holdAngle, fixed };
      // Below the hold the floodlit or sunlit pad comes into view in the last seconds: the exposure may move as
      // fast as an eye adapts (8 EV a second) so it is on the pad's reading at the hand-over.
      place(pose, tr.metering ? { targetEv100: sample.exposureHint.targetEv100, rateEvPerS: Math.max(sample.exposureHint.rateEvPerS, 8) } : sample.exposureHint);
      if (tr.u >= 1) {
        transit = null;
        lastTransit = { ...tr, handOverEv: ev(), handOverTarget: app.renderer.exposureInfo().targetEv100, handOverAt: performance.now() };
        // This lab has no flight controller and no chase rig: its flight camera holds the transit's last pose (the
        // pose the app's chase rig must start from: TransitPlan.endOffsetEnu), so the hand-over has no cut and the
        // meter settles on the view the transit's exposure was led to.
        flightCamera = true;
        flightSample = sample;
        app.camera.settings.exposureHint = null;
        shell.handOver();
      }
    } else if (flightCamera) {
      // Held body-fixed: ROOT moves with the Earth's orbit and spin, the pad with the Earth.
      if (flightSample) place(transitPose(earth, flightSample), null);
    } else {
      const target = eyeFor(subject);
      if (glide) {
        glide.t += dt / GLIDE_S;
        const k = smooth(Math.min(1, glide.t));
        const from = glide.from;
        const ra = v3.sub(from.positionRoot, earth.rRoot);
        const rb = v3.sub(target.positionRoot, earth.rRoot);
        const la = Math.log(v3.len(ra));
        const lb = Math.log(v3.len(rb));
        const dir = v3.normalize(v3.lerp(v3.normalize(ra), v3.normalize(rb), k));
        const pos = v3.add(earth.rRoot, v3.scale(dir, Math.exp(la + (lb - la) * k)));
        place({ positionRoot: pos, qViewToRoot: quat.normalize(slerp(from.qViewToRoot, target.qViewToRoot, k)) }, null);
        if (glide.t >= 1) glide = null;
      } else place(target, null);
    }
    fixture.advance(dt);
    practice.advance(dt);
    identity.advance(dt);
    if (!menuHidden) shell.update(dt);
  });
  // Esc / P in flight open the flight menu (the flight table's action; this lab has no flight controller).
  window.addEventListener('keydown', (e) => {
    // The shell's own listener runs first and marks a key it used (Esc closing the flight menu): never reopen it here.
    if (!e.defaultPrevented && shell.hooks().main === 'flight' && (e.code === 'Escape' || e.code === 'KeyP')) {
      e.preventDefault();
      shell.openFlightMenu();
    }
  });

  const w = window as unknown as Record<string, unknown>;
  w['__shell'] = {
    hooks: () => shell.hooks(),
    shell,
    fixture,
    practice,
    camera: () => app.cameraState(),
    exposure: () => app.renderer.exposureInfo(),
    /** What the vessel feature drew and passed over (its stats and status), and the snapshot's active vessel and its part count. */
    vessel: () => {
      const snap = app.snapshot();
      const v = snap.vessels.find((x) => x.id === snap.activeVesselId);
      return { feature: vesselFeature ? { status: vesselFeature.status?.(), stats: vesselFeature.stats } : null, active: v ? { id: v.id, vehicleId: v.vehicleId, parts: v.parts.length, crafts: v.crafts.length } : null };
    },
    transit: () => (transit ? { u: transit.u, holding: transit.holding, steps: transit.steps.slice(), acknowledged: transit.acknowledged } : null),
    /** The last finished transit: per-frame steps and their bounds (m), frame times (ms), the exposure at the hand-over and now. */
    lastTransit: () =>
      lastTransit ? { steps: lastTransit.steps.slice(), bounds: lastTransit.bounds.slice(), frameMs: lastTransit.frameMs.slice(), handOverEv: lastTransit.handOverEv, handOverTarget: lastTransit.handOverTarget, secondsSince: lastTransit.handOverAt === null ? null : (performance.now() - lastTransit.handOverAt) / 1000, evNow: ev() } : null,
    /** Measure the page without the menu (the CDP A/B): the shell is not updated and its DOM is hidden; the scene is unchanged. */
    setMenuHidden: (on: boolean) => {
      menuHidden = on;
      uiRoot.style.display = on ? 'none' : '';
    },
    releaseHangar: () => {
      if (!hangarStep) return;
      hangarStep.done = 1;
      hangarStep.finished = true;
    },
    resetClock: () => (t0 = performance.now()),
  };
  app.testApi.markReady(true);
}

function slerp(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }, t: number): { x: number; y: number; z: number; w: number } {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  d = Math.abs(d);
  if (d > 0.9995) return { x: a.x + (s * b.x - a.x) * t, y: a.y + (s * b.y - a.y) * t, z: a.z + (s * b.z - a.z) * t, w: a.w + (s * b.w - a.w) * t };
  const th = Math.acos(d);
  const ka = Math.sin((1 - t) * th) / Math.sin(th);
  const kb = (s * Math.sin(t * th)) / Math.sin(th);
  return { x: ka * a.x + kb * b.x, y: ka * a.y + kb * b.y, z: ka * a.z + kb * b.z, w: ka * a.w + kb * b.w };
}

boot().catch((err: unknown) => {
  const t = (window as unknown as { __test?: { reportError(m: string): void; markReady?(ok: boolean): void } }).__test;
  t?.reportError(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
