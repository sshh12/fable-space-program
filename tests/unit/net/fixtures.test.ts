/**
 * The fixtures recorded from the real session decode and encode back byte for byte (Node; the same check runs
 * in Chrome from tests/browser/net).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFixture, FIXTURE_FILES } from './cases/fixtureCases';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('fixtures recorded from the real session', () => {
  for (const file of FIXTURE_FILES) {
    it(`${file}: every frame re-encodes identically, every message round-trips`, () => {
      const n = checkFixture(file, new Uint8Array(readFileSync(path.join(dir, file))));
      expect(n).toBeGreaterThan(100);
    });
  }
});
