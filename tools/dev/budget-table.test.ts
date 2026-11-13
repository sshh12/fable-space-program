/**
 * The browser-free part of the summed GPU budget table (tests/browser/integration/budgetTable.ts): the three
 * whole-frame views of request terrain-render-10, the named lead waivers (held equal to the terrain's and the
 * ocean's perf specs, which grant them), the judgement of a row, its printed lines, and the comparison with
 * the recorded baseline (the presentation sweep's gate: the summed GPU time unchanged within 3 %).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TOLERANCE,
  compareWithBaseline,
  describeBaselineComparison,
  FRAME_BUDGET_MS,
  FRAME_VIEWS,
  judgeRow,
  NAMED_WAIVERS,
  oversAgainstBaseline,
  packageLines,
  PACKAGES,
  waiversOf,
  withBaselineRow,
  type BudgetBaseline,
  type BudgetRow,
} from '../../tests/browser/integration/budgetTable';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const ALL = [...PACKAGES];
const row = (over: Partial<BudgetRow> = {}): BudgetRow => ({
  checkpoint: 'LEO',
  kind: 'lines',
  loaded: ALL,
  measured: { core: 2.6, terrain: 1.2, vehicle: 0.7, cockpit: 0.0, atmosphere: 1.9, ocean: 0.08, sky: 0.25, vfx: 0.4 },
  budget: { core: 3.0, terrain: 1.9, vehicle: 0.9, cockpit: 0, atmosphere: 2.2, ocean: 0.1, sky: 0.3, vfx: 0.6, ui: 0.1 },
  frame: { sum: 7.15, typical: 5.1 },
  ...over,
});

describe('the whole-frame views of request terrain-render-10', () => {
  it('are the three ground views of the request, camera for camera', () => {
    expect(FRAME_VIEWS.map((v) => v.name)).toEqual(['stony ground', 'among kiawe', 'thickets from 120 m']);
    const q = FRAME_VIEWS.map((v) => new URLSearchParams(v.query));
    const camera = (p: URLSearchParams): number[] => ['lat', 'lon', 'alt', 'heading', 'pitch'].map((k) => Number(p.get(k)));
    const close = (a: number[], b: number[]): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
    close(camera(q[0]!), [18.981197, -155.609964, 18.27 + 1.7, 200, -8]);
    close(camera(q[1]!), [18.987556 + 0.0062, -155.603239 + 0.0005, 21.15 + 1.7, 70, -3]);
    close(camera(q[2]!), [18.987556 + 0.0035, -155.603239 - 0.001, 21.62 + 120, 15, -24]);
    for (const p of q) {
      expect([p.get('scene'), p.get('paused'), p.get('body'), p.get('fov'), p.get('sun'), p.get('sunsite')]).toEqual(['pad', '1', 'earth', '60', '105,31', 'earth,18.987556,-155.603239']);
    }
    // The same cameras as the terrain's own perf views, which is where the waivers are.
    const terrain = source('tests/browser/terrain/terrain.perf.spec.ts');
    expect(terrain).toMatch(/name: 'stony ground'.*lat: 18\.981197, lon: -155\.609964, agl: 1\.7, heading: 200, pitch: -8/);
    expect(terrain).toMatch(/name: 'kiawe'.*lat: PAD\.lat \+ 0\.0062, lon: PAD\.lon \+ 0\.0005, agl: 1\.7, heading: 70, pitch: -3/);
    expect(terrain).toMatch(/name: 'thickets 120 m'.*lat: PAD\.lat \+ 0\.0035, lon: PAD\.lon - 0\.001, agl: 120, heading: 15, pitch: -24/);
  });
});

describe('the named lead waivers', () => {
  it('are exactly the leadWaiver entries of the terrain\'s perf spec', () => {
    const text = source('tests/browser/terrain/terrain.perf.spec.ts');
    const until = /const MATERIAL_CACHE = '([^']+)'/.exec(text)![1]!;
    const rowOf: Record<string, string> = { 'stony ground': 'stony ground', kiawe: 'among kiawe', 'thickets 120 m': 'thickets from 120 m' };
    const stated: string[] = [];
    for (const m of text.matchAll(/\{ name: '([^']+)',[^\n]*budget: \{ gbuffer: ([\d.]+), shadow: ([\d.]+)[^\n]*leadWaiver: \{ until: MATERIAL_CACHE, ceiling: \{([^}]*)\} \}/g)) {
      const [, name, gbuffer, shadow, ceilings] = m;
      for (const c of ceilings!.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
        const [kind, value] = c.split(':').map((x) => x.trim());
        stated.push(`${rowOf[name!] ?? name}|${kind}|${kind === 'gbuffer' ? gbuffer : shadow}|${Number(value)}|${until}`);
      }
    }
    expect(stated).toHaveLength(4);
    const listed = NAMED_WAIVERS.filter((w) => w.pkg === 'terrain').map((w) => `${w.row}|${/G-buffer/.test(w.line) ? 'gbuffer' : 'shadow'}|${w.budget}|${w.ceiling}|${w.until}`);
    expect(listed.sort()).toEqual(stated.sort());
    // And no waiver of the terrain's spec is left out: every `leadWaiver:` of a view is one of the three.
    expect((text.match(/leadWaiver: \{ until/g) ?? []).length).toBe(3);
  });

  it('are exactly the leadWaiver entries of the ocean\'s perf spec', () => {
    const text = source('tests/browser/ocean/ocean.perf.spec.ts');
    const until = /const WAIVER_UNTIL = '([^']+)'/.exec(text)![1]!;
    const rowOf = (what: string): string => (what.startsWith('splashdown') ? 'splashdown' : 'pad lift-off');
    const stated = [...text.matchAll(/\{ what: '([^']+)',[^\n]*line: ([\d.]+),[^\n]*leadWaiver: \{ until: WAIVER_UNTIL, ceiling: ([\d.]+) \}/g)].map((m) => `${rowOf(m[1]!)}|${m[1]}|${Number(m[2])}|${Number(m[3])}|${until}`);
    expect(stated).toHaveLength(4);
    const listed = NAMED_WAIVERS.filter((w) => w.pkg === 'ocean').map((w) => `${w.row}|${w.line}|${w.budget}|${w.ceiling}|${w.until}`);
    expect(listed.sort()).toEqual(stated.sort());
    // The ocean's ceilings are held on the p50 there, the terrain's on the p99: the table states which.
    expect(NAMED_WAIVERS.filter((w) => w.pkg === 'ocean').every((w) => w.statistic === 'p50')).toBe(true);
    expect(NAMED_WAIVERS.filter((w) => w.pkg === 'terrain').every((w) => w.statistic === 'p99')).toBe(true);
    expect(NAMED_WAIVERS.every((w) => w.ceiling >= w.budget)).toBe(true);
  });

  it('bear on rows of the table: the three ground views, the splashdown and the pad', () => {
    expect([...new Set(NAMED_WAIVERS.map((w) => w.row))].sort()).toEqual(['among kiawe', 'pad lift-off', 'splashdown', 'stony ground', 'thickets from 120 m']);
    expect(waiversOf('among kiawe', 'terrain')).toHaveLength(2);
    expect(waiversOf('LEO', 'ocean')).toEqual([]);
    expect(waiversOf('splashdown', 'terrain')).toEqual([]);
  });
});

describe('the judgement of a row', () => {
  it('a checkpoint within every line and under 11 ms passes; a package over its line fails; the frame over 11 ms fails', () => {
    expect(judgeRow(row())).toEqual({ over: [], overOf: [], waived: [], unbudgeted: [] });
    expect(judgeRow(row({ measured: { ...row().measured, vehicle: 0.95 } })).over).toEqual(['vehicle (vehicle): 0.950 ms against 0.90 ms']);
    expect(judgeRow(row({ frame: { sum: 11.2, typical: 9 } })).over).toEqual([`frame: 11.20 ms against ${FRAME_BUDGET_MS} ms`]);
    // The frame is asserted only with every package loaded: a partial frame is not the game's frame.
    expect(judgeRow(row({ loaded: ['terrain', 'sky'], frame: { sum: 11.2, typical: 9 } })).over).toEqual([]);
    expect(judgeRow(row({ measured: { ...row().measured, probes: 0.2 } })).over).toEqual(['probes: 0.200 ms has no line in the table']);
  });

  it('a package without a line may cost up to 0.1 ms, reported; more is over', () => {
    expect(judgeRow(row({ measured: { ...row().measured, cockpit: 0.04 } }))).toEqual({ over: [], overOf: [], waived: [], unbudgeted: ['cockpit (cockpit) has no line at this checkpoint and costs 0.040 ms'] });
    expect(judgeRow(row({ measured: { ...row().measured, cockpit: 0.12 } })).over).toEqual(['cockpit (cockpit): 0.120 ms against 0.00 ms']);
  });

  it('a package over its line under a named lead waiver is reported with the waiver, not failed; the frame is asserted all the same', () => {
    const splash = row({ checkpoint: 'splashdown', measured: { ...row().measured, ocean: 0.97 }, budget: { ...row().budget, ocean: 0.9 } });
    const v = judgeRow(splash, (p) => `${p}-owner`);
    expect(v.over).toEqual([]);
    expect(v.waived).toHaveLength(1);
    expect(v.waived[0]).toMatch(/^ocean \(ocean-owner\): 0\.970 ms against 0\.90 ms; LEAD WAIVER until "near-patch pipeline and quality scaling": splashdown, near pass, line 0\.6 ms, ceiling 0\.73 ms p50 \(tests\/browser\/ocean\/ocean\.perf\.spec\.ts\); LEAD WAIVER .*splashdown, ocean, line 0\.9 ms, ceiling 0\.9 ms p50/);
    // The same excess at a row without a waiver for that package fails.
    expect(judgeRow(row({ checkpoint: 'reentry', measured: { ...row().measured, ocean: 0.97 }, budget: { ...row().budget, ocean: 0.9 } })).over).toHaveLength(1);
    // And a waiver never excuses the frame.
    expect(judgeRow({ ...splash, frame: { sum: 11.01, typical: 9 } }).over).toEqual([`frame: 11.01 ms against ${FRAME_BUDGET_MS} ms`]);
  });

  it('a whole-frame view is asserted on the frame total alone, with every package loaded; its waivers are reported', () => {
    const view = row({ checkpoint: 'thickets from 120 m', kind: 'frame', budget: {}, measured: { ...row().measured, terrain: 3.4 }, frame: { sum: 9.6, typical: 7.9 } });
    const v = judgeRow(view);
    expect(v.over).toEqual([]);
    expect(v.waived).toEqual(['terrain (terrain): 3.400 ms in this frame; LEAD WAIVER until "terrain material cache": thickets 120 m: G-buffer with the ground cover, line 1.5 ms, ceiling 3.45 ms p99 (tests/browser/terrain/terrain.perf.spec.ts)']);
    expect(judgeRow({ ...view, frame: { sum: 11.3, typical: 9.5 } }).over).toEqual([`frame: 11.30 ms against ${FRAME_BUDGET_MS} ms`]);
    expect(judgeRow({ ...view, loaded: ALL.filter((p) => p !== 'ocean') }).over).toEqual(['the whole-frame assertion needs every render package loaded; missing: ocean']);
  });
});

describe('the printed lines of a row', () => {
  it('one line per package: measured, budget, OVER where it is, the named waivers; then the frame', () => {
    const lines = packageLines(row({ checkpoint: 'pad lift-off', measured: { ...row().measured, ocean: 0.95 }, budget: { ...row().budget, ocean: 0.8 } }), (p) => `${p}-owner`);
    expect(lines[0]).toBe('core: 2.600 ms / budget 3.00 ms');
    expect(lines).toContain('terrain (terrain-owner): 1.200 ms / budget 1.90 ms');
    expect(lines.find((l) => l.startsWith('ocean'))).toMatch(/^ocean \(ocean-owner\): 0\.950 ms \/ budget 0\.80 ms OVER \[LEAD WAIVER until "near-patch pipeline and quality scaling": coast 60 m, near pass, line 0\.6 ms, ceiling 0\.94 ms p50 .*; LEAD WAIVER .*coast 60 m, ocean, line 0\.8 ms, ceiling 1\.03 ms p50 .*\]$/);
    expect(lines[lines.length - 1]).toBe('frame: sum of the p99s 7.15 ms / 11 ms; typical 5.10 ms');
    expect(lines).toHaveLength(1 + PACKAGES.length + 1);
    const frame = packageLines(row({ checkpoint: 'stony ground', kind: 'frame', budget: {}, frame: { sum: 11.4, typical: 9 } }));
    expect(frame.find((l) => l.startsWith('terrain'))).toMatch(/^terrain \(terrain\): 1\.200 ms \/ reported \[LEAD WAIVER until "terrain material cache": stony ground: G-buffer with the ground cover, line 1\.5 ms, ceiling 2\.9 ms p99/);
    expect(frame[frame.length - 1]).toBe('frame: sum of the p99s 11.40 ms / 11 ms OVER; typical 9.00 ms');
  });
});

describe('the recorded baseline and the sweep\'s gate', () => {
  const meta = { note: 'the lead, before sub-wave 3.2, quiet machine', method: 'p99 per package', at: '2026-11-12T20:00:00.000Z', commit: 'abc1234' };

  it('a recording needs the lead\'s note; a row measured again replaces its entry and keeps the others', () => {
    expect(() => withBaselineRow(null, row(), { ...meta, note: '' })).toThrow(/needs the lead's note/);
    const one = withBaselineRow(null, row(), meta);
    const two = withBaselineRow(one, row({ checkpoint: 'reentry', frame: { sum: 6.4, typical: 5 } }), meta);
    const again = withBaselineRow(two, row({ frame: { sum: 7.3, typical: 5.2 } }), { ...meta, at: '2026-11-12T21:00:00.000Z' });
    expect(Object.keys(again.rows)).toEqual(['LEO', 'reentry']);
    expect(again.rows['LEO']!.frame.sum).toBe(7.3);
    expect(again.rows['reentry']!.frame.sum).toBe(6.4);
    expect(again).toMatchObject({ version: 1, note: meta.note, method: meta.method });
    expect(JSON.parse(JSON.stringify(again))).toEqual(again);
  });

  it('the summed GPU time may rise by 3 % and no more; a faster frame is reported, not failed', () => {
    const baseline = withBaselineRow(null, row(), meta);
    expect(BASELINE_TOLERANCE).toBe(0.03);
    const same = compareWithBaseline(baseline, row())!;
    expect(same).toMatchObject({ row: 'LEO', baseline: 7.15, now: 7.15, change: 0, regressed: false, packages: [] });
    expect(compareWithBaseline(baseline, row({ frame: { sum: 7.15 * 1.029, typical: 5.1 } }))!.regressed).toBe(false);
    const slower = compareWithBaseline(baseline, row({ frame: { sum: 7.15 * 1.04, typical: 5.3 }, measured: { ...row().measured, vehicle: 0.99 } }))!;
    expect(slower.regressed).toBe(true);
    expect(slower.packages).toEqual(['vehicle 0.700 -> 0.990 ms']);
    expect(describeBaselineComparison(slower)).toBe('LEO: summed GPU time 7.44 ms against the recorded 7.15 ms (+4.0 %): ROSE by more than 3 %; packages that moved: vehicle 0.700 -> 0.990 ms');
    const faster = compareWithBaseline(baseline, row({ frame: { sum: 6.5, typical: 4.8 } }))!;
    expect(faster.regressed).toBe(false);
    expect(describeBaselineComparison(faster)).toMatch(/\(-9\.1 %\)$/);
    // A package that moved by less than 0.02 ms is noise, whatever the percentage.
    expect(compareWithBaseline(baseline, row({ measured: { ...row().measured, ocean: 0.095 } }))!.packages).toEqual([]);
  });

  it('rows are comparable only with the same packages loaded, and only when recorded', () => {
    const baseline = withBaselineRow(null, row(), meta);
    expect(compareWithBaseline(baseline, row({ checkpoint: 'splashdown' }))).toBeNull();
    expect(compareWithBaseline(baseline, row({ loaded: ALL.filter((p) => p !== 'vfx') }))).toBeNull();
  });
});

describe('the gate that asks "unchanged" (BUDGET_COMPARE)', () => {
  const meta = { note: 'the lead, before sub-wave 3.2, quiet machine', method: 'p99 per package', at: '2026-11-12T20:00:00.000Z', commit: 'abc1234' };
  // A recorded row in which the terrain is over its line and the cockpit costs 0.104 ms where it has none.
  const recordedRow = row({ checkpoint: 'pad lift-off', measured: { ...row().measured, terrain: 2.348, cockpit: 0.104 }, budget: { ...row().budget, terrain: 2.15 }, frame: { sum: 6.17, typical: 5.1 } });
  const baseline = withBaselineRow(null, recordedRow, meta);

  it('every failure names what it is about', () => {
    const v = judgeRow({ ...recordedRow, frame: { sum: 11.4, typical: 9 } });
    expect(v.over).toHaveLength(3);
    expect(v.overOf.sort()).toEqual(['cockpit', 'frame', 'terrain']);
    const view = judgeRow(row({ checkpoint: 'stony ground', kind: 'frame', budget: {}, loaded: ALL.filter((p) => p !== 'vfx') }));
    expect(view.overOf).toEqual(['loaded']);
  });

  it('a line that is over as it was recorded is reported, not failed; a line that went over, or rose, fails', () => {
    // The same numbers again: both overs are the baseline's.
    const same = oversAgainstBaseline(baseline, recordedRow, judgeRow(recordedRow));
    expect(same.fresh).toEqual([]);
    expect(same.asRecorded).toHaveLength(2);
    // Within the noise of a package (0.02 ms, or 3 %): still as recorded.
    const near = { ...recordedRow, measured: { ...recordedRow.measured, terrain: 2.41, cockpit: 0.12 } };
    expect(oversAgainstBaseline(baseline, near, judgeRow(near)).fresh).toEqual([]);
    // The terrain 5 % up: its line is this run's finding.
    const risen = { ...recordedRow, measured: { ...recordedRow.measured, terrain: 2.47 } };
    const split = oversAgainstBaseline(baseline, risen, judgeRow(risen));
    expect(split.fresh).toEqual(['terrain (terrain): 2.470 ms against 2.15 ms']);
    expect(split.asRecorded).toEqual(['cockpit (cockpit): 0.104 ms against 0.00 ms']);
    // A package that was within its line and is over it now, by more than the noise.
    const vehicle = { ...recordedRow, measured: { ...recordedRow.measured, vehicle: 0.95 } };
    expect(oversAgainstBaseline(baseline, vehicle, judgeRow(vehicle)).fresh).toEqual(['vehicle (vehicle): 0.950 ms against 0.90 ms']);
    // A package that sat just under the 0.1 ms of a place without a line and reads just over it: noise, not a finding.
    const under = withBaselineRow(null, row({ measured: { ...row().measured, cockpit: 0.097 } }), meta);
    const over = row({ measured: { ...row().measured, cockpit: 0.103 } });
    expect(judgeRow(over).over).toHaveLength(1);
    expect(oversAgainstBaseline(under, over, judgeRow(over))).toEqual({ fresh: [], asRecorded: ['cockpit (cockpit): 0.103 ms against 0.00 ms'] });
  });

  it('the frame over 11 ms is excused only if it was recorded so and has not risen; nothing is excused without a comparable row', () => {
    const heavy = withBaselineRow(null, row({ frame: { sum: 11.3, typical: 9.4 } }), meta);
    const again = row({ frame: { sum: 11.4, typical: 9.5 } });
    expect(oversAgainstBaseline(heavy, again, judgeRow(again))).toEqual({ fresh: [], asRecorded: ['frame: 11.40 ms against 11 ms'] });
    const worse = row({ frame: { sum: 11.8, typical: 9.9 } });
    expect(oversAgainstBaseline(heavy, worse, judgeRow(worse)).fresh).toEqual(['frame: 11.80 ms against 11 ms']);
    expect(oversAgainstBaseline(null, recordedRow, judgeRow(recordedRow)).fresh).toHaveLength(2);
    const other = { ...recordedRow, loaded: ALL.filter((p) => p !== 'vfx') };
    expect(oversAgainstBaseline(baseline, other, judgeRow(other)).asRecorded).toEqual([]);
    const missing = row({ checkpoint: 'stony ground', kind: 'frame', budget: {}, loaded: ALL.filter((p) => p !== 'vfx') });
    expect(oversAgainstBaseline(withBaselineRow(null, missing, meta), missing, judgeRow(missing)).fresh).toHaveLength(1);
  });
});

describe('the recorded baseline (tests/browser/budget.baseline.json)', () => {
  const file = path.join(repoRoot, 'tests', 'browser', 'budget.baseline.json');
  const recorded = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as BudgetBaseline) : null;

  it.skipIf(recorded === null)('holds the seven checkpoints and the three whole-frame views, every one with all packages and under 11 ms', () => {
    const b = recorded!;
    expect(b.version).toBe(1);
    expect(b.note.length).toBeGreaterThan(8);
    expect(Object.keys(b.rows)).toEqual(['pad lift-off', 'ascent 10-40 km', 'LEO', 'LEO cockpit', 'lunar descent', 'reentry', 'splashdown', ...FRAME_VIEWS.map((v) => v.name)]);
    for (const [name, r] of Object.entries(b.rows)) {
      expect([...r.loaded].sort(), name).toEqual([...PACKAGES].sort());
      expect(r.kind, name).toBe(FRAME_VIEWS.some((v) => v.name === name) ? 'frame' : 'lines');
      expect(r.frame.sum, name).toBeGreaterThan(1);
      expect(r.frame.sum, name).toBeLessThan(FRAME_BUDGET_MS);
      // The sum is the sum of what was measured.
      expect(Object.values(r.measured).reduce((s, x) => s + x, 0), name).toBeCloseTo(r.frame.sum, 1);
    }
  });

  it.skipIf(recorded === null)('compared with itself: unchanged, and every line that is over in it is over as recorded', () => {
    const b = recorded!;
    for (const [name, r] of Object.entries(b.rows)) {
      const asRow: BudgetRow = { checkpoint: name, kind: r.kind, loaded: r.loaded, measured: r.measured, budget: r.budget, frame: r.frame };
      expect(compareWithBaseline(b, asRow), name).toMatchObject({ change: 0, regressed: false, packages: [] });
      expect(oversAgainstBaseline(b, asRow, judgeRow(asRow)).fresh, name).toEqual([]);
    }
  });
});
