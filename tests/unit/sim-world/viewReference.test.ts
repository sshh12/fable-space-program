/**
 * The session's snapshots against the wave-3 World's at 200 recorded states (viewReference.ts): every
 * block of every state, numbers by their bits. The blocks of the snapshot are built by src/sim/view since
 * island-core; this is the proof that the move changed nothing a consumer reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { loadLibrary } from './helpers';
import { driveAll, firstDifference, VIEW_BLOCKS, type ViewBlock, type ViewReference, type ViewSample } from './viewReference';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewReference.json');
const reference = JSON.parse(fs.readFileSync(file, 'utf8')) as ViewReference;

/**
 * Blocks that are not compared, with the reason. Empty while the session is the wave-3 World with its
 * algorithms moved; island-core states here what changes by design when the 25 km bubble becomes island
 * formation (debris in another tier: `otherVessels`).
 */
const NOT_COMPARED: readonly ViewBlock[] = [];

/**
 * Blocks of single states that differ from the wave-3 World BY DESIGN, each with the value it has now and the
 * reason. The recording itself is never changed; the comparison is made against the recording with these
 * entries put in, so that every other block of every state is still the wave-3 World's to the bit.
 */
const THREE_PERIODS = 'the three-period encounter search (ARCHITECTURE 8.4; request solar-system-sim-1, item 1): the coast of qa-translunar shows an encounter on a later revolution. Only the patches block; the flight is the same.';
const NINE_RAILS_LEVELS = 'the warp table of nine rails levels (decision 40; MIGRATION_V2 step 4.1c, request solar-system-sim-2): a vessel held on a surface with no node ahead may take the top of the table, which is index 12 at 10,000,000x and was index 10 at 100,000x. Only warp.maxIndex and time.maxRate of the clock block; the clock, the level in use and the flight are the same.';
const BY_DESIGN: readonly { sample: number; scenario: string; block: ViewBlock; was: string; is: string; why: string }[] = [
  ...(
    [
      [46, 'a20153175071318a', 'c9e92980aa83f4c8'],
      [47, 'f62a753b051ee618', '68d23a78ccc573ed'],
      [48, 'f62a753b051ee618', '68d23a78ccc573ed'],
      [49, 'f62a753b051ee618', '68d23a78ccc573ed'],
      [50, 'f62a753b051ee618', '68d23a78ccc573ed'],
      [51, '15556c1bc42351f1', '41d6f928f2a073f1'],
      [52, 'e24f13767ca9308d', 'da48866581ca388f'],
      [53, 'e24f13767ca9308d', 'da48866581ca388f'],
      [54, 'e24f13767ca9308d', 'da48866581ca388f'],
      [55, 'e24f13767ca9308d', 'da48866581ca388f'],
      [66, '76f27be0f2c97996', 'cf899bd248f122e8'],
      [67, '76f27be0f2c97996', 'cf899bd248f122e8'],
    ] as const
  ).map(([sample, was, is]) => ({ sample, scenario: 'qa-translunar', block: 'patches' as const, was, is, why: THREE_PERIODS })),
  ...(
    [
      [0, 'lunar-direct', 'e01e30e0120f00cc', '0fd028b63c7d69f8'],
      [1, 'lunar-direct', '19867d783a5dcd32', '35c764f0a150d6f7'],
      [2, 'lunar-direct', '607e19d67a2e0ddb', '6f58dcac59d65885'],
      [3, 'lunar-direct', 'bed37541e0b0bce1', '60d4210ad2dd35e5'],
      [4, 'lunar-direct', '589288700fb0cfbd', '943cc60c2ea44081'],
      [112, 'qa-lunar-surface', 'e621f4e5569c56d2', '1bbaf3a7eda03aea'],
    ] as const
  ).map(([sample, scenario, was, is]) => ({ sample, scenario, block: 'clock' as const, was, is, why: NINE_RAILS_LEVELS })),
];

/** The recording with the designed differences put in. */
function expected(): ViewSample[] {
  const out = reference.samples.map((s) => ({ ...s, blocks: { ...s.blocks } }));
  for (const d of BY_DESIGN) {
    expect(out[d.sample]!.blocks[d.block], `sample ${d.sample}, ${d.block}: the recording`).toBe(d.was);
    out[d.sample]!.blocks[d.block] = d.is;
  }
  return out;
}

describe('snapshot reference of the wave-3 World', () => {
  let defs: DefLibrary;
  let got: ViewSample[];
  beforeAll(async () => {
    defs = await loadLibrary();
    got = await driveAll(defs);
  }, 240_000);

  it('the recording holds 200 states, presentation snapshots and several vessels among them', () => {
    expect(reference.samples.length).toBe(200);
    expect(reference.samples.filter((s) => s.kind === 'snapshot').length).toBeGreaterThan(50);
    expect(reference.samples.filter((s) => s.vessels > 1).length).toBeGreaterThan(50);
    for (const s of reference.samples) expect(Object.keys(s.blocks).sort()).toEqual([...VIEW_BLOCKS].sort());
  });

  it('every block of every state equals the recording', () => {
    expect(firstDifference(expected(), got, NOT_COMPARED)).toBeNull();
    // What differs by design does differ from the recording: the patches block of twelve states of one scenario, the
    // clock block of the six states in which a held vessel may take the top of the warp table, and nothing else.
    for (const d of BY_DESIGN) expect(reference.samples[d.sample]!.scenario, d.why).toBe(d.scenario);
    expect(BY_DESIGN.map((d) => got[d.sample]!.blocks[d.block] !== reference.samples[d.sample]!.blocks[d.block])).toEqual(BY_DESIGN.map(() => true));
  });

  it('a single changed block is found and named', () => {
    const bent = got.map((s) => ({ ...s, blocks: { ...s.blocks } }));
    bent[137]!.blocks.readouts = '0000000000000000';
    expect(firstDifference(expected(), bent)).toMatch(/sample 137 .*block "readouts" differs/);
  });
});
