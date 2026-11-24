/**
 * The recorded files that later packages are judged against, pinned by content (MIGRATION_V2 principle 4:
 * a recording is made once). A package that changes the simulation proves itself against these files; a
 * file that changed with the package proves nothing. ONLY THE LEAD RE-RECORDS: a deliberate change of the
 * flight (a lead decision) re-records the file and replaces its hash here, in one commit that says why.
 *
 *   tests/mission/trajectory-guard.json            the mission's attended craft, its first debris and the clamps
 *   tests/unit/sim-vessel/trajectory-fixtures/*    the six flights of the per-vessel step
 *   tests/mission/reference-v1-aligned.json        the ascent of the v1 clock from the tick-aligned start
 *   tests/mission/controls-v1.json                 four flights of the unmodified v1 code with shifted starts
 *   tests/mission/baseline-v1.json                 the mission record of the v1 code: the reference of the ENVELOPE
 *   tests/unit/sim-vessel/corpus/*.bin             vessel blobs as earlier builds wrote them (only ever added)
 *   src/sim/vessel/migrations/legacyV3.ts          the fingerprints and vehicle hashes of codec versions 1 to 3
 *                                                  against today's kind, recorded at the version 4 step
 *
 * Not pinned, on purpose: tests/mission/golden.json (re-baselined behind a guard at the steps MIGRATION_V2
 * principle 5 names) and the terrain guard's two files (the lead re-records them when pads are added; they
 * are in the lead's path and their own test compares them with the tiles).
 *
 * Text files are hashed with LF line endings (what the repository stores), blobs as their bytes. A blob in
 * the corpus that has no pin fails as well: adding one is adding a pin.
 *
 * Last recorded: the trajectory guard with the tick-pure rule (lead decision D1 of the sim-core-v2 review);
 * the corpus gained its version 3 blobs in the same change. The six fixtures, the reference and the
 * controls are as first recorded. The mission baseline was pinned by the lead at the review of this file
 * (2026-11-12), as recorded in 431930f. The tighten step after sub-wave 3.2 (2026-11-24, codec version 4)
 * ADDED the six version 4 blobs of the corpus and the table of the version 3 hashes; no pin was replaced.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** SHA-256 of every pinned file, by its path from the repository root. */
export const GUARD_PINS: Readonly<Record<string, string>> = {
  'tests/mission/trajectory-guard.json': 'e9ac71ad733dbc0f1352b741c3124fcf8545ed4f1dc82d4cf9247a63ad751274',
  'tests/mission/reference-v1-aligned.json': 'b6a5e00d809f679d7018eec875bfcb5f60dff7be2057847acdb7dad770a5e640',
  'tests/mission/controls-v1.json': '7582dcb1408e410a1e11b297a10aeef5effda965f27eb5ad9cc69885107ce49f',
  'tests/mission/baseline-v1.json': '4e77752a47a08e743e39e6592c13d2ee671a3968ae4f69156461ce383b342932',
  'tests/unit/sim-vessel/corpus/capsule-peak-heating.v4.bin': 'c007e7b9b7e041fb9ec2b66e6255d0cf759daa7fe1820939982b51f93a74d59e',
  'tests/unit/sim-vessel/corpus/coasting.v4.bin': '30a7dcb7ee78d786f659c8e842a4c1ce4e71ccd01bbce78617d161f66c182347',
  'tests/unit/sim-vessel/corpus/lander-touchdown-150.v4.bin': 'ea2f4df008be1765d53ac55023aeb1ff4ec3d15e4415872a2f859795e367d725',
  'tests/unit/sim-vessel/corpus/lander-touchdown-60.v4.bin': '35f7f523ffe3ed55a6885d3676790e8ac7107bd5c760acbe096a2edb0b4db611',
  'tests/unit/sim-vessel/corpus/stack-ascent.v4.bin': '68f0c5d3214d1da0ac1eec67a37c2a401f2fbcd3d9eb9ea57a0154c2dc7e901e',
  'tests/unit/sim-vessel/corpus/stack-mid-staging.v4.bin': '29d4af766c4cb8dd8a8c91936e5645ffc2fbecabc1fb4a6eb3984a34abab5443',
  'src/sim/vessel/migrations/legacyV3.ts': '365453d0cac7f3745574299e1b5b4ac76e58681b846e7636e121f83fb11d4e6e',
  'tests/unit/sim-vessel/trajectory-fixtures/ascent.json': 'e2139f9227cf88f0abc949867155d604277511f77844eb9c86fa481abf292f25',
  'tests/unit/sim-vessel/trajectory-fixtures/entry.json': 'cd8934642aa3f2d4d2115e9b129f84e820f6615f27625c5b40a8ecbcb5152634',
  'tests/unit/sim-vessel/trajectory-fixtures/lunar-ascent.json': '35763b3cbb4b7afa6d95916020a750a9f9b677f442cec9114fc8b58e2ff7f4d9',
  'tests/unit/sim-vessel/trajectory-fixtures/splashdown.json': '53dc737898fa53cab6cc2345c94daa815502c4d8ee181ddd6cb3576192230698',
  'tests/unit/sim-vessel/trajectory-fixtures/staging.json': '017bf6db06ea208bc8e3c7a130e5c0559da6d711f369a6bec9ea8133ccee313b',
  'tests/unit/sim-vessel/trajectory-fixtures/touchdown.json': '81540f73c79fc235a4b7e5d7301ed5ced2b20622d959a6831779d8de5ca0957f',
  'tests/unit/sim-vessel/corpus/capsule-peak-heating.v1.bin': '83022f8d7a4f1749464f78624f9cd54f15e850856178c3ce24501f9784755f48',
  'tests/unit/sim-vessel/corpus/capsule-peak-heating.v2.bin': 'd2932388115ecd37866e69415b1339081076502ac8aacaba85a3c2749767f304',
  'tests/unit/sim-vessel/corpus/capsule-peak-heating.v3.bin': '8b44766015837961dee92c263d47b8fb4047fef728644c09d0efcc737d47cf37',
  'tests/unit/sim-vessel/corpus/coasting.v1.bin': 'f5cd908fbd11b6bb66b87fa4a126d07608bed64eb1d39421039d7c2991fdaed1',
  'tests/unit/sim-vessel/corpus/coasting.v2.bin': 'b72bf0ea277816757fe5a1b812e49bc2557166274a49851f72fe7d0bc4c99cd2',
  'tests/unit/sim-vessel/corpus/coasting.v3.bin': 'f6a39631f8524112a6257084bfdcb3e4072bed79b743543be21b68baf49d255c',
  'tests/unit/sim-vessel/corpus/lander-touchdown-150.v1.bin': 'bb480375761aa6318bcef526d46afb7aecb2dcd7e802cfbb2acff06ad8f3684f',
  'tests/unit/sim-vessel/corpus/lander-touchdown-150.v2.bin': 'beb214252098c33fe88e13c6ff785f1068899e3ba8f755e50e503a0544718868',
  'tests/unit/sim-vessel/corpus/lander-touchdown-150.v3.bin': 'b9beb0d13210714e6fa01820c38e743671c86cf6e874462f346747c0a5fb6d6f',
  'tests/unit/sim-vessel/corpus/lander-touchdown-60.v1.bin': 'b28b90586dd0bc941b5d6e80834e1e3a65954e0609e2b0c6de18c899624b1d44',
  'tests/unit/sim-vessel/corpus/lander-touchdown-60.v2.bin': 'dc3d961c109ab851dcfb0fe9048e030c7dd333c68ecb241cd549d15f6da295a9',
  'tests/unit/sim-vessel/corpus/lander-touchdown-60.v3.bin': 'd7a3ac91ccce4f9d709a454c70b8756c9af7275ed83c499479dc072593f5baee',
  'tests/unit/sim-vessel/corpus/stack-ascent.v1.bin': 'd81a6ccea070dccba3c55f378d99d79ea7a843dc4629c923c75668cf8698c4db',
  'tests/unit/sim-vessel/corpus/stack-ascent.v2.bin': 'fa94aa922cc168e05ff3a830c81ae332782ffa79cd2487aa814c90f1c007fa89',
  'tests/unit/sim-vessel/corpus/stack-ascent.v3.bin': '3570f2da0668d184f7253ba8439822a3269fa00932d3c669313194feb953b604',
  'tests/unit/sim-vessel/corpus/stack-mid-staging.v1.bin': 'edf5e8457535044ea3238d503f8c0840544983b2d819259ab90ec630e5733376',
  'tests/unit/sim-vessel/corpus/stack-mid-staging.v2.bin': 'b9b866428997defc648362959e50bc78dccd48b74fa7034327f06aaf53e0aa56',
  'tests/unit/sim-vessel/corpus/stack-mid-staging.v3.bin': 'e8a774a961d4bf587650bbe298d5252bf941982efb9708ceab8cec08ddf6a4e7',
  // fleet-data: one blob of every vehicle of the fleet (tests/unit/sim-vessel/corpus/fleetScenes.ts), added.
  'tests/unit/sim-vessel/corpus/fleet-orbit-kestrel-lf.v4.bin': '5a67925efb1d81c11b8f2bc486b9bacb56e1ffc892807789a26fecaaabf95b68',
  'tests/unit/sim-vessel/corpus/fleet-orbit-pelican.v4.bin': '3cce8226dfef90f650d5e3c3d631aca42f59feb8d0471f4f34604c31ca5ef053',
  'tests/unit/sim-vessel/corpus/fleet-pad-azimuth-pathfinder.v4.bin': '14ea395db3007b4d8d406ea304db64a7af2e199ee5f0df646b9d7ed84111ce36',
  'tests/unit/sim-vessel/corpus/fleet-pad-meridian-albatross.v4.bin': 'c90b8e8678a723d634a9b075bc4c2e5cfd8d10e6a5619a6378e05bfeadf77dd9',
  'tests/unit/sim-vessel/corpus/fleet-pad-meridian-egret.v4.bin': '9f392f3bc7b9593a49eb4ea1dc23ed6010190777406dac4df37b65dd89fed079',
  'tests/unit/sim-vessel/corpus/fleet-pad-meridian-pelican-heavy.v4.bin': 'dd039ad5ad95c2c2d6e3955d5599850b4178d490391cc1ba1b76efaf70ccaa23',
  'tests/unit/sim-vessel/corpus/fleet-pad-solstice-atoll.v4.bin': '9ba56a9bf8f66df92094e7e8dbd4a47210ebb4055a1551d9c7e229c333556970',
  'tests/unit/sim-vessel/corpus/fleet-pad-solstice-kestrel.v4.bin': 'a6f7ad8d9fd83f3ce9cc9d184d38091b7f9116b7a9d3c453cf65b91f209c7586',
  'tests/unit/sim-vessel/corpus/fleet-pad-solstice-pelican.v4.bin': 'edf274763eaaaf287d857fdbde217adbf51e52e31ae3be0a5b87006ba73108a8',
};

const WHO =
  'only the lead re-records a pinned file (tools/dev/guard-pins.test.ts): if the flight was meant to change, ask for the decision; if it was not, the change is the defect';

/** The pin of a file as it is on disk: SHA-256 of its bytes, a text file with LF line endings. */
export function pinOf(file: string): string {
  const bytes = fs.readFileSync(path.join(repoRoot, file));
  const content = file.endsWith('.bin') ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

describe('recorded files are what was recorded', () => {
  it('every pinned file is there and has its recorded content', () => {
    const problems: string[] = [];
    for (const [file, pin] of Object.entries(GUARD_PINS)) {
      if (!fs.existsSync(path.join(repoRoot, file))) problems.push(`${file}: missing`);
      else if (pinOf(file) !== pin) problems.push(`${file}: its content is not the recorded one`);
    }
    expect(problems, WHO).toEqual([]);
  });

  it('the guard, the six fixtures, the reference, the controls and every blob of the corpus are pinned', () => {
    const pinned = Object.keys(GUARD_PINS);
    for (const file of ['tests/mission/trajectory-guard.json', 'tests/mission/reference-v1-aligned.json', 'tests/mission/controls-v1.json', 'tests/mission/baseline-v1.json']) expect(pinned).toContain(file);
    const fixtures = fs.readdirSync(path.join(repoRoot, 'tests/unit/sim-vessel/trajectory-fixtures')).filter((f) => f.endsWith('.json'));
    expect(fixtures).toHaveLength(6);
    for (const f of fixtures) expect(pinned, WHO).toContain(`tests/unit/sim-vessel/trajectory-fixtures/${f}`);
    const blobs = fs.readdirSync(path.join(repoRoot, 'tests/unit/sim-vessel/corpus')).filter((f) => f.endsWith('.bin'));
    expect(blobs.length).toBeGreaterThanOrEqual(24);
    expect(pinned, WHO).toContain('src/sim/vessel/migrations/legacyV3.ts');
    for (const f of blobs) expect(pinned, `a blob without a pin: ${WHO}`).toContain(`tests/unit/sim-vessel/corpus/${f}`);
  });

  it('a pin is of the content with LF line endings: the same on every checkout', () => {
    const file = 'tests/mission/controls-v1.json';
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    expect(pinOf(file)).toBe(createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex'));
    expect(pinOf(file)).toBe(GUARD_PINS[file]);
    // A change of one character is another pin.
    expect(createHash('sha256').update(Buffer.from(`${text} `, 'utf8')).digest('hex')).not.toBe(GUARD_PINS[file]);
  });
});
