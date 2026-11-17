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
 *    with the same frame of a run in which the origin stayed. No visible step (the pictures agree as the two
 *    origins of part 1 do) and no motion-vector spike (the velocity target of the frame is the control's).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/origin.spec.ts --project=functional
 *
 * ORIGIN_ONLY=a,b narrows the frames of part 1; ORIGIN_EXTRA=<query> is appended to its pages (to look for
 * what moves a picture: `&without=vfx`). Pictures: out/screens/presentation-sweep/origin/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
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
interface LabPage {
  __lab: {
    snapshot(): { ut: number; activeVesselId: string; vessels: { id: string; bodyId: string; rRoot: Vec }[]; bodies: { id: string; rRoot: Vec }[]; frame?: { epoch: number; origin: { kind: string; bodyId: string } } };
    cameraState(): { positionRoot: Vec };
    renderer: {
      readonly frameContext: { frameIndex: number; prevEyeOffset: Vec; snapshot: { vessels: { rRoot: Vec }[] }; prevSnapshot: { vessels: { rRoot: Vec }[] } } | null;
      readVelocity(): Promise<{ width: number; height: number; data: Float32Array }>;
    };
    setDeterministic(on: boolean): void;
    setLoop(running: boolean): void;
    setPaused(paused: boolean): void;
    renderFrame(dt?: number): void;
  };
  __integration: { setRenderRoot(bodyId: string): boolean };
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

/** Velocity target of the last frame: the largest and the mean length of the UV-space velocity over the frame. */
async function velocityStats(page: Page): Promise<{ max: number; mean: number }> {
  return page.evaluate(async () => {
    const v = await (window as unknown as LabPage).__lab.renderer.readVelocity();
    let max = 0;
    let sum = 0;
    for (let i = 0; i < v.data.length; i += 2) {
      const m = Math.hypot(v.data[i]!, v.data[i + 1]!);
      if (m > max) max = m;
      sum += m;
    }
    return { max, mean: sum / (v.data.length / 2) };
  });
}

const REBASE_SCENES = [
  // Two metres above the sea (the camera of the ocean-climb checkpoints): the near water is placed one frame
  // back with the eye's displacement between the two frames (prevEyeOffset), which is formed from both
  // frames' cameras; the origin goes to the Moon.
  { name: 'sea', page: '/labs/integration/?scene=lowOrbit&body=earth&lat=8&lon=-140&alt=2&heading=120&pitch=-20&sun=120,40&sunsite=earth,8,-140&ev=14.5&hud=0&governor=off&deterministic=1&paused=1', to: 'moon' },
  // Low Earth orbit (7.7 km/s over the sea: the water reprojects with the eye's displacement); the origin goes to the Moon.
  { name: 'leo', page: '/labs/integration/?scene=lowOrbit&orbit=30,15,60&ev=14.5&hud=0&governor=off&deterministic=1&paused=1', to: 'moon' },
  // Low lunar orbit, drawn about the root body; the origin goes to the Moon, as at the change of the sphere of influence.
  { name: 'lunar-orbit', page: '/labs/integration/?scene=lunarOrbit&orbit=30,15,60&ev=14.5&hud=0&governor=off&deterministic=1&paused=1&origin=root', to: 'moon' },
];
// (`&ev=`: a fixed exposure. The meter reads the frame back from the GPU a few frames late, at a moment that
// differs from load to load while frames are stepped by hand; a frame-exact capture holds what its lead-in
// metered, which a frame that must follow its predecessor cannot do.)
/** Frames stepped with time running before the frame that is compared. */
const REBASE_LEAD = 12;

for (const scene of REBASE_SCENES) {
  test(`${scene.name}: a replacement of the origin between two frames leaves no step and no motion-vector spike`, async ({ page, pageLog }) => {
    const run = async (replace: boolean): Promise<{ image: Buffer; velocity: { max: number; mean: number }; epoch: number; originBody: string | null; eyeStep: number; vesselStep: number }> => {
      await openPage(page, scene.page, { timeoutMs: 180_000 });
      await assertDiscreteGpu(page);
      await page.waitForFunction(() => window.__test !== undefined && window.__test.isIdle(), undefined, { timeout: 180_000 });
      const frame = await page.evaluate(
        async ({ lead, to }) => {
          const w = window as unknown as LabPage;
          w.__lab.setLoop(false);
          // Every load steps the same frames: the phases a feature takes from the frame index start at a
          // multiple of 64 frames (SEQUENCE_ALIGN of the render core), so stand on one with the time still
          // held, and start the jitter sequence and the temporal history from their origin there.
          for (let guard = 0; guard < 256 && (w.__lab.renderer.frameContext!.frameIndex + 1) % 64 !== 0; guard++) w.__lab.renderFrame(1 / 60);
          if ((w.__lab.renderer.frameContext!.frameIndex + 1) % 64 !== 0) throw new Error('the frame index did not reach a multiple of 64');
          w.__lab.setDeterministic(false);
          w.__lab.setDeterministic(true);
          w.__lab.setPaused(false);
          for (let i = 0; i < lead; i++) w.__lab.renderFrame(1 / 60);
          if (to !== null && !w.__integration.setRenderRoot(to)) throw new Error('the page has no fake session whose origin can be replaced');
          // The frame that carries the new epoch (or, in the control run, the same frame without one).
          w.__lab.renderFrame(1 / 60);
          const s = w.__lab.snapshot();
          // The canvas shows the frame once the compositor has presented it.
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          // What the core formed from this frame and the one before it: how far the eye and the vessel moved, m.
          const fc = w.__lab.renderer.frameContext!;
          const a = fc.snapshot.vessels[0]!.rRoot;
          const b = fc.prevSnapshot.vessels[0]!.rRoot;
          return {
            epoch: s.frame?.epoch ?? -1,
            originBody: s.frame?.origin.kind === 'body' ? s.frame.origin.bodyId : null,
            eyeStep: Math.hypot(fc.prevEyeOffset.x, fc.prevEyeOffset.y, fc.prevEyeOffset.z),
            vesselStep: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
          };
        },
        { lead: REBASE_LEAD, to: replace ? scene.to : null },
      );
      const velocity = await velocityStats(page);
      const image = await page.screenshot();
      await expectNoErrors(page, pageLog);
      return { image, velocity, ...frame };
    };
    const control = await run(false);
    // The same frames once more: what two loads differ by on their own (nothing, when the page is deterministic).
    const again = await run(false);
    const self = imageDifference(control.image, again.image);
    console.log(`[origin] rebase ${scene.name}: two control runs: ${describe(self)}`);
    // (Over the sea and under clouds two loads are not one picture to the bit: what they differ by is the measure.)
    expect(self.p999, `rebase ${scene.name}: two runs without a replacement differ too much for the comparison to mean anything`).toBeLessThanOrEqual(4);
    const replaced = await run(true);
    expect(replaced.epoch, 'the compared frame carries a new frame epoch').toBe(control.epoch + 1);
    expect(replaced.originBody).toBe(scene.to);
    const d = imageDifference(control.image, replaced.image);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `rebase-${scene.name}.control.png`), control.image);
    fs.writeFileSync(path.join(outDir, `rebase-${scene.name}.replaced.png`), replaced.image);
    fs.writeFileSync(path.join(outDir, `rebase-${scene.name}.diff.png`), d.diff);
    console.log(`[origin] rebase ${scene.name}: ${describe(d)}; velocity max ${replaced.velocity.max.toExponential(3)} (control ${control.velocity.max.toExponential(3)}), mean ${replaced.velocity.mean.toExponential(3)} (control ${control.velocity.mean.toExponential(3)})`);
    // No visible step: the frame after the replacement is the control's frame, as far as two loads of the
    // control are one frame, and but for the last bits (part 1 of this file).
    expect(d.p999, `rebase ${scene.name}: the frame after the replacement is not the frame without it (rebase-${scene.name}.diff.png)`).toBeLessThanOrEqual(self.p999 + 1);
    expect(d.meanAbs).toBeLessThanOrEqual(2 * self.meanAbs + 0.05);
    // The previous frame is read in the new frame: the eye and the vessel moved by what they move in a sixtieth
    // of a second (metres to hundreds of metres), not by the distance between the two origins.
    console.log(`[origin] rebase ${scene.name}: over the frame the eye moved ${replaced.eyeStep.toFixed(2)} m (control ${control.eyeStep.toFixed(2)} m), the vessel ${replaced.vesselStep.toFixed(2)} m (control ${control.vesselStep.toFixed(2)} m)`);
    expect(replaced.eyeStep).toBeLessThan(1000);
    expect(replaced.vesselStep).toBeLessThan(1000);
    // No motion-vector spike: the frame moves on screen as it does without the replacement.
    expect(control.velocity.max, 'the scene moves on screen (else the test proves nothing)').toBeGreaterThan(1e-5);
    expect(replaced.velocity.max).toBeLessThan(control.velocity.max * 1.05 + 1e-5);
    expect(Math.abs(replaced.velocity.mean - control.velocity.mean)).toBeLessThan(0.02 * control.velocity.mean + 1e-6);
  });
}
