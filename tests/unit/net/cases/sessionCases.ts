/**
 * Session-layer cases shared by Node and Chrome: every transcript of tests/unit/net/transcripts drives the
 * client half against the server half over the loopback transport and over the injector at a 300 ms round
 * trip with 20 ms of jitter and 5 % stalls of 200 ms (three seeds), to the outcome the transcript states; the
 * loopback run reproduces the recorded frames byte for byte.
 */
import { roundTripProfile } from '@/net/injector/model';
import { parseTranscript, runTranscript, type Transcript } from '@/net/testing/transcripts';
// JSON modules with the import attribute: Vite, vitest and Node's own loader (the Playwright spec) all read it.
import handshake from '../transcripts/handshake-spawn-inputs.json' with { type: 'json' };
import malformed from '../transcripts/malformed-and-out-of-order.json' with { type: 'json' };
import outage from '../transcripts/outage-beyond-grace.json' with { type: 'json' };
import stall from '../transcripts/stall-and-declared-loss.json' with { type: 'json' };
import resumeInputs from '../transcripts/resume-inputs-in-flight.json' with { type: 'json' };
import resumeHandshake from '../transcripts/resume-mid-handshake.json' with { type: 'json' };
import resumeSubscription from '../transcripts/resume-mid-subscription.json' with { type: 'json' };
import takenOver from '../transcripts/taken-over.json' with { type: 'json' };
import versionMismatch from '../transcripts/version-mismatch.json' with { type: 'json' };
import { diff, ok, type NetCase } from './assert';

export const TRANSCRIPTS: Transcript[] = [handshake, resumeHandshake, resumeSubscription, resumeInputs, takenOver, malformed, versionMismatch, stall, outage].map(parseTranscript);

/** The latency profile of the acceptance line: 300 ms round trip with stalls. */
export const STALLY_300 = (seed: number) => roundTripProfile(300, { jitterMs: 20, stallChance: 0.05, stallMs: 200, seed });

export const sessionCases: NetCase[] = TRANSCRIPTS.flatMap((t): NetCase[] => [
  {
    name: `transcript ${t.name}: over the loopback, the stated outcome and the recorded frames`,
    run() {
      const r = runTranscript(t, { link: { kind: 'loopback' } });
      const d = diff(r.outcome, t.expect);
      ok(!d, `${t.name} (loopback): ${d}`);
      ok(t.recorded !== undefined, `${t.name}: no recorded frames (run tests/unit/net/transcripts/record.ts)`);
      const rd = diff(r.recorded, t.recorded);
      ok(!rd, `${t.name}: the loopback run differs from the recorded frames: ${rd}`);
    },
  },
  {
    name: `transcript ${t.name}: over the injector at 300 ms with stalls (3 seeds), the same outcome`,
    run() {
      for (const seed of [1, 2, 3]) {
        const r = runTranscript(t, { link: { kind: 'injector', profile: STALLY_300(seed) } });
        const d = diff(r.outcome, t.expect);
        ok(!d, `${t.name} (injector, seed ${seed}): ${d}`);
      }
    },
  },
]);
