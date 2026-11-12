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
 *   tests/unit/sim-vessel/corpus/*.bin             vessel blobs as earlier builds wrote them (only ever added)
 *
 * Text files are hashed with LF line endings (what the repository stores), blobs as their bytes. A blob in
 * the corpus that has no pin fails as well: adding one is adding a pin.
 *
 * Last recorded: the trajectory guard with the tick-pure rule (lead decision D1 of the sim-core-v2 review);
 * the corpus gained its version 3 blobs in the same change. The six fixtures, the reference and the
 * controls are as first recorded.
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
    for (const file of ['tests/mission/trajectory-guard.json', 'tests/mission/reference-v1-aligned.json', 'tests/mission/controls-v1.json']) expect(pinned).toContain(file);
    const fixtures = fs.readdirSync(path.join(repoRoot, 'tests/unit/sim-vessel/trajectory-fixtures')).filter((f) => f.endsWith('.json'));
    expect(fixtures).toHaveLength(6);
    for (const f of fixtures) expect(pinned, WHO).toContain(`tests/unit/sim-vessel/trajectory-fixtures/${f}`);
    const blobs = fs.readdirSync(path.join(repoRoot, 'tests/unit/sim-vessel/corpus')).filter((f) => f.endsWith('.bin'));
    expect(blobs.length).toBeGreaterThanOrEqual(18);
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
