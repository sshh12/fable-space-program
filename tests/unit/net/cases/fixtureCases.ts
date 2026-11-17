/**
 * The recorded fixtures (tests/unit/net/fixtures, recorded from the real session) decode to messages that
 * encode back to the very same frames, handles and all, and every message of them round-trips to an equal
 * value. Shared by Node (bytes from the file system) and Chrome (bytes fetched from the page's server).
 */
import type { ServerMessage, WireMessage } from '@/core/contracts/net';
import { assembleFrame, decodeFrame, encodeMessage } from '@/net/codec/framing';
import { HandleTableIn, HandleTableOut } from '@/net/codec/handles';
import { decodeRecording } from '@/net/record/recorder';
import { diff, equal, ok } from './assert';

/** The fixture files, by scene. */
export const FIXTURE_FILES = ['leo-coast-rcs.fspw', 'ascent-staging.fspw', 'entry-chutes.fspw'];

/** Check one fixture; returns the number of messages checked. */
export function checkFixture(name: string, bytes: Uint8Array): number {
  const rec = decodeRecording(bytes);
  ok(rec.ok, `${name}: ${JSON.stringify(!rec.ok && rec.error)}`);
  const inTable = new HandleTableIn();
  const outTable = new HandleTableOut();
  let n = 0;
  for (const [i, f] of rec.frames.entries()) {
    const res = decodeFrame(f.bytes, { source: 'server', handles: inTable });
    ok(res.ok, `${name} frame ${i}: ${JSON.stringify(!res.ok && res.error)}`);
    const msgs = (res.messages as ServerMessage[]).filter((m) => m.type !== 'handles');
    const records = msgs.map((m) => encodeMessage(m, outTable));
    const handles = outTable.takePending();
    equal(assembleFrame(handles ? [encodeMessage(handles), ...records] : records), f.bytes, `${name} frame ${i} re-encodes differently`);
    for (const m of msgs) {
      const back = decodeFrame(assembleFrame([encodeMessage(m, outTable)]), { source: 'server', handles: inTable });
      ok(back.ok, `${name} frame ${i}: ${m.type} did not decode again`);
      const d = diff(back.messages[0] as WireMessage, m);
      ok(!d, `${name} frame ${i} ${m.type}: ${d}`);
      n++;
    }
  }
  return n;
}
