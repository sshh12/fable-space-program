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
import { padLocationOf, padOf } from '@/core/defs/sites';
import type { LinkState, UniverseRules } from '@/core/contracts/net';
import type { SpawnRequest } from '@/core/contracts/session';
import type { BodySnapshot } from '@/core/contracts/sim';
import { createFakeSession } from '@/core/fakes/fakeSession';
import { createMenuFixture, menuShipsFixture } from '@/core/fakes/menuStores';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { holdProgress, lookAt, menuEye, rootToFixed, transitPose, transitSample, type EyePose, type TransitPlan } from '@/camera';
import { DEFAULT_BINDINGS, keyHelpEntries, keyLabel, MENU_BINDINGS, TRANSIT_BINDINGS } from '@/input';
import { createLabApp, createLabPlanetFeature } from '@/render/core/lab';
import { createShell, loadShellFonts, type ShellIntent } from '@/shell';
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
  const defs = await loadDefs(fetchDefSource());
  bootSteps[0]!.done = 1;
  bootSteps[0]!.finished = true;
  const site = Object.values(defs.sites).sort((a, b) => a.name.localeCompare(b.name))[0]!;
  const loc = padLocationOf(site);
  const padElevation = typeof loc.padElevation === 'number' ? loc.padElevation : 0;
  const sim = createFakeSession(defs, { scene: 'pad', siteId: site.id, ground: { height: padElevation, originHeight: 0 } });
  const terrain = await createTerrainProvider(defs, createFetchTileSource('/tiles'));
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
  if (query.get('refuse') === '1') fixture.refuseNext('The pad was taken a moment before you.', { site: site.id, pad: padOf(site).id });
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
  let transit: { plan: TransitPlan; u: number; speed: number; holdAngle: number; acknowledged: boolean; practice: boolean; request: SpawnRequest; steps: number[]; last: Vec3 | null; holding: boolean } | null = null;
  let flightCamera = false;
  const eyeFor = (s: Subject): EyePose => {
    const earth = earthOf();
    if (s === 'site') {
      const up = quat.rotate(earth.qFixedToRoot, v3.new(Math.cos(loc.latDeg * (Math.PI / 180)) * Math.cos(loc.lonDeg * (Math.PI / 180)), Math.cos(loc.latDeg * (Math.PI / 180)) * Math.sin(loc.lonDeg * (Math.PI / 180)), Math.sin(loc.latDeg * (Math.PI / 180))));
      const north = v3.normalize(v3.reject(quat.rotate(earth.qFixedToRoot, v3.new(0, 0, 1)), up));
      const pos = v3.add(earth.rRoot, v3.add(v3.scale(up, radius + SITE_VIEW_ALTITUDE), v3.scale(north, -SITE_VIEW_ALTITUDE * 0.9)));
      return { positionRoot: pos, qViewToRoot: lookAt(pos, v3.add(earth.rRoot, v3.scale(up, radius)), up) };
    }
    return menuEye(earth, radius, { altitude: MENU_ALTITUDE, sunBehindLimbDeg: 10, t: (performance.now() - t0) / 1000, drift: !reduced });
  };
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
    capabilities: () => null,
    settings: null,
    identity: null,
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
          subject = i.subject === 'turntable' || i.subject === 'flight' ? 'earth' : i.subject;
          const w = window.innerWidth;
          lensX = i.subject === 'earth' ? 0 : ((i.free.x0 + i.free.x1) / 2 / w) * 2 - 1;
          return;
        }
        case 'transit': {
          const earth = earthOf();
          const startFixed = rootToFixed(earth, current().positionRoot);
          const padEv = sunEvAtPad(earth);
          transit = { plan: { radius, padLatDeg: loc.latDeg, padLonDeg: loc.lonDeg, padHeight: padElevation, startFixed, endOffsetEnu: v3.new(-60, -160, 60), holdAltitude: 3000, startEv: ev(), padEv, duration: 10 }, u: 0, speed: 1, holdAngle: 0, acknowledged: false, practice: i.practice, request: i.request, steps: [], last: null, holding: false };
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
    const imported = await importPackages(wanted);
    const navball = createNavballRenderer(app.gpu);
    app.renderer.context.resources.publish('ui.navball', navball.view);
    const built = buildFeatures(imported.modules, { defs, sim, ctx: app.renderer.context, gpu: app.gpu, terrain, navball, mfdPainter: createMfdPainter(), query });
    for (const p of [...imported.problems, ...built.problems]) errors(p);
    bootSteps[2]!.total = built.features.length;
    for (const f of built.features) {
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
  app.onFrame((_s, dt) => {
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
      const sample = transitSample(tr.plan, tr.u, tr.holdAngle);
      const pose = transitPose(earth, sample);
      if (tr.last) tr.steps.push(v3.len(v3.sub(rootToFixed(earth, pose.positionRoot), rootToFixed(earth, tr.last))));
      tr.last = pose.positionRoot;
      place(pose, sample.exposureHint);
      if (tr.u >= 1) {
        transit = null;
        flightCamera = true;
        app.camera.settings.exposureHint = null;
        app.camera.spec = { type: 'orbit', target: { vesselId: app.snapshot().activeVesselId ?? '' }, yaw: -0.35, pitch: 0.18, distance: 180 };
        shell.handOver();
      }
    } else if (!flightCamera) {
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
    shell.update(dt);
  });
  // Esc / P in flight open the flight menu (the flight table's action; this lab has no flight controller).
  window.addEventListener('keydown', (e) => {
    if (shell.hooks().main === 'flight' && (e.code === 'Escape' || e.code === 'KeyP')) {
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
    transit: () => (transit ? { u: transit.u, holding: transit.holding, steps: transit.steps.slice(), acknowledged: transit.acknowledged } : null),
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
