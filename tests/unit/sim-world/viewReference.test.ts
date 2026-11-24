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
    expect(firstDifference(reference.samples, got, NOT_COMPARED)).toBeNull();
  });

  it('a single changed block is found and named', () => {
    const bent = got.map((s) => ({ ...s, blocks: { ...s.blocks } }));
    bent[137]!.blocks.readouts = '0000000000000000';
    expect(firstDifference(reference.samples, bent)).toMatch(/sample 137 .*block "readouts" differs/);
  });
});
