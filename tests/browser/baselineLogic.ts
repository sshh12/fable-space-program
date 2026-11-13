/**
 * The part of the reference-image tooling that needs no browser (lead-owned, like harness.ts, which re-exports
 * it): the manifest's types and its validation, the setup steps of a checkpoint, and the FIRST-CAPTURE RULE of
 * a frame-exact capture. Unit-tested by tools/dev/baseline-logic.test.ts (vitest); harness.ts supplies the
 * page.
 *
 * THE FIRST-CAPTURE RULE (request core-7). The first frame-exact capture of a freshly loaded page can differ
 * from every later one in a few hundred pixels on the vessel (the sky's environment probe has not converged
 * when every feature reports idle; the fix is the sky package's, after the presentation sweep). Until then a
 * reference capture is three captures: a LEAD-IN, which is thrown away, and two more, which must be identical
 * to the bit; the second of the two is the capture. Two that differ are not papered over by a tolerance: the
 * checkpoint is NOT FRAME-EXACT and fails as such, with the number of differing pixels, both when a baseline
 * is recorded (nothing is written) and when a page is compared with one.
 */
import { PNG } from 'pngjs';

export interface BaselineTolerance {
  meanAbs: number;
  p999: number;
}

/**
 * One step of a checkpoint's setup, run in order after its page has loaded and before the capture:
 *  - `call`: a function of one of the page's test handles, by its path from `window` (`__test.setPaused`,
 *    `__integration.viewBodyAtPhase`, `__lab.renderFrame`), with JSON arguments, awaited; `repeat` calls it
 *    that many times (deterministic stepping: `__lab.renderFrame` with the loop stopped). A call that returns
 *    `false` or `null` could not do what was asked (no cockpit seat, no window): the setup fails.
 *  - `waitIdle`: wait until the page reports no streaming or compilation in progress.
 *  - `waitFrames`: let that many frames be presented.
 */
export type BaselineStep = { call: string; args?: unknown[]; repeat?: number } | { waitIdle: true } | { waitFrames: number };

export interface BaselineCheckpoint {
  /** What the checkpoint shows (ARCHITECTURE 31.3, or what of the presentation it guards). */
  what: string;
  /** Path and query of the page it is captured from; null = not framed (no such checkpoint is left). */
  page: string | null;
  /** The scenario or scene, in words (information: `page` and `setup` are what is run). */
  scene?: string;
  /** Where the camera is and what it looks at, in words (information). */
  camera?: string;
  /** The exposure rule: 'auto' (the core's meter over the capture's frames, restarted with them) or 'ev <n>' (pinned by the page's query). */
  exposure?: string;
  /** Steps run after the page has loaded (handles of the page; see BaselineStep). */
  setup?: BaselineStep[];
  /** Frames rendered by each frame-exact capture, after the page is idle. */
  frames: number;
  status: 'pending' | 'recorded';
  /** Recorded checkpoints only. */
  file?: string;
  sha256?: string;
  width?: number;
  height?: number;
  tolerance?: BaselineTolerance;
  /** Largest difference between any two of the recording's loads, which the tolerance was derived from, and how many loads there were. */
  selfDifference?: BaselineTolerance;
  loads?: number;
  recorded?: {
    at: string;
    commit: string;
    chrome: string;
    adapter: string;
    tiles: Record<string, string>;
    note: string;
    /** Per load: pixels in which the discarded lead-in capture differed from the capture that was used (request core-7; information). */
    leadInDifferingPixels?: number[];
  };
}

export interface BaselineManifest {
  version: 1;
  /** Directory of the PNG files, relative to the repository root. */
  dir: string;
  /** Capture size in CSS pixels at device scale factor 1. */
  viewport: [number, number];
  /** Smallest tolerance a checkpoint may have (two identical recordings would otherwise allow nothing). */
  floor: BaselineTolerance;
  checkpoints: Record<string, BaselineCheckpoint>;
}

// --------------------------------------------------------------------------------- the first-capture rule

export interface ExactPair {
  identical: boolean;
  /** Pixels in which the two captures differ in any channel. */
  differingPixels: number;
  /** Largest difference of a channel, 8-bit levels. */
  maxAbs: number;
  width: number;
  height: number;
}

/** Two captures of one held frame, compared to the bit (PNG buffers of one size; alpha counts). */
export function exactPairVerdict(a: Buffer, b: Buffer): ExactPair {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error(`two captures of one page have different sizes (${A.width}x${A.height} and ${B.width}x${B.height})`);
  let differingPixels = 0;
  let maxAbs = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!), Math.abs(A.data[i + 3]! - B.data[i + 3]!));
    if (d > 0) {
      differingPixels++;
      if (d > maxAbs) maxAbs = d;
    }
  }
  return { identical: differingPixels === 0, differingPixels, maxAbs, width: A.width, height: A.height };
}

/** A checkpoint whose two captures after the lead-in are not the same picture: it cannot be a reference, nor be compared with one. */
export class NotFrameExactError extends Error {
  constructor(
    readonly what: string,
    readonly pair: ExactPair,
  ) {
    super(
      `${what} is NOT FRAME-EXACT: two consecutive frame-exact captures after the lead-in differ in ${pair.differingPixels} of ${pair.width * pair.height} pixels (by up to ${pair.maxAbs} levels). ` +
        'Something in the picture still changes when every feature reports idle: find it; a tolerance does not stand in for it.',
    );
    this.name = 'NotFrameExactError';
  }
}

export interface ExactCapture {
  /** The capture: the second of the two that agreed. */
  image: Buffer;
  /** How the discarded lead-in differed from it (request core-7; information, never a failure). */
  leadIn: ExactPair;
}

/**
 * The first-capture rule on any source of captures: `capture` is called three times, in order; the first
 * result is the lead-in, the second and third must be identical to the bit, the third is returned.
 */
export async function captureFrameExact(capture: () => Promise<Buffer>, what = 'the page'): Promise<ExactCapture> {
  const leadIn = await capture();
  const first = await capture();
  const second = await capture();
  const pair = exactPairVerdict(first, second);
  if (!pair.identical) throw new NotFrameExactError(what, pair);
  return { image: second, leadIn: exactPairVerdict(leadIn, second) };
}

// ------------------------------------------------------------------------------------------- the manifest

/** Roots of the page's handles a setup step may call. */
export const STEP_ROOTS = ['__test', '__lab', '__integration', '__app'] as const;
const STEP_PATH = new RegExp(`^(${STEP_ROOTS.join('|')})(\\.[A-Za-z_][A-Za-z0-9_]*)+$`);
/** Most calls one step may repeat (deterministic stepping of a lab: a few seconds of frames). */
export const STEP_REPEAT_MAX = 2000;

const isCall = (s: BaselineStep): s is { call: string; args?: unknown[]; repeat?: number } => 'call' in s;

/** The same step in one line, for logs and failure messages. */
export function describeStep(step: BaselineStep): string {
  if ('waitIdle' in step) return 'wait for idle';
  if ('waitFrames' in step) return `wait ${step.waitFrames} frames`;
  return `${step.call}(${(step.args ?? []).map((a) => JSON.stringify(a)).join(', ')})${step.repeat !== undefined && step.repeat !== 1 ? ` x ${step.repeat}` : ''}`;
}

/** What is wrong with one setup step (empty = nothing). */
export function stepProblems(step: BaselineStep): string[] {
  const out: string[] = [];
  const keys = Object.keys(step);
  if ('waitIdle' in step) {
    if (step.waitIdle !== true || keys.length !== 1) out.push('a waitIdle step is { "waitIdle": true } and nothing else');
  } else if ('waitFrames' in step) {
    if (!Number.isInteger(step.waitFrames) || step.waitFrames < 1 || step.waitFrames > 600 || keys.length !== 1) out.push('a waitFrames step is { "waitFrames": <1..600> } and nothing else');
  } else if (isCall(step)) {
    if (typeof step.call !== 'string' || !STEP_PATH.test(step.call)) out.push(`"${String(step.call)}" is not a function path of a test handle (${STEP_ROOTS.join(', ')})`);
    if (step.args !== undefined && !Array.isArray(step.args)) out.push('args must be an array');
    if (step.repeat !== undefined && (!Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > STEP_REPEAT_MAX)) out.push(`repeat must be a whole number from 1 to ${STEP_REPEAT_MAX}`);
    for (const k of keys) if (k !== 'call' && k !== 'args' && k !== 'repeat') out.push(`unknown field "${k}"`);
  } else out.push('a step is a call, a waitIdle or a waitFrames');
  return out;
}

const hasParam = (page: string, name: string, value: string): boolean => new URLSearchParams(page.includes('?') ? page.slice(page.indexOf('?') + 1) : '').get(name) === value;
const callsWith = (setup: BaselineStep[], call: string, arg: unknown): boolean => setup.some((s) => isCall(s) && s.call === call && JSON.stringify(s.args ?? []) === JSON.stringify([arg]));

/**
 * What is wrong with a manifest (empty = nothing): every checkpoint is framed and can be captured frame-exactly.
 *  - a page (none is left unframed), a description, frames from 16;
 *  - a LAB page freezes its presentation from the first frame by its query (`deterministic=1&paused=1`); a
 *    page of the APP has no such query and says so in its setup (`__test.setDeterministic(true)` and
 *    `__test.setPaused(true)`);
 *  - a setup that stops the lab's loop or its pause starts them again (the capture needs the loop, and a
 *    running simulation is not a held frame);
 *  - a recorded checkpoint has its file, hash, size, tolerance (at least the floor and three times the loads'
 *    largest difference), three or more loads and the lead's note.
 */
export function manifestProblems(m: BaselineManifest): string[] {
  const out: string[] = [];
  if (m.version !== 1) out.push(`unknown manifest version ${String(m.version)}`);
  if (!(m.floor.meanAbs > 0 && m.floor.p999 > 0)) out.push('the floor must be positive');
  if (!(m.viewport[0] > 0 && m.viewport[1] > 0)) out.push('the viewport must be positive');
  for (const [name, c] of Object.entries(m.checkpoints)) {
    const bad = (what: string): void => {
      out.push(`${name}: ${what}`);
    };
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) bad('a checkpoint name is lower-case words joined by hyphens (it is the file name)');
    if (typeof c.what !== 'string' || c.what.length <= 10) bad('"what" must say what the checkpoint shows');
    if (!Number.isInteger(c.frames) || c.frames < 16) bad('"frames" must be a whole number from 16');
    if (c.status !== 'pending' && c.status !== 'recorded') bad(`unknown status "${String(c.status)}"`);
    const setup = c.setup ?? [];
    if (!Array.isArray(setup)) bad('"setup" must be a list of steps');
    else setup.forEach((s, i) => stepProblems(s).forEach((p) => bad(`setup[${i}]: ${p}`)));
    if (c.page === null) bad('not framed: it has no page');
    else if (typeof c.page !== 'string' || !c.page.startsWith('/')) bad('"page" must be a path from the site root');
    else if (c.page.startsWith('/labs/')) {
      if (!hasParam(c.page, 'deterministic', '1') || !hasParam(c.page, 'paused', '1')) bad('a lab page is opened frozen: deterministic=1&paused=1 in its query');
    } else if (Array.isArray(setup)) {
      if (!callsWith(setup, '__test.setDeterministic', true) || !callsWith(setup, '__test.setPaused', true)) bad('a page of the app is frozen by its setup: __test.setDeterministic(true) and __test.setPaused(true)');
    }
    if (Array.isArray(setup)) {
      // What the setup leaves behind: the last call of each switch decides.
      const last = (call: string): unknown => [...setup].reverse().find((s): s is { call: string; args?: unknown[] } => isCall(s) && s.call === call)?.args?.[0];
      if (last('__lab.setLoop') === false) bad('the setup stops the lab\'s frame loop and does not start it again');
      if (last('__lab.setPaused') === false || last('__test.setPaused') === false) bad('the setup leaves the simulation running: a reference is a held frame of a paused page');
    }
    if (c.status === 'recorded') {
      if (!c.file || !/^[0-9a-f]{64}$/.test(c.sha256 ?? '') || !c.width || !c.height) bad('recorded, but its file, sha256 or size is missing');
      if (!c.tolerance || !c.selfDifference || !(c.loads !== undefined && c.loads >= 3)) bad('recorded, but its tolerance, the loads\' difference or the number of loads (three or more) is missing');
      else {
        if (c.tolerance.meanAbs < m.floor.meanAbs || c.tolerance.p999 < m.floor.p999) bad('its tolerance is under the floor');
        if (c.tolerance.meanAbs < 3 * c.selfDifference.meanAbs || c.tolerance.p999 < 3 * c.selfDifference.p999) bad('its tolerance is under three times the largest difference between its loads');
      }
      if (!c.recorded || c.recorded.note.trim().length < 8) bad('recorded without the lead\'s note');
    }
  }
  return out;
}
