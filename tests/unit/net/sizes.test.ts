/**
 * Sizes with framing, per message (the brief's acceptance; ARCHITECTURE 13.3, 13.4, 14):
 *   single-owner key <= 110 B per vessel; shared delta <= 130 B for two vessels and <= 300 B for ten;
 *   a staging IslandOp < 100 B; a census entry <= 90 B.
 * "With framing" = the whole frame a socket carries (count, code, length, payload). Deltas are measured at
 * every send tick of the key interval (10 Hz single-owner, 30 Hz shared) and the largest is reported. The
 * census entry is measured as the relevant set carries it, with its strings as handles (the mapping is sent
 * once per session, ARCHITECTURE 13.1); the per-entry size of a public census document, strings included,
 * is reported beside it.
 */
import { describe, expect, it } from 'vitest';
import type { WireMessage } from '@/core/contracts/net';
import { assembleFrame, encodeDocument, encodeFrame, encodeMessage } from '@/net/codec/framing';
import { HandleTableOut } from '@/net/codec/handles';
import { advance, coastingEntry, deltaOf, keyOf, scenePoses, stagingOp } from '@/net/testing/scenes';

const report: string[] = [];
const line = (name: string, bytes: number, limit: string) => report.push(`${name.padEnd(64)} ${String(bytes).padStart(6)} B   ${limit}`);

function frameBytes(...msgs: WireMessage[]): number {
  return encodeFrame(msgs).length;
}

/** Largest delta frame over the send ticks of one key interval (120 ticks). */
function worstDelta(n: number, motion: 'docking' | 'ascent', everyTicks: number, controlsChanged: number[]): number {
  let worst = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const poses = scenePoses(n, seed, motion === 'docking' ? 1000 : 2000, motion);
    const key = keyOf(7, 1_000_000, poses, motion);
    for (let dt = everyTicks; dt < 120; dt += everyTicks) {
      const now = advance(poses, dt, seed * 1000 + dt, motion);
      worst = Math.max(worst, frameBytes(deltaOf(key, key.tick + dt, now, controlsChanged)));
    }
  }
  return worst;
}

describe('message sizes with framing', () => {
  it('a single-owner key is at most 110 B per vessel', () => {
    const key = keyOf(7, 1_000_000, scenePoses(1, 3, 4000, 'ascent'), 'ascent');
    const bytes = frameBytes(key);
    line('islandKey, single-owner (1 vessel)', bytes, '<= 110');
    const withAck = frameBytes(key, { type: 'inputAck', marginMs: 41.5, stamped: [{ from: 1200, to: 1230 }], late: [] });
    line('islandKey + the pilot inputAck in one frame', withAck, '(reported)');
    const four = frameBytes(keyOf(7, 1_000_000, scenePoses(4, 3, 4000, 'docking'), 'docking'));
    line('islandKey, 4 vessels (per vessel)', Math.ceil(four / 4), '<= 110');
    expect(bytes).toBeLessThanOrEqual(110);
    expect(four / 4).toBeLessThanOrEqual(110);
  });

  it('a shared delta is at most 130 B for two vessels and 300 B for ten', () => {
    const two = worstDelta(2, 'docking', 4, [1]);
    const ten = worstDelta(10, 'docking', 4, [2, 7]);
    line('islandDelta, shared, 2 vessels, docking approach (worst of 30 Hz)', two, '<= 130');
    line('islandDelta, shared, 10 vessels, docking approach (worst of 30 Hz)', ten, '<= 300');
    line('islandDelta, single-owner ascent, 1 vessel (worst of 10 Hz)', worstDelta(1, 'ascent', 12, []), '(reported)');
    line('islandDelta, 2 vessels both under 3 g of thrust (worst of 30 Hz)', worstDelta(2, 'ascent', 4, []), '(reported)');
    expect(two).toBeLessThanOrEqual(130);
    expect(ten).toBeLessThanOrEqual(300);
  });

  it('a staging IslandOp is under 100 B', () => {
    const bytes = frameBytes(stagingOp(7, 1_000_123));
    line('islandOp split (staging, the server id of the spent stage)', bytes, '< 100');
    expect(bytes).toBeLessThan(100);
  });

  it('a census entry is at most 90 B', () => {
    const base = 112_582_906_000;
    const entries = Array.from({ length: 100 }, (_, i) => coastingEntry(i, base));
    const table = new HandleTableOut();
    const rec = encodeMessage({ type: 'relevantFull', seq: 1, tick: base, entries }, table);
    const empty = encodeMessage({ type: 'relevantFull', seq: 1, tick: base, entries: [] }, new HandleTableOut());
    // The frame table of the 100 entries (one body) counts once, like the header.
    const perEntry = (rec.length - empty.length - 10) / 100;
    line('census entry in the relevant set (coasting ship, one patch)', Math.ceil(perEntry), '<= 90');
    const one = table;
    const single = encodeMessage({ type: 'relevantDelta', seq: 2, baseSeq: 1, tick: base, changed: [coastingEntry(3, base)], removed: [], elements: [] }, one);
    line('relevantDelta with one changed entry, framed (handles known)', assembleFrame([single]).length, '(reported)');
    const handles = table.takePending()!;
    line('  ...the handles message of those 100 entries (sent once)', encodeMessage(handles).length, '(reported)');
    const doc = encodeDocument({ type: 'censusSnapshot', soi: 'earth', seq: 1, wallMs: 1.9e12, tick: base, pollAfterS: 4, entries });
    line('public census document, per entry, strings included', Math.ceil(doc.length / 100), '(reported)');
    expect(perEntry).toBeLessThanOrEqual(90);
  });

  it('prints the size report', () => {
    console.log(`\nwire sizes (with framing)\n${report.join('\n')}\n`);
  });
});
