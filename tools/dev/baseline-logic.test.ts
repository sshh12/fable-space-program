/**
 * The browser-free part of the reference-image tooling (tests/browser/baselineLogic.ts, lead-owned): the
 * first-capture rule of a frame-exact capture (request core-7), a checkpoint's setup steps, the validation of
 * a manifest, and the tracked manifest itself (every checkpoint framed). No page is opened here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  captureFrameExact,
  describeStep,
  exactPairVerdict,
  manifestProblems,
  NotFrameExactError,
  stepProblems,
  STEP_REPEAT_MAX,
  type BaselineCheckpoint,
  type BaselineManifest,
  type BaselineStep,
} from '../../tests/browser/baselineLogic';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A width x height opaque image painted by `rgb(x, y)`. */
function image(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const W = 64;
const H = 36;
const picture = (x: number, y: number): [number, number, number] => [(x * 7 + y * 3) % 256, (x + y * 5) % 256, (x * 2 + y) % 256];
const held = image(W, H, picture);
/** The held frame with `count` pixels of its first row brighter by `levels` in green (a probe that had not converged). */
const unsettled = (count: number, levels: number): Buffer =>
  image(W, H, (x, y) => {
    const [r, g, b] = picture(x, y);
    return y === 0 && x < count ? [r, g + levels <= 255 ? g + levels : g - levels, b] : [r, g, b];
  });
/** A source of captures that hands out the given buffers in order and counts the calls. */
function source(...frames: Buffer[]): { capture: () => Promise<Buffer>; calls: () => number } {
  let n = 0;
  return {
    capture: () => {
      const f = frames[n];
      n++;
      return f ? Promise.resolve(f) : Promise.reject(new Error('more captures were asked for than the rule needs'));
    },
    calls: () => n,
  };
}

describe('the first-capture rule of a frame-exact capture', () => {
  it('two captures are compared to the bit: any pixel, any channel', () => {
    expect(exactPairVerdict(held, image(W, H, picture))).toEqual({ identical: true, differingPixels: 0, maxAbs: 0, width: W, height: H });
    const one = image(W, H, (x, y) => (x === 10 && y === 20 ? [picture(x, y)[0], picture(x, y)[1], picture(x, y)[2] + 1] : picture(x, y)));
    expect(exactPairVerdict(held, one)).toMatchObject({ identical: false, differingPixels: 1, maxAbs: 1 });
    expect(exactPairVerdict(held, unsettled(17, 9))).toMatchObject({ identical: false, differingPixels: 17, maxAbs: 9 });
    expect(() => exactPairVerdict(held, image(W, H - 1, picture))).toThrow(/different sizes/);
  });

  it('takes three captures: the lead-in is thrown away, the next two must agree, the second of them is the capture', async () => {
    // The first capture of a freshly loaded page differs on the vessel (core-7); the next two are the same picture.
    const second = image(W, H, picture);
    const s = source(unsettled(40, 12), held, second);
    const taken = await captureFrameExact(s.capture, 'checkpoint "leo-day"');
    expect(s.calls()).toBe(3);
    expect(taken.image).toBe(second);
    // What the lead-in showed is reported, never a failure.
    expect(taken.leadIn).toMatchObject({ identical: false, differingPixels: 40, maxAbs: 12 });
    // A page whose first capture is already the picture reports a clean lead-in.
    expect((await captureFrameExact(source(held, held, held).capture)).leadIn.identical).toBe(true);
  });

  it('two captures that differ after the lead-in are not frame-exact: the capture fails with the count of differing pixels', async () => {
    const s = source(held, held, unsettled(3, 5));
    const failure = await captureFrameExact(s.capture, 'checkpoint "sweep-hud-leo"').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFrameExactError);
    const e = failure as NotFrameExactError;
    expect(e.pair).toMatchObject({ differingPixels: 3, maxAbs: 5 });
    expect(e.message).toMatch(/^checkpoint "sweep-hud-leo" is NOT FRAME-EXACT: two consecutive frame-exact captures after the lead-in differ in 3 of 2304 pixels \(by up to 5 levels\)/);
    expect(s.calls()).toBe(3);
    // A single differing pixel is enough, and a lead-in that happens to agree with one of them excuses nothing.
    await expect(captureFrameExact(source(held, unsettled(1, 1), held).capture)).rejects.toThrow(/differ in 1 of 2304 pixels/);
    // A failing source is not swallowed.
    await expect(captureFrameExact(source(held).capture)).rejects.toThrow(/more captures were asked for/);
  });
});

describe('the setup steps of a checkpoint', () => {
  it('a step is a call on a test handle, a wait for idle or a number of frames', () => {
    const good: BaselineStep[] = [
      { call: '__test.setPaused', args: [true] },
      { call: '__integration.viewBodyAtPhase', args: ['moon', 90, 21737400] },
      { call: '__integration.mapCamera', args: [null, 30, 55, 2.5e7] },
      { call: '__test.commands.stage' },
      { call: '__lab.renderFrame', args: [1 / 60], repeat: 180 },
      { waitIdle: true },
      { waitFrames: 8 },
    ];
    for (const s of good) expect(stepProblems(s), describeStep(s)).toEqual([]);
    expect(good.map(describeStep)).toEqual([
      '__test.setPaused(true)', '__integration.viewBodyAtPhase("moon", 90, 21737400)', '__integration.mapCamera(null, 30, 55, 25000000)', '__test.commands.stage()',
      '__lab.renderFrame(0.016666666666666666) x 180', 'wait for idle', 'wait 8 frames',
    ]);
  });

  it('refuses a path that is not a function of a test handle, a repeat out of range, and unknown fields', () => {
    expect(stepProblems({ call: 'document.write', args: ['x'] })[0]).toMatch(/not a function path of a test handle/);
    expect(stepProblems({ call: '__test' })[0]).toMatch(/not a function path/);
    expect(stepProblems({ call: '__lab.renderFrame; alert(1)' })[0]).toMatch(/not a function path/);
    expect(stepProblems({ call: '__lab.renderFrame', repeat: 0 })[0]).toMatch(/repeat must be a whole number from 1 to/);
    expect(stepProblems({ call: '__lab.renderFrame', repeat: STEP_REPEAT_MAX + 1 })).toHaveLength(1);
    expect(stepProblems({ call: '__lab.renderFrame', args: 3 } as unknown as BaselineStep)[0]).toMatch(/args must be an array/);
    expect(stepProblems({ call: '__lab.renderFrame', times: 3 } as unknown as BaselineStep)[0]).toMatch(/unknown field "times"/);
    expect(stepProblems({ waitFrames: 0 })).toHaveLength(1);
    expect(stepProblems({ waitIdle: false } as unknown as BaselineStep)).toHaveLength(1);
    expect(stepProblems({} as unknown as BaselineStep)[0]).toMatch(/a step is a call, a waitIdle or a waitFrames/);
  });
});

describe('a manifest in which every checkpoint is framed and can be captured frame-exactly', () => {
  const lab = '/labs/integration/?scene=lowOrbit&hud=0&governor=off&deterministic=1&paused=1';
  const framed: BaselineCheckpoint = { what: 'Low Earth orbit over the day side', page: lab, frames: 64, status: 'pending' };
  const manifest = (checkpoints: Record<string, BaselineCheckpoint>): BaselineManifest => ({ version: 1, dir: 'data/baselines', viewport: [1280, 720], floor: { meanAbs: 0.02, p999: 1 }, checkpoints });
  const problems = (c: Partial<BaselineCheckpoint>): string[] => manifestProblems(manifest({ view: { ...framed, ...c } }));

  it('accepts a frozen lab page and an app page that its setup freezes', () => {
    expect(problems({})).toEqual([]);
    expect(problems({ page: '/?scenario=lunar-direct&governor=off', setup: [{ call: '__test.setDeterministic', args: [true] }, { call: '__test.setPaused', args: [true] }, { waitIdle: true }] })).toEqual([]);
  });

  it('names what is wrong: no page, a lab page that is not frozen, an app page nobody freezes, too few frames, a bad name, a bad step', () => {
    expect(problems({ page: null })).toEqual(['view: not framed: it has no page']);
    expect(problems({ page: '/labs/integration/?scene=lowOrbit&deterministic=1' })).toEqual(['view: a lab page is opened frozen: deterministic=1&paused=1 in its query']);
    expect(problems({ page: '/?scenario=lunar-direct' })).toEqual(['view: a page of the app is frozen by its setup: __test.setDeterministic(true) and __test.setPaused(true)']);
    expect(problems({ page: '/?scenario=lunar-direct', setup: [{ call: '__test.setDeterministic', args: [true] }, { call: '__test.setPaused', args: [false] }] })).toHaveLength(2);
    expect(problems({ page: 'labs/integration/' })).toEqual(['view: "page" must be a path from the site root']);
    expect(problems({ frames: 8 })).toEqual(['view: "frames" must be a whole number from 16']);
    expect(problems({ what: 'short' })).toEqual(['view: "what" must say what the checkpoint shows']);
    expect(problems({ setup: [{ call: 'window.close' }] })[0]).toMatch(/^view: setup\[0\]: "window.close" is not a function path/);
    expect(manifestProblems(manifest({ 'Leo Day': framed }))[0]).toMatch(/^Leo Day: a checkpoint name is lower-case words joined by hyphens/);
  });

  it('a setup that steps the lab by hand must hand it back: the loop running, the simulation paused', () => {
    const stepped: BaselineStep[] = [{ call: '__lab.setLoop', args: [false] }, { call: '__lab.setPaused', args: [false] }, { call: '__lab.renderFrame', args: [1 / 60], repeat: 120 }];
    expect(problems({ setup: stepped })).toEqual(["view: the setup stops the lab's frame loop and does not start it again", 'view: the setup leaves the simulation running: a reference is a held frame of a paused page']);
    expect(problems({ setup: [...stepped, { call: '__lab.setPaused', args: [true] }, { call: '__lab.setLoop', args: [true] }] })).toEqual([]);
  });

  it('a recorded checkpoint has its file, hash, tolerance from three or more loads, and the lead\'s note', () => {
    const recorded: BaselineCheckpoint = {
      ...framed, status: 'recorded', file: 'view.png', sha256: 'a'.repeat(64), width: 1280, height: 720, tolerance: { meanAbs: 0.04, p999: 3 }, selfDifference: { meanAbs: 0.01, p999: 1 }, loads: 3,
      notExact: { reason: 'the surf at the shore differs a little from load to load', request: 'lead-7' },
      recorded: { at: '2026-11-12T00:00:00.000Z', commit: 'abc1234', chrome: '157', adapter: 'nvidia', tiles: {}, note: 'the lead, before sub-wave 3.2', leadInDifferingPixels: [261, 0, 0] },
    };
    expect(manifestProblems(manifest({ view: recorded }))).toEqual([]);
    expect(manifestProblems(manifest({ view: { ...recorded, tolerance: { meanAbs: 0.02, p999: 1 } } }))).toEqual(['view: its tolerance is under three times the largest difference between its loads']);
    const { notExact: _reason, ...withoutReason } = recorded;
    void _reason;
    expect(manifestProblems(manifest({ view: { ...withoutReason, exact: true, tolerance: { meanAbs: 0.01, p999: 1 }, selfDifference: { meanAbs: 0, p999: 0 } } }))).toEqual(['view: its tolerance is under the floor']);
    expect(manifestProblems(manifest({ view: { ...recorded, loads: 2 } }))[0]).toMatch(/three or more/);
    expect(manifestProblems(manifest({ view: { ...recorded, sha256: 'abc' } }))[0]).toMatch(/file, sha256 or size is missing/);
    expect(manifestProblems(manifest({ view: { ...recorded, recorded: { ...recorded.recorded!, note: 'x' } } }))[0]).toMatch(/without the lead's note/);
  });

  it('a recorded checkpoint is exact (its loads were one picture) or says why not, with the request to the owner', () => {
    const base: BaselineCheckpoint = {
      ...framed, status: 'recorded', file: 'view.png', sha256: 'a'.repeat(64), width: 1280, height: 720, tolerance: { meanAbs: 0.02, p999: 1 }, selfDifference: { meanAbs: 0, p999: 0 }, loads: 3,
      recorded: { at: '2026-11-12T00:00:00.000Z', commit: 'abc1234', chrome: '157', adapter: 'nvidia', tiles: {}, note: 'the lead, before sub-wave 3.2', leadInDifferingPixels: [0, 0, 0] },
    };
    const differing = { tolerance: { meanAbs: 0.02, p999: 3 }, selfDifference: { meanAbs: 0.001, p999: 1 } };
    const reason = { reason: 'the dust sheet under the lander differs from load to load', request: 'lead-8' };
    const one = (c: BaselineCheckpoint): string[] => manifestProblems(manifest({ view: c }));
    expect(one({ ...base, exact: true })).toEqual([]);
    expect(one({ ...base, ...differing, notExact: reason })).toEqual([]);
    // Neither: the recording is not finished until the lead has said which.
    expect(one(base)).toEqual(['view: recorded and not marked exact: it needs "notExact" with the reason its loads differ and the request to the owner']);
    expect(one({ ...base, ...differing })).toHaveLength(1);
    // Both, or the wrong one for what the loads did.
    expect(one({ ...base, exact: true, notExact: reason })).toEqual(['view: it is marked exact and carries a reason for not being exact']);
    expect(one({ ...base, ...differing, exact: true })).toEqual(['view: it is marked exact, but the loads of its recording differ']);
    expect(one({ ...base, notExact: reason })).toEqual(['view: the loads of its recording are identical: it is exact, not "notExact"']);
    expect(one({ ...base, exact: false as unknown as true })).toEqual(['view: "exact" is true or absent']);
    // The reason is a sentence and the request is a file of docs/requests.
    expect(one({ ...base, ...differing, notExact: { reason: 'noise', request: 'lead-8' } })).toEqual(['view: "notExact.reason" must say in one line why the loads differ']);
    expect(one({ ...base, ...differing, notExact: { ...reason, request: 'ask the ocean' } })[0]).toMatch(/"notExact.request" names the request to the owner/);
    expect(one({ ...base, ...differing, notExact: { reason: '', request: '' } })).toHaveLength(2);
    // And neither belongs to a checkpoint that is not recorded.
    expect(problems({ exact: true })).toEqual(['view: "exact" and "notExact" belong to a recorded checkpoint']);
  });
});

describe('the tracked manifest, tests/browser/baselines.manifest.json', () => {
  const tracked = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'browser', 'baselines.manifest.json'), 'utf8')) as BaselineManifest;
  const ARCHITECTURE_31_3 = [
    'pad-noon', 'pad-sunset', 'ascent-cloud-deck', 'ascent-10km', 'ascent-40km', 'leo-day', 'leo-terminator', 'leo-night', 'leo-nadir-day', 'leo-nadir-night',
    'translunar-earth', 'translunar-moon', 'lunar-terminator-20000km', 'lunar-terminator-5000km', 'lunar-orbit-low-sun', 'lunar-touchdown', 'lunar-surface-cockpit',
    'reentry-peak-heating', 'parachute-descent', 'splashdown', 'shoreline', 'ocean-climb-2m', 'ocean-climb-200m', 'ocean-climb-20km', 'ocean-climb-400km',
  ];
  const SWEEP = ['sweep-hud-leo', 'sweep-map-translunar', 'sweep-cockpit-leo', 'sweep-separation-debris', 'sweep-lunar-orbit', 'sweep-rails-warp', 'sweep-app-pad', 'sweep-app-cockpit'];

  it('has nothing wrong with it: every checkpoint is framed', () => {
    expect(manifestProblems(tracked)).toEqual([]);
    expect(Object.values(tracked.checkpoints).filter((c) => c.page === null)).toEqual([]);
    expect(tracked.viewport).toEqual([1280, 720]);
    expect(tracked.dir).toBe('data/baselines');
  });

  it('every recorded checkpoint is exact, or names why not and a request that exists', () => {
    const recorded = Object.entries(tracked.checkpoints).filter(([, c]) => c.status === 'recorded');
    for (const [name, c] of recorded) {
      if (c.exact) {
        expect(c.selfDifference, name).toEqual({ meanAbs: 0, p999: 0 });
        expect(c.notExact, name).toBeUndefined();
      } else {
        expect(c.notExact!.reason.length, name).toBeGreaterThan(20);
        expect(c.notExact!.reason, `${name}: one line`).not.toMatch(/\n/);
        expect(fs.existsSync(path.join(repoRoot, 'docs', 'requests', `${c.notExact!.request}.md`)), `${name}: docs/requests/${c.notExact!.request}.md`).toBe(true);
      }
    }
    // The gate of a refactor that must not move a pixel is an assertion on most of the set.
    expect(recorded.filter(([, c]) => c.exact).length).toBeGreaterThanOrEqual(recorded.length - 6);
  });

  it('lists the 25 checkpoints of ARCHITECTURE 31.3 and the eight views the presentation sweep can break', () => {
    expect(Object.keys(tracked.checkpoints).sort()).toEqual([...ARCHITECTURE_31_3, ...SWEEP].sort());
    for (const [name, c] of Object.entries(tracked.checkpoints)) {
      // Framed in words as well: the scenario or scene, the camera, the exposure rule.
      expect((c.scene ?? '').length, `${name}: scene`).toBeGreaterThan(10);
      expect((c.camera ?? '').length, `${name}: camera`).toBeGreaterThan(10);
      expect(c.exposure ?? '', `${name}: exposure`).toMatch(/^(auto|ev \d+)/);
      // A pinned exposure is pinned by the page's query, and only then.
      expect(/[?&]ev=/.test(c.page!), `${name}: ev in the query`).toBe(/^ev /.test(c.exposure!));
    }
    // The sweep's views consume the snapshot of the REAL simulation or are the app itself, with the HUD where it matters.
    for (const name of SWEEP) {
      const page = tracked.checkpoints[name]!.page!;
      expect(page.startsWith('/?scenario=') || /[?&]sim=real&scenario=qa-/.test(page), name).toBe(true);
      expect(tracked.checkpoints[name]!.what.startsWith('SWEEP: '), name).toBe(true);
    }
    for (const name of ['sweep-hud-leo', 'sweep-map-translunar', 'sweep-separation-debris', 'sweep-lunar-orbit', 'sweep-rails-warp']) expect(tracked.checkpoints[name]!.page, name).toMatch(/flighthud=1/);
    expect(tracked.checkpoints['sweep-map-translunar']!.page).toMatch(/map=1/);
  });

  it('the two views that step the simulation do it in whole frames with the loop stopped, and hand the page back frozen', () => {
    for (const name of ['sweep-separation-debris', 'sweep-rails-warp']) {
      const steps = tracked.checkpoints[name]!.setup!.map(describeStep);
      expect(steps[0], name).toBe('__lab.setLoop(false)');
      expect(steps[1], name).toBe('__lab.setPaused(false)');
      expect(steps.slice(-3), name).toEqual(['__lab.setPaused(true)', '__lab.setLoop(true)', 'wait for idle']);
      expect(steps.some((s) => /^__lab\.renderFrame\(0\.016666666666666666\) x \d+$/.test(s)), name).toBe(true);
    }
    expect(tracked.checkpoints['sweep-separation-debris']!.setup!.map(describeStep)).toContain('__test.commands.stage()');
    expect(tracked.checkpoints['sweep-rails-warp']!.setup!.map(describeStep)).toEqual(expect.arrayContaining(['__test.commands.setWarpLevel(8)', '__test.commands.setWarpLevel(0)']));
  });
});
