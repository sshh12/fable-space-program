/**
 * data/defs/render/quality.json and the calibration's scenarios: the table parses, every shot names a
 * scenario that loads, the presets are what ARCHITECTURE 24 states, and a malformed table is refused with
 * the field it stumbled on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { parseQualityTable, presetProfile, seedPreset, type QualityTable } from '@/bench/table';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'quality.json'), 'utf8')) as Record<string, unknown>;
let defs: DefLibrary;
let table: QualityTable;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs')));
  table = parseQualityTable(raw);
}, 60_000);

describe('the quality table', () => {
  it('has the presets of ARCHITECTURE 24 (0.9, 1.6, 2.4, 3.7 MP) and a seed per adapter class', () => {
    expect([table.presets.low.pixelCap, table.presets.medium.pixelCap, table.presets.high.pixelCap, table.presets.ultra.pixelCap]).toEqual([0.9, 1.6, 2.4, 3.7]);
    expect(seedPreset(table, 'integrated', false)).toBe('low');
    expect(seedPreset(table, 'discrete', true)).toBe(table.safePreset);
    expect(presetProfile(table, 'medium', ['clouds', 'shadows'])).toEqual({ pixelCap: 1.6, renderScaleMin: 0.5, targetFps: 60, levels: { clouds: 'medium', shadows: 'medium' } });
  });
  it('names, for every shot, a calibration scenario that loads, on the vehicle with visuals', () => {
    for (const shot of table.shots) {
      const s = defs.scenarios[shot.scenario];
      expect(s, shot.scenario).toBeDefined();
      expect(s!.milestones).toEqual([]);
      expect(defs.vehicles[s!.vehicle]).toBeDefined();
    }
    expect(table.shots.map((s) => s.id)).toEqual(['pad-dawn', 'liftoff', 'leo-terminator', 'cockpit']);
  });
  it('refuses a malformed table with the field', () => {
    const broken = (patch: Record<string, unknown>): unknown => ({ ...raw, ...patch });
    expect(() => parseQualityTable(broken({ classHint: { discrete: 'epic', unknown: 'low', integrated: 'low' } }))).toThrow(/classHint.discrete/);
    expect(() => parseQualityTable(broken({ confirm: { shot: 'nowhere', measureS: 3 } }))).toThrow(/confirm.shot/);
    expect(() => parseQualityTable(broken({ solver: { ...(raw['solver'] as object), pixelCaps: [2, 1] } }))).toThrow(/must ascend/);
    expect(() => parseQualityTable(broken({ attribution: { rules: { x: '(' }, ignore: 'a', fixedExponent: 1 } }))).toThrow(/attribution.rules.x/);
  });
});
