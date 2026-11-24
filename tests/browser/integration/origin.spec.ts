/**
 * The renderer is origin-agnostic (ARCHITECTURE section 3; the presentation sweep's acceptance lines).
 *
 * 1. THE SAME FRAME AT TWO ORIGINS. The lunar checkpoints of the reference images are the frames: there the
 *    library's root body and the centre of the vessel's SOI body are 384,000 km apart. Each is opened as its
 *    reference image was recorded (its page and its setup steps, the frame-exact capture) three times:
 *      - `&origin=root`: the fake session states ROOT positions about the root body (v1's origin);
 *      - `&origin=root&frameorigin=<SOI body>`: the same frame handed to the renderer about the SOI body's
 *        centre by an exact translation (src/render/core/lab/origin.ts): every difference of two ROOT
 *        positions the renderer forms is the same number to the last bit, so the picture must be the SAME
 *        TO THE BIT. This is the statement about the renderer: nothing in it depends on where the origin is.
 *        (A checkpoint the manifest does not mark exact differs between two loads of one and the same page;
 *        its two captures are compared within the tolerance the manifest gives it.)
 *      - `&origin=focus`: the fake session computes the frame about the SOI body itself, as a session does.
 *        Its numbers are not a translation of the first frame's: a position 384,000 km from the origin is
 *        held on a float64 grid of 6e-8 m, one about the Moon on a grid of 2e-10 m, so the camera stands up to
 *        3e-8 m elsewhere relative to the vessel (measured below). That is enough to carry single-precision
 *        values on the GPU across a rounding step and with them isolated samples on high-contrast edges and
 *        in stochastic shadow taps: a few pixels differ by more than a level while the frame as a whole is
 *        the same (mean difference of the order of 0.01 level). Asserted: the 99.9th percentile of the
 *        difference is at most one level and the mean is under 0.1 level (1/255 per channel is one level);
 *        for a checkpoint that is not exact, the tolerance the manifest gives its own loads.
 *
 * 2. A REPLACEMENT OF THE ORIGIN BETWEEN TWO FRAMES, as a change of the sphere of influence makes it
 *    (`__integration.setRenderRoot`, the fake session's): the frame that carries the new epoch is compared
 *    with the same frame of a run in which the origin stayed.
 *
 *    EVERY RUN IS ONE FRAME-EXACT CAPTURE (`CoreRenderer.renderExact`, RENDER_API section 13: the machinery
 *    the reference images are taken with). The page is at rest with the time held; the capture restarts every
 *    temporal sequence of the core and of the features (`resetTemporal`) and renders REBASE_LEAD + 1 frames in
 *    one task. In those frames the time runs, the scene is staged, the origin is replaced before the last
 *    one, and the last one is the frame compared. What a feature keeps a phase of beyond the 64 frames the
 *    sequences are aligned to (the atmosphere does when it is stepped by hand: request presentation-sweep-8)
 *    starts over with the capture, and TWO RUNS WITHOUT A REPLACEMENT ARE ONE PICTURE TO THE BIT: that is the
 *    precondition of every comparison of a picture, asserted as 0 differing pixels.
 *
 *    The checks, in this order (`judge`):
 *      eye step, vessel step   what the core forms from the two frames across the replacement (`prevEyeOffset`;
 *                              the vessel of `frame.snapshot` against `frame.prevSnapshot`) is what it would
 *                              be had the origin always been the new one: the control's step plus what the
 *                              two origins move against each other in the frame (the rebase's velocity times
 *                              the frame's time), to a tenth of a millimetre. Asserted BEFORE any picture.
 *      ghost                   a vessel that left the snapshot is drawn where the control draws it (the vessel
 *                              feature's `ghostPlacements`, camera-relative);
 *      particle streak         the effect domain passes the eye at the control's velocity (the vfx feature's
 *                              `debug.domainVelocity`: what every particle's streak is drawn from);
 *      motion vectors          the velocity target of the frame is the control's (no spike);
 *      picture                 the frame is the control's but for the last bits of float64 (part 1).
 *    The scenes: three that hold nothing but the core's previous frame (`sea`, `leo`, `lunar-orbit`), and three
 *    in which something DRAWN is held across the replacement: a vessel that left the snapshot and is drawn as
 *    a ghost (`ghost`), particles of a burst in a space domain (`particles`), canopies cut away and adrift
 *    (`canopy`). The effects and the canopies hold no ROOT position of their own: they read the core's
 *    previous camera (vfx/feature.ts, the space domain one frame ago; vfx/chutes.ts, `prevEyeOffset`).
 *
 * 3. THE TEST SEES A MISSING REBASE. Each scene of part 2 once more with a rebase switched off (the lab's
 *    `&norebase=core|ghosts`: `RendererOptions.debugNoFrameRebase`, `VesselVisualOptions.debugNoGhostRebase`;
 *    test-only switches, off by default): the checks named for the scene then FAIL, by the distance between
 *    the two origins (the eye stepped 384,000 km, the ghost is drawn that far away, the domain passes the eye
 *    at that distance per frame, the canopy's motion vectors leave the frame).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/origin.spec.ts --project=functional
 *
 * ORIGIN_ONLY=a,b narrows the frames of part 1 and the scenes of parts 2 and 3; ORIGIN_EXTRA=<query> is
 * appended to the pages (to look for what moves a picture: `&without=vfx`). Pictures:
 * out/screens/presentation-sweep/origin/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, captureReference, expect, expectNoErrors, imageDifference, openPage, readBaselineManifest, runBaselineSteps, test } from '../harness';
import { repoRoot } from './helpers';

test.setTimeout(30 * 60_000);

const manifest = readBaselineManifest();
test.use({ viewport: { width: manifest.viewport[0], height: manifest.viewport[1] }, deviceScaleFactor: 1 });

/** The frames: the checkpoints of the Moon's sphere of influence that the integration lab draws from its fake session. */
const FRAMES = ['lunar-terminator-5000km', 'lunar-orbit-low-sun', 'lunar-surface-cockpit', 'lunar-touchdown'];

const only = (process.env['ORIGIN_ONLY'] ?? '').split(',').filter((x) => x !== '');
const extra = process.env['ORIGIN_EXTRA'] ?? '';
const outDir = path.join(repoRoot, 'out', 'screens', 'presentation-sweep', 'origin');

interface Vec {
  x: number;
  y: number;
  z: number;
}
interface PageVessel {
  id: string;
  bodyId: string;
  rRoot: Vec;
  parts: { modules: { type: string; state?: string }[] }[];
}
interface PageSnapshot {
  ut: number;
  activeVesselId: string;
  vessels: PageVessel[];
  bodies: { id: string; rRoot: Vec }[];
  frame?: { epoch: number; origin: { kind: string; bodyId: string }; previous?: { epoch: number; velocity: Vec }[] };
}
interface LabPage {
  __lab: {
    snapshot(): PageSnapshot;
    cameraState(): { positionRoot: Vec };
    gpu: { device: { queue: { onSubmittedWorkDone(): Promise<void> } } };
    renderer: {
      readonly frameContext: { frameIndex: number; prevEyeOffset: Vec; snapshot: PageSnapshot; prevSnapshot: PageSnapshot } | null;
      readVelocity(): Promise<{ width: number; height: number; data: Float32Array }>;
      renderExact(frames: number, renderFrame: () => void): Promise<{ frames: number; idle: boolean }>;
      exactInfo(): { busyBefore: string[]; busyAfter: string[]; rounds: number } | null;
    };
    setDeterministic(on: boolean): void;
    setLoop(running: boolean): void;
    setPaused(paused: boolean): void;
    renderFrame(dt?: number): void;
  };
  __integration: {
    setRenderRoot(bodyId: string): boolean;
    dropVessel(vesselId: string): boolean;
    cutParachutes(): number;
    burst(posVes: Vec): boolean;
    /** What each factory of the lab returned: the vessel feature and the vfx feature are read here. */
    handles: Record<string, unknown>;
  };
}
/** What this spec reads of the vessel feature and of the vfx feature (their debug accessors). */
interface VesselHandle {
  stats: { ghosts: number };
  ghostPlacements(): { vesselId: string; originRelCam: Vec }[];
}
interface VfxHandle {
  debug: { domainVelocity(): Vec | null; domainKind(): string | null; stats(): Record<string, number> };
}

const describe = (d: ReturnType<typeof imageDifference>): string =>
  `${Math.round(d.differingFraction * d.width * d.height)} pixels differ, by up to ${d.maxAbs} level(s) (mean |diff| ${d.meanAbs.toFixed(4)}, 99.9th percentile ${d.p999})`;

for (const name of FRAMES.filter((f) => only.length === 0 || only.includes(f))) {
  test(`${name}: the same picture with the origin at the root body and at the Moon`, async ({ page, pageLog }) => {
    const entry = manifest.checkpoints[name];
    if (!entry || entry.page === null) throw new Error(`origin test: the manifest has no framed checkpoint "${name}"`);
    const tolerance = entry.tolerance;
    if (!entry.exact && !tolerance) throw new Error(`origin test: the checkpoint "${name}" is not exact and has no tolerance`);
    const capture = async (query: string): Promise<{ image: Buffer; soiBody: string; originBody: string | null; cameraFromVessel: number[] }> => {
      await openPage(page, `${entry.page}${query}${extra}`, { timeoutMs: 180_000 });
      await assertDiscreteGpu(page);
      await runBaselineSteps(page, entry.setup ?? []);
      const { image } = await captureReference(page, entry.frames, `${name} (${query})`);
      await expectNoErrors(page, pageLog);
      const state = await page.evaluate(() => {
        const lab = (window as unknown as LabPage).__lab;
        const s = lab.snapshot();
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
        const c = lab.cameraState().positionRoot;
        return { soiBody: v.bodyId, originBody: s.frame?.origin.kind === 'body' ? s.frame.origin.bodyId : null, cameraFromVessel: [c.x - v.rRoot.x, c.y - v.rRoot.y, c.z - v.rRoot.z] };
      });
      return { image, ...state };
    };
    fs.mkdirSync(outDir, { recursive: true });
    const save = (file: string, image: Buffer): void => fs.writeFileSync(path.join(outDir, `${name}.${file}.png`), image);

    const root = await capture('&origin=root');
    save('root', root.image);
    // The same numbers about another origin: the same picture to the bit.
    const translated = await capture(`&origin=root&frameorigin=${root.soiBody}`);
    const exact = imageDifference(root.image, translated.image);
    save('translated', translated.image);
    save('translated.diff', exact.diff);
    console.log(`[origin] ${name}${extra ? ` (${extra})` : ''}: translated to ${root.soiBody}: ${describe(exact)}`);
    expect(translated.cameraFromVessel, 'the translated run is the same frame').toEqual(root.cameraFromVessel);
    if (entry.exact) expect(exact.maxAbs, `${name}: the renderer drew another picture from the same frame about another origin (${name}.translated.diff.png)`).toBe(0);
    else {
      // Two loads of this page are not one picture (the manifest says why): within what they differ by.
      expect(exact.meanAbs, `${name}: translated, mean difference`).toBeLessThanOrEqual(tolerance!.meanAbs);
      expect(exact.p999, `${name}: translated, 99.9th percentile`).toBeLessThanOrEqual(tolerance!.p999);
    }

    // The frame computed about the other origin: the same picture but for what the last bits of float64 carry.
    const focus = await capture('&origin=focus');
    const d = imageDifference(root.image, focus.image);
    save('focus', focus.image);
    save('focus.diff', d.diff);
    const moved = Math.hypot(...root.cameraFromVessel.map((x, i) => x - focus.cameraFromVessel[i]!));
    console.log(`[origin] ${name}${extra ? ` (${extra})` : ''}: computed about ${focus.originBody}: ${describe(d)}; the camera stands ${moved.toExponential(2)} m elsewhere relative to the vessel`);
    expect(focus.originBody).toBe(root.soiBody);
    expect(moved, 'the two frames are the same but for the rounding of positions 384,000 km from the origin').toBeLessThan(1e-6);
    const allowed = entry.exact ? { meanAbs: 0.1, p999: 1 } : tolerance!;
    expect(d.p999, `${name}: the 99.9th percentile of the difference between the two origins (${name}.focus.diff.png)`).toBeLessThanOrEqual(allowed.p999);
    expect(d.meanAbs, `${name}: the mean difference between the two origins`).toBeLessThanOrEqual(allowed.meanAbs);
  });
}

// ------------------------------------------------------------------ parts 2 and 3: a replacement between two frames

/** Frames of the capture with the time running before the frame that is compared. */
const REBASE_LEAD = 12;
/** What the steps formed across a replacement may differ by from the control's, m (float64 at 384,000 km: 1e-7 m; the origins' relative acceleration over one frame: 4e-7 m). */
const STEP_TOLERANCE = 1e-4;
/** The same for the camera-relative place of something held for several frames, m. */
const HELD_TOLERANCE = 1e-3;
/** The same for the velocity at which the effect domain passes the eye, m/s (the rounding of two positions over a sixtieth of a second: 1e-5 m/s). */
const STREAK_TOLERANCE = 1e-2;
/** What a frame computed about another origin may differ by from the control's: the last bits of float64 (part 1). */
const LAST_BITS = { meanAbs: 0.05, p999: 1 };
/** A rebase that is missing displaces by the distance between the two origins: at least this, m (the Moon is 384,000 km from the Earth). */
const ORIGIN_DISTANCE_FLOOR = 1e8;

type CheckName = 'eye step' | 'vessel step' | 'ghost' | 'particle streak' | 'motion vectors' | 'picture';
type Staged = 'drop' | 'cut' | 'burst';
type Switch = 'core' | 'ghosts';

interface RebaseScene {
  name: string;
  page: string;
  /** The body whose centre becomes the origin. */
  to: string;
  /** What the lab stages before the frame `at` of the lead is stepped (0 = its first frame). */
  stage?: { at: number; what: Staged };
  /** Part 3: a rebase switched off (the lab's `&norebase=`) and the checks that must then fail. */
  off: { norebase: Switch; fails: CheckName[] }[];
}

// (`&ev=`: a fixed exposure. The meter reads the frame back from the GPU a few frames late, at a moment that
// differs from load to load while frames are stepped by hand; a frame-exact capture holds what its lead-in
// metered, which a frame that must follow its predecessor cannot do.)
const REBASE_SCENES: RebaseScene[] = [
  // Two metres above the sea (the camera of the ocean-climb checkpoints); the origin goes to the Moon.
  {
    name: 'sea',
    page: '/labs/integration/?scene=lowOrbit&body=earth&lat=8&lon=-140&alt=2&heading=120&pitch=-20&sun=120,40&sunsite=earth,8,-140&ev=14.5&hud=0&governor=off&deterministic=1&paused=1',
    to: 'moon',
    off: [{ norebase: 'core', fails: ['eye step', 'vessel step'] }],
  },
  // Low Earth orbit (7.7 km/s over the sea); the origin goes to the Moon.
  {
    name: 'leo',
    page: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&ev=14.5&hud=0&governor=off&deterministic=1&paused=1',
    to: 'moon',
    off: [{ norebase: 'core', fails: ['eye step', 'vessel step'] }],
  },
  // Low lunar orbit, drawn about the root body; the origin goes to the Moon, as at the change of the sphere of influence.
  {
    name: 'lunar-orbit',
    page: '/labs/integration/?scene=lunarOrbit&orbit=30,15,60&ev=14.5&hud=0&governor=off&deterministic=1&paused=1&origin=root',
    to: 'moon',
    off: [{ norebase: 'core', fails: ['eye step', 'vessel step'] }],
  },
  // A GHOST: two vessels 40 m apart in low Earth orbit (the lab's `&twin=`: a copy of the vessel beside it);
  // the second leaves the snapshot six frames before the origin goes to the Moon, and the vessel feature draws
  // it on where it was going. Without the ghosts' own rebase it is drawn at the old numbers about the new
  // origin; without the core's, where it stood one frame ago is formed from a camera of the old frame.
  {
    name: 'ghost',
    page: '/labs/integration/?scene=lowOrbit&twin=40&orbit=30,15,70&ev=14.5&hud=0&governor=off&deterministic=1&paused=1',
    to: 'moon',
    stage: { at: 6, what: 'drop' },
    off: [
      { norebase: 'ghosts', fails: ['ghost', 'picture'] },
      { norebase: 'core', fails: ['eye step', 'vessel step', 'motion vectors'] },
    ],
  },
  // PARTICLES IN A SPACE DOMAIN: a part bursts beside the vessel in low Earth orbit ten frames before the
  // origin goes to the Moon; its sparks and debris are alive across the replacement. Their streaks are drawn
  // from where the domain's origin was one frame ago relative to the previous eye (vfx/feature.ts).
  {
    name: 'particles',
    page: '/labs/integration/?scene=lowOrbit&orbit=30,15,30&ev=14.5&hud=0&governor=off&deterministic=1&paused=1',
    to: 'moon',
    stage: { at: 2, what: 'burst' },
    off: [{ norebase: 'core', fails: ['eye step', 'vessel step', 'particle streak'] }],
  },
  // CANOPIES ADRIFT: the main parachutes are cut away 900 m above the sea eight frames before the origin goes
  // to the Moon; the canopies drift on in the effect domain, and where each stood one frame ago is formed with
  // the eye's step (vfx/chutes.ts).
  {
    name: 'canopy',
    page: '/labs/integration/?scene=chutes&start=900&ev=14.5&hud=0&governor=off&deterministic=1&paused=1',
    to: 'moon',
    stage: { at: 4, what: 'cut' },
    off: [{ norebase: 'core', fails: ['eye step', 'vessel step', 'motion vectors'] }],
  },
];

/** What a run hands back from its page. */
interface RunFrame {
  /** Frames the lead-in of a frame-exact capture renders on this page before the capture's own (the meter's). */
  leadIn: number;
  /** The frame index of the compared frame. */
  frameIndex: number;
  epoch: number;
  originBody: string | null;
  /** Simulation time between the compared frame and the one before it, s. */
  dt: number;
  /** `frame.prevEyeOffset`: the previous eye minus the eye, m. */
  prevEyeOffset: number[];
  /** The active vessel of `frame.snapshot` minus that of `frame.prevSnapshot`, m. */
  vesselStep: number[];
  /** The old origin's velocity in the new frame, as the snapshot states it, m/s; null without a replacement. */
  originVelocity: number[] | null;
  /** The ghosts the vessel feature drew, camera-relative, m. */
  ghosts: { vesselId: string; relCam: number[] }[];
  /** The velocity at which the effect domain passes the eye, m/s; null without the vfx package. */
  domainVelocity: number[] | null;
  domainKind: string | null;
  particles: number;
  canopies: number;
  /** Parachute modules of the active vessel that are open (reefed or full). */
  openChutes: number;
}
interface Run extends RunFrame {
  image: Buffer;
  velocity: { max: number; mean: number };
}

/** Velocity target of the last frame: the largest and the mean length of the UV-space velocity over the frame (a sample that is not finite counts as the largest). */
async function velocityStats(page: Page): Promise<{ max: number; mean: number }> {
  return page.evaluate(async () => {
    const v = await (window as unknown as LabPage).__lab.renderer.readVelocity();
    let max = 0;
    let sum = 0;
    for (let i = 0; i < v.data.length; i += 2) {
      const m = Math.hypot(v.data[i]!, v.data[i + 1]!);
      if (!Number.isFinite(m)) {
        max = Infinity;
        continue;
      }
      if (m > max) max = m;
      sum += m;
    }
    return { max, mean: sum / (v.data.length / 2) };
  });
}

/** One run of a scene: the load, then one frame-exact capture: the lead with the time running, the replacement (or none), the compared frame. */
async function runScene(page: Page, pageLog: Parameters<typeof expectNoErrors>[1], scene: RebaseScene, opts: { replace: boolean; norebase?: Switch }): Promise<Run> {
  await openPage(page, `${scene.page}${opts.norebase ? `&norebase=${opts.norebase}` : ''}${extra}`, { timeoutMs: 180_000 });
  await assertDiscreteGpu(page);
  await page.waitForFunction(() => window.__test !== undefined && window.__test.isIdle(), undefined, { timeout: 180_000 });
  const frame: RunFrame = await page.evaluate(
    async ({ name, lead, to, stage }) => {
      const w = window as unknown as LabPage;
      const lab = w.__lab;
      const integration = w.__integration;
      const atRest = (what: string): void => {
        const info = lab.renderer.exactInfo();
        if (!info || info.rounds !== 1 || info.busyAfter.length > 0) throw new Error(`origin test, ${name}: the page was not at rest for ${what} (${JSON.stringify(info)}): its frames would not be every run's frames`);
      };
      // How many frames the lead-in of a capture renders here (the meter's), by a capture of one frame.
      let calls = 0;
      await lab.renderer.renderExact(1, () => {
        calls++;
        lab.renderFrame(1 / 60);
      });
      atRest('the first capture');
      const leadIn = calls - 1;
      // THE CAPTURE: its lead-in with the time held, then lead + 1 frames in one task with the time running. In
      // them the scene is staged, and before the last one the origin is replaced (or, in a control run, not).
      let n = 0;
      let before = -1;
      const held = await lab.renderer.renderExact(lead + 1, () => {
        const i = n++ - leadIn;
        if (i === 0) lab.setPaused(false);
        if (i >= 0 && stage !== null && stage.at === i) {
          const now = lab.snapshot();
          if (stage.what === 'drop') {
            const other = now.vessels.find((v) => v.id !== now.activeVesselId);
            if (!other || !integration.dropVessel(other.id)) throw new Error(`origin test, ${name}: the scene has no second vessel that can leave the snapshot`);
          } else if (stage.what === 'cut') {
            if (integration.cutParachutes() === 0) throw new Error(`origin test, ${name}: the vessel has no open parachute to cut away`);
          } else if (!integration.burst({ x: 3, y: 0, z: 0 })) throw new Error(`origin test, ${name}: the page cannot stage a burst`);
        }
        if (i === lead) {
          before = lab.snapshot().frame?.epoch ?? -1;
          if (to !== null && !integration.setRenderRoot(to)) throw new Error(`origin test, ${name}: the page has no fake session whose origin can be replaced`);
        }
        // (The last of these is the frame that carries the new epoch, or the same frame without one.)
        lab.renderFrame(1 / 60);
      });
      lab.setPaused(true);
      atRest('the capture');
      if (held.frames !== lead + 1 || n !== leadIn + lead + 1) throw new Error(`origin test, ${name}: the capture rendered ${n} frames with ${held.frames} of its own; ${leadIn} + ${lead + 1} were to be rendered`);
      const s = lab.snapshot();
      // The canvas shows the frame once the compositor has presented it.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // What the core formed from this frame and the one before it.
      const fc = lab.renderer.frameContext!;
      const vec = (v: Vec): number[] => [v.x, v.y, v.z];
      const active = (snap: PageSnapshot): PageVessel => snap.vessels.find((v) => v.id === s.activeVesselId)!;
      const a = active(fc.snapshot).rRoot;
      const b = active(fc.prevSnapshot).rRoot;
      const vessel = integration.handles['vehicle.createVesselVisualFeature'] as VesselHandle | undefined;
      const vfx = integration.handles['vfx.createVfxFeature'] as VfxHandle | undefined;
      const stats = vfx?.debug.stats() ?? {};
      const domainVelocity = vfx?.debug.domainVelocity() ?? null;
      const from = s.frame && s.frame.epoch !== before ? s.frame.previous?.find((p) => p.epoch === before) : undefined;
      let openChutes = 0;
      for (const p of active(s).parts) for (const m of p.modules) if (m.type === 'parachute' && (m.state === 'full' || m.state === 'reefed')) openChutes++;
      return {
        leadIn,
        frameIndex: fc.frameIndex,
        epoch: s.frame?.epoch ?? -1,
        originBody: s.frame?.origin.kind === 'body' ? s.frame.origin.bodyId : null,
        dt: fc.snapshot.ut - fc.prevSnapshot.ut,
        prevEyeOffset: vec(fc.prevEyeOffset),
        vesselStep: [a.x - b.x, a.y - b.y, a.z - b.z],
        originVelocity: from ? vec(from.velocity) : null,
        ghosts: (vessel?.ghostPlacements() ?? []).map((g) => ({ vesselId: g.vesselId, relCam: vec(g.originRelCam) })),
        domainVelocity: domainVelocity ? vec(domainVelocity) : null,
        domainKind: vfx?.debug.domainKind() ?? null,
        particles: stats['particles'] ?? 0,
        canopies: stats['canopies'] ?? 0,
        openChutes,
      };
    },
    { name: scene.name, lead: REBASE_LEAD, to: opts.replace ? scene.to : null, stage: scene.stage ?? null },
  );
  const velocity = await velocityStats(page);
  const image = await page.screenshot();
  await expectNoErrors(page, pageLog);
  return { image, velocity, ...frame };
}

interface Verdict {
  check: CheckName;
  ok: boolean;
  /** What the check measured: m (the steps, the ghost), m/s (the streak), a ratio (motion vectors), levels (the picture's mean difference). */
  value: number;
  text: string;
}

const minus = (a: readonly number[], b: readonly number[]): number[] => a.map((x, i) => x - b[i]!);
const norm = (a: readonly number[]): number => Math.hypot(...a);
const metres = (x: number): string => (x >= 1e6 ? `${(x / 1000).toFixed(0)} km` : x >= 0.01 ? `${x.toFixed(3)} m` : `${x.toExponential(2)} m`);

/** Pixels of two pictures whose largest channel difference is over `level`. */
function pixelsOver(a: Buffer, b: Buffer, level: number): number {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) if (Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!)) > level) n++;
  return n;
}

/**
 * The checks on what is formed across the replacement, none of which reads a picture. Had the origin always
 * been the new one, the eye and the vessel would have stepped as in the control plus what the two origins
 * move against each other in the frame: the rebase's velocity (the old origin's, in the new frame) times the
 * frame's time. Camera-relative quantities (where a ghost is drawn, how fast the effect domain passes the eye)
 * are the control's own.
 */
function judgeSteps(control: Run, replaced: Run): Verdict[] {
  const out: Verdict[] = [];
  const drift = (replaced.originVelocity ?? [0, 0, 0]).map((x) => x * replaced.dt);
  const eye = norm(minus(replaced.prevEyeOffset, minus(control.prevEyeOffset, drift)));
  out.push({ check: 'eye step', ok: eye < STEP_TOLERANCE, value: eye, text: `the eye stepped ${metres(norm(replaced.prevEyeOffset))} (control ${metres(norm(control.prevEyeOffset))}, the origins moved ${metres(norm(drift))} against each other): ${metres(eye)} from the step of a frame that always had the new origin` });
  const vessel = norm(minus(replaced.vesselStep, control.vesselStep.map((x, i) => x + drift[i]!)));
  out.push({ check: 'vessel step', ok: vessel < STEP_TOLERANCE, value: vessel, text: `the vessel stepped ${metres(norm(replaced.vesselStep))} (control ${metres(norm(control.vesselStep))}): ${metres(vessel)} from the step of a frame that always had the new origin` });
  for (const g of control.ghosts) {
    const r = replaced.ghosts.find((x) => x.vesselId === g.vesselId);
    const off = r ? norm(minus(r.relCam, g.relCam)) : Infinity;
    out.push({ check: 'ghost', ok: off < HELD_TOLERANCE, value: off, text: r ? `the ghost of ${g.vesselId} is drawn ${metres(norm(r.relCam))} from the eye (control ${metres(norm(g.relCam))}): ${metres(off)} from where the control draws it` : `no ghost of ${g.vesselId} is drawn` });
  }
  if (control.domainVelocity && replaced.domainVelocity) {
    const d = norm(minus(replaced.domainVelocity, control.domainVelocity));
    out.push({ check: 'particle streak', ok: d < STREAK_TOLERANCE, value: d, text: `the effect domain (${replaced.domainKind}) passes the eye at ${norm(replaced.domainVelocity).toExponential(3)} m/s (control ${norm(control.domainVelocity).toExponential(3)} m/s): ${d.toExponential(2)} m/s apart` });
  }
  return out;
}

/** The checks on what is drawn: the velocity target and the picture, against the control's. */
function judgePicture(control: Run, replaced: Run): { verdicts: Verdict[]; diff: Buffer } {
  const ratio = control.velocity.max > 0 ? replaced.velocity.max / control.velocity.max : Infinity;
  const noSpike = replaced.velocity.max < control.velocity.max * 1.05 + 1e-5 && Math.abs(replaced.velocity.mean - control.velocity.mean) < 0.02 * control.velocity.mean + 1e-6;
  const d = imageDifference(control.image, replaced.image);
  const same = d.p999 <= LAST_BITS.p999 && d.meanAbs <= LAST_BITS.meanAbs;
  return {
    diff: d.diff,
    verdicts: [
      { check: 'motion vectors', ok: noSpike, value: ratio, text: `velocity target: max ${replaced.velocity.max.toExponential(3)} (control ${control.velocity.max.toExponential(3)}), mean ${replaced.velocity.mean.toExponential(3)} (control ${control.velocity.mean.toExponential(3)})` },
      { check: 'picture', ok: same, value: d.meanAbs, text: `${describe(d)}; ${pixelsOver(control.image, replaced.image, 8)} pixels by more than 8 levels` },
    ],
  };
}

for (const scene of REBASE_SCENES.filter((s) => only.length === 0 || only.includes(s.name))) {
  test(`${scene.name}: a replacement of the origin between two frames leaves no step, nothing displaced and no motion-vector spike; with a rebase switched off it does`, async ({ page, pageLog }) => {
    const tag = `[origin] rebase ${scene.name}`;
    fs.mkdirSync(outDir, { recursive: true });
    const save = (file: string, image: Buffer): void => fs.writeFileSync(path.join(outDir, `rebase-${scene.name}.${file}.png`), image);

    // ---- the runs: two without a replacement, one with it, and one for every rebase switched off
    const control = await runScene(page, pageLog, scene, { replace: false });
    const again = await runScene(page, pageLog, scene, { replace: false });
    const replaced = await runScene(page, pageLog, scene, { replace: true });
    const offRuns: { norebase: Switch; fails: CheckName[]; run: Run }[] = [];
    for (const o of scene.off) offRuns.push({ ...o, run: await runScene(page, pageLog, scene, { replace: true, norebase: o.norebase }) });
    const runs = [control, again, replaced, ...offRuns.map((o) => o.run)];
    console.log(`${tag}: the compared frames have the indices ${runs.map((r) => r.frameIndex).join(', ')}: frame ${REBASE_LEAD} of a capture each (lead-in of ${control.leadIn} frames)`);
    save('control', control.image);
    save('replaced', replaced.image);

    // ---- every run rendered the same frames, and the scene holds what it is there for
    // The capture's first frame stands at a multiple of 64 (SEQUENCE_ALIGN of the render core): every run compares frame REBASE_LEAD of it.
    expect(runs.map((r) => r.frameIndex % 64), 'every run compares the same frame of its capture').toEqual(runs.map(() => REBASE_LEAD));
    expect(replaced.epoch, 'the compared frame carries a new frame epoch').toBe(control.epoch + 1);
    expect(replaced.originBody).toBe(scene.to);
    expect(replaced.originVelocity, 'the snapshot states the old origin in the new frame').not.toBeNull();
    if (scene.stage?.what === 'drop') {
      console.log(`${tag}: the control draws the ghost of ${control.ghosts.map((g) => `${g.vesselId} ${metres(norm(g.relCam))} from the eye`).join(', ') || 'nothing'}`);
      expect(control.ghosts.length, 'the vessel that left the snapshot is drawn as a ghost').toBe(1);
      expect(norm(control.ghosts[0]!.relCam), 'the ghost is near the camera').toBeLessThan(200);
    }
    if (scene.stage?.what === 'burst') {
      console.log(`${tag}: ${control.particles} particles alive in a ${control.domainKind} domain`);
      expect(control.domainKind, 'the particles live in a space domain').toBe('space');
      expect(control.particles, 'particles of the burst are alive in the compared frame').toBeGreaterThan(50);
    }
    if (scene.stage?.what === 'cut') {
      console.log(`${tag}: ${control.canopies} canopies drawn, ${control.openChutes} parachute modules open`);
      expect(control.openChutes, 'every parachute is cut away').toBe(0);
      expect(control.canopies, 'the canopies that were cut away are drawn adrift').toBeGreaterThan(0);
    }

    // ---- part 2, first what is formed across the replacement: the eye, the vessel, what is held (no picture is read)
    const steps = judgeSteps(control, replaced);
    for (const v of steps) console.log(`${tag}: ${v.check}: ${v.text}${v.ok ? '' : '   <-- FAILS'}`);
    for (const v of steps) expect(v.ok, `rebase ${scene.name}, ${v.check}: ${v.text}`).toBe(true);

    // ---- then the pictures. The precondition: two runs without a replacement are one picture to the bit.
    const self = imageDifference(control.image, again.image);
    console.log(`${tag}: two runs without a replacement: ${describe(self)}; velocity max ${control.velocity.max.toExponential(3)} and ${again.velocity.max.toExponential(3)}`);
    if (self.maxAbs > 0) save('control.diff', self.diff);
    expect(Math.round(self.differingFraction * self.width * self.height), `rebase ${scene.name}: two runs WITHOUT a replacement are not one picture (${describe(self)}; rebase-${scene.name}.control.diff.png): no comparison with them means anything`).toBe(0);
    expect(control.velocity.max, 'the scene moves on screen (else the motion vectors prove nothing)').toBeGreaterThan(1e-5);
    const drawn = judgePicture(control, replaced);
    save('diff', drawn.diff);
    for (const v of drawn.verdicts) console.log(`${tag}: ${v.check}: ${v.text}${v.ok ? '' : '   <-- FAILS'}`);
    for (const v of drawn.verdicts) expect(v.ok, `rebase ${scene.name}, ${v.check}: ${v.text} (rebase-${scene.name}.diff.png)`).toBe(true);

    // ---- part 3: with a rebase switched off the same checks fail, by the distance between the two origins
    for (const o of offRuns) {
      const offTag = `${tag}, norebase=${o.norebase}`;
      expect(o.run.epoch, `${offTag}: the origin was replaced`).toBe(control.epoch + 1);
      const picture = judgePicture(control, o.run);
      save(`no-${o.norebase}`, o.run.image);
      save(`no-${o.norebase}.diff`, picture.diff);
      const verdicts = [...judgeSteps(control, o.run), ...picture.verdicts];
      for (const v of verdicts) console.log(`${offTag}: ${v.check}: ${v.text}${v.ok ? '' : '   <-- FAILS'}`);
      for (const name of o.fails) {
        const v = verdicts.find((x) => x.check === name);
        expect(v, `${offTag}: the check "${name}" was made`).toBeDefined();
        expect(v!.ok, `${offTag}: the check "${name}" must FAIL without the rebase, and passed: ${v!.text}`).toBe(false);
        // By how much: a position displaced by the distance between the origins; a streak of that length a frame; motion vectors that leave the frame.
        if (name === 'eye step' || name === 'vessel step' || name === 'ghost') expect(v!.value, `${offTag}, ${name}: displaced by the distance between the two origins`).toBeGreaterThan(ORIGIN_DISTANCE_FLOOR);
        if (name === 'particle streak') expect(v!.value, `${offTag}, ${name}: the distance between the two origins in one frame`).toBeGreaterThan(ORIGIN_DISTANCE_FLOOR / o.run.dt / 2);
        if (name === 'motion vectors') expect(v!.value, `${offTag}, ${name}: the largest motion vector against the control's`).toBeGreaterThan(3);
      }
    }
  });
}
