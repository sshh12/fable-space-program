/**
 * The part of the summed GPU budget table (budget.perf.spec.ts, ARCHITECTURE 17.1 / 29.1) that needs no
 * browser: the whole-frame views, the named lead waivers, how a row is judged, how it is printed, and how a
 * table is compared with the recorded baseline. Unit-tested by tools/dev/budget-table.test.ts (vitest).
 *
 * TWO KINDS OF ROW.
 *  - 'lines': a checkpoint of the table. Each loaded package is held to the sum of its lines, the frame (the
 *    sum of the packages' p99s) to 11 ms.
 *  - 'frame': a view with every package loaded that is asserted on the FRAME TOTAL alone (request
 *    terrain-render-10): the terrain's three ground views that are over its own line under a lead waiver.
 *    A package over its line is tolerable only while the frame holds; the packages' sums are reported.
 *
 * NAMED LEAD WAIVERS. A waiver is granted in the package's own perf spec (`leadWaiver`), with a ceiling in
 * that spec's own method (one pass, p50 or p99). The table does not re-measure a waived line a second way: at
 * a row where a package has a named waiver, the package over the sum of its lines is REPORTED with the
 * waiver and not asserted here; the frame total is asserted all the same. tools/dev/budget-table.test.ts
 * holds this list equal to what the two specs state. A waiver the lead grants on a line of THIS table
 * (TABLE_WAIVERS: the pad's terrain) has its ceiling asserted here.
 *
 * LEAD LINES. Lines the lead has added to ARCHITECTURE 29.1 (LEAD_LINES: the cabin seen from outside).
 *
 * THE BASELINE. `BUDGET_RECORD="<lead's note>"` makes the spec write each row it measures into
 * tests/browser/budget.baseline.json (tracked; the lead's act, on a quiet machine). The presentation sweep's
 * gate "summed GPU budget unchanged within 3 %" is compareWithBaseline of a later run against that file.
 * In that gate (BUDGET_COMPARE=1) the question is "unchanged", so a line that is over AS IT WAS when the
 * baseline was recorded is reported and not failed (oversAgainstBaseline): the baseline itself holds rows
 * in which a package is over its line, and those are findings against that package, not against a refactor
 * that left its cost where it was. Without BUDGET_COMPARE the table is as strict as it ever was.
 */

export const FRAME_BUDGET_MS = 11;
/** A package without a line at a checkpoint may cost this much before it is treated as over its (zero) budget. */
export const UNBUDGETED_MS = 0.1;
/** The sweep's gate: a row's summed GPU time may not rise by more than this share of the recorded baseline. */
export const BASELINE_TOLERANCE = 0.03;

export const PACKAGES = ['terrain', 'vehicle', 'cockpit', 'ocean', 'sky', 'atmosphere', 'vfx'] as const;
export type BudgetPackage = (typeof PACKAGES)[number];

/** Launch pad LC-1 (the site of the three ground views; data/defs/sites/ka-lae.json). */
const PAD = { lat: 18.987556, lon: -155.603239 };

export interface FrameView {
  name: string;
  /** What the view is and why the frame is asserted there. */
  what: string;
  /** Integration lab query of the view (the camera is in it; no vehicle is in these frames). */
  query: string;
}

const groundView = (lat: number, lon: number, alt: number, heading: number, pitch: number): string =>
  `scene=pad&paused=1&body=earth&lat=${lat}&lon=${lon}&alt=${alt}&heading=${heading}&pitch=${pitch}&fov=60&sun=105,31&sunsite=earth,${PAD.lat},${PAD.lon}`;

/** The three ground views of request terrain-render-10 (the terrain's perf views `stony ground`, `kiawe`, `thickets 120 m`). */
export const FRAME_VIEWS: readonly FrameView[] = [
  { name: 'stony ground', what: 'eye height on the stony ground 1 km south-west of the pad, the densest rock field near the site', query: groundView(18.981197, -155.609964, 18.27 + 1.7, 200, -8) },
  { name: 'among kiawe', what: 'eye height among the kiawe north of the pad: ground cover at every level of detail', query: groundView(PAD.lat + 0.0062, PAD.lon + 0.0005, 21.15 + 1.7, 70, -3) },
  { name: 'thickets from 120 m', what: 'the same thickets from 120 m up, trees to 1.8 km', query: groundView(PAD.lat + 0.0035, PAD.lon - 0.001, 21.62 + 120, 15, -24) },
];

export interface NamedWaiver {
  /** Row of the table (a checkpoint or a frame view) at which the waiver applies. */
  row: string;
  pkg: BudgetPackage;
  /** The spec that grants it and the name of its line there. */
  spec: string;
  line: string;
  /** What the waiver waits for (the spec's `until`). */
  until: string;
  /** The line it waives and the ceiling it grants, ms, in the spec's own method. */
  budget: number;
  ceiling: number;
  /** The statistic the ceiling is held on in the spec. */
  statistic: 'p50' | 'p99';
}

const TERRAIN_SPEC = 'tests/browser/terrain/terrain.perf.spec.ts';
const OCEAN_SPEC = 'tests/browser/ocean/ocean.perf.spec.ts';
const MATERIAL_CACHE = 'terrain material cache';
const NEAR_PATCH = 'near-patch pipeline and quality scaling';

/** Every `leadWaiver` of the terrain's and the ocean's perf specs, at the row of this table it bears on. */
export const NAMED_WAIVERS: readonly NamedWaiver[] = [
  { row: 'stony ground', pkg: 'terrain', spec: TERRAIN_SPEC, line: 'stony ground: G-buffer with the ground cover', until: MATERIAL_CACHE, budget: 1.5, ceiling: 2.9, statistic: 'p99' },
  { row: 'among kiawe', pkg: 'terrain', spec: TERRAIN_SPEC, line: 'kiawe: G-buffer with the ground cover', until: MATERIAL_CACHE, budget: 1.5, ceiling: 2.05, statistic: 'p99' },
  { row: 'among kiawe', pkg: 'terrain', spec: TERRAIN_SPEC, line: 'kiawe: shadows with the ground cover', until: MATERIAL_CACHE, budget: 0.5, ceiling: 0.65, statistic: 'p99' },
  { row: 'thickets from 120 m', pkg: 'terrain', spec: TERRAIN_SPEC, line: 'thickets 120 m: G-buffer with the ground cover', until: MATERIAL_CACHE, budget: 1.5, ceiling: 3.45, statistic: 'p99' },
  { row: 'splashdown', pkg: 'ocean', spec: OCEAN_SPEC, line: 'splashdown, near pass', until: NEAR_PATCH, budget: 0.6, ceiling: 0.73, statistic: 'p50' },
  { row: 'splashdown', pkg: 'ocean', spec: OCEAN_SPEC, line: 'splashdown, ocean', until: NEAR_PATCH, budget: 0.9, ceiling: 0.9, statistic: 'p50' },
  { row: 'pad lift-off', pkg: 'ocean', spec: OCEAN_SPEC, line: 'coast 60 m, near pass', until: NEAR_PATCH, budget: 0.6, ceiling: 0.94, statistic: 'p50' },
  { row: 'pad lift-off', pkg: 'ocean', spec: OCEAN_SPEC, line: 'coast 60 m, ocean', until: NEAR_PATCH, budget: 0.8, ceiling: 1.03, statistic: 'p50' },
];

export const waiversOf = (row: string, pkg: string): NamedWaiver[] => NAMED_WAIVERS.filter((w) => w.row === row && w.pkg === pkg);

/** The checkpoints of the table, in the order of every line's values (ARCHITECTURE 29.1). */
export const TABLE_CHECKPOINTS = ['pad lift-off', 'ascent 10-40 km', 'LEO', 'LEO cockpit', 'lunar descent', 'reentry', 'splashdown'] as const;

export interface TableLine {
  line: string;
  pkg: BudgetPackage | 'core' | 'ui';
  /** ms (p99) per checkpoint, in the order of TABLE_CHECKPOINTS. */
  ms: number[];
}

/**
 * Lines the LEAD has added to the table of ARCHITECTURE 29.1 (the spec appends them to the table's own).
 *
 * The cabin seen from outside (lead decision of 2026-11-12): a lit cabin behind the capsule's windows is a
 * feature with a cost, and the table had no line for it: the cockpit package costs 0.07 to 0.11 ms in
 * every outside view (the recording of 2026-11-12). 0.15 ms where the vessel's cabin is in view, taken from
 * the frame's unallocated remainder. None at the pad: that column has 0.05 ms unallocated, and the cockpit
 * stays there under the 0.1 ms that a package without a line may cost (0.077 ms as recorded). None in the
 * cockpit view, whose own line covers the cabin.
 */
export const LEAD_LINES: readonly TableLine[] = [{ line: 'Cabin seen from outside: the lit interior through the windows (lead addition of 2026-11-12)', pkg: 'cockpit', ms: [0, 0.15, 0.15, 0, 0.15, 0.15, 0.15] }];

/**
 * A waiver the LEAD grants on a line of this table itself (not on a line of a package's own spec): the
 * package may stand over the sum of its lines at that row, up to `ceiling`, which THIS table asserts,
 * since no other spec holds it. `budget` is the sum of the lines it was granted on: when the table's line
 * is another number, the waiver is stale and the row fails.
 */
export interface TableWaiver {
  row: string;
  pkg: BudgetPackage;
  until: string;
  budget: number;
  ceiling: number;
  /** When it was granted and on what measurement. */
  granted: string;
}

/** The pad's terrain: 2.348 ms against 2.15 in the recording of 2026-11-12; with the terrain's other waivers, until the material cache. */
export const TABLE_WAIVERS: readonly TableWaiver[] = [
  { row: 'pad lift-off', pkg: 'terrain', until: MATERIAL_CACHE, budget: 2.15, ceiling: 2.47, granted: 'lead decision of 2026-11-12, on 2.348 ms in the recorded baseline' },
];

export const tableWaiverOf = (row: string, pkg: string): TableWaiver | undefined => TABLE_WAIVERS.find((w) => w.row === row && w.pkg === pkg);
const describeTableWaiver = (w: TableWaiver): string => `LEAD WAIVER on this table's line until "${w.until}": ceiling ${w.ceiling} ms p99, asserted here (${w.granted})`;

/** What the judgement and the printing need of a measured row. */
export interface BudgetRow {
  checkpoint: string;
  kind: 'lines' | 'frame';
  loaded: readonly string[];
  /** p99 GPU ms per package (its feature ids summed), and 'core'. */
  measured: Record<string, number>;
  /** Budget per package at this row (the sum of its lines); empty for a 'frame' row. */
  budget: Record<string, number>;
  frame: { sum: number; typical: number };
}

export interface RowVerdict {
  /** What fails the row. */
  over: string[];
  /** What each entry of `over` is about: a package, 'frame', or 'loaded' (a whole-frame view without every package). */
  overOf: string[];
  /** Packages over the sum of their lines under a named lead waiver: reported, held by their own specs. */
  waived: string[];
  /** Packages that cost something where the table has no line for them (under UNBUDGETED_MS). */
  unbudgeted: string[];
}

const allLoaded = (row: BudgetRow): boolean => PACKAGES.every((p) => row.loaded.includes(p));
const describeWaiver = (w: NamedWaiver): string => `LEAD WAIVER until "${w.until}": ${w.line}, line ${w.budget} ms, ceiling ${w.ceiling} ms ${w.statistic} (${w.spec})`;

/** Judge a measured row; `owner` names the package's owner in the messages. */
export function judgeRow(row: BudgetRow, owner: (pkg: string) => string = (p) => p): RowVerdict {
  const verdict: RowVerdict = { over: [], overOf: [], waived: [], unbudgeted: [] };
  const fail = (about: string, message: string): void => {
    verdict.over.push(message);
    verdict.overOf.push(about);
  };
  if (row.kind === 'lines') {
    for (const [pkg, ms] of Object.entries(row.measured)) {
      const limit = row.budget[pkg];
      if (limit === undefined) {
        fail(pkg, `${pkg}: ${ms.toFixed(3)} ms has no line in the table`);
        continue;
      }
      const isOver = limit === 0 ? ms > UNBUDGETED_MS : ms > limit;
      const waivers = waiversOf(row.checkpoint, pkg);
      const own = tableWaiverOf(row.checkpoint, pkg);
      if (isOver && own) {
        // The lead's waiver on a line of this table: its ceiling is asserted here.
        if (Math.abs(own.budget - limit) > 1e-9) fail(pkg, `${pkg} (${owner(pkg)}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms; the lead's waiver was granted on a line of ${own.budget.toFixed(2)} ms and is stale`);
        else if (ms > own.ceiling) fail(pkg, `${pkg} (${owner(pkg)}): ${ms.toFixed(3)} ms against the waived ceiling of ${own.ceiling.toFixed(2)} ms (line ${limit.toFixed(2)} ms; ${describeTableWaiver(own)})`);
        else verdict.waived.push(`${pkg} (${owner(pkg)}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms; ${describeTableWaiver(own)}`);
      } else if (isOver && waivers.length > 0) verdict.waived.push(`${pkg} (${owner(pkg)}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms; ${waivers.map(describeWaiver).join('; ')}`);
      else if (isOver) fail(pkg, `${pkg} (${owner(pkg)}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms`);
      else if (limit === 0 && ms > 0.005) verdict.unbudgeted.push(`${pkg} (${owner(pkg)}) has no line at this checkpoint and costs ${ms.toFixed(3)} ms`);
    }
    if (allLoaded(row) && row.frame.sum > FRAME_BUDGET_MS) fail('frame', `frame: ${row.frame.sum.toFixed(2)} ms against ${FRAME_BUDGET_MS} ms`);
  } else {
    // A whole-frame view asserts the frame, and only with every package in it: a frame that lacks one proves nothing.
    const missing = PACKAGES.filter((p) => !row.loaded.includes(p));
    if (missing.length > 0) fail('loaded', `the whole-frame assertion needs every render package loaded; missing: ${missing.join(', ')}`);
    if (row.frame.sum > FRAME_BUDGET_MS) fail('frame', `frame: ${row.frame.sum.toFixed(2)} ms against ${FRAME_BUDGET_MS} ms`);
    for (const pkg of Object.keys(row.measured)) {
      const waivers = waiversOf(row.checkpoint, pkg);
      if (waivers.length > 0) verdict.waived.push(`${pkg} (${owner(pkg)}): ${row.measured[pkg]!.toFixed(3)} ms in this frame; ${waivers.map(describeWaiver).join('; ')}`);
    }
  }
  return verdict;
}

/** One line per package of a row: measured against its budget, with its named waivers; then the frame. */
export function packageLines(row: BudgetRow, owner: (pkg: string) => string = (p) => p): string[] {
  const names = ['core', ...PACKAGES.filter((p) => p in row.measured || p in row.budget), ...Object.keys(row.measured).filter((p) => p !== 'core' && !(PACKAGES as readonly string[]).includes(p))];
  const lines = names.map((pkg) => {
    const ms = row.measured[pkg];
    const limit = row.budget[pkg];
    const present = pkg === 'core' || row.loaded.includes(pkg) || ms !== undefined;
    const measured = !present ? 'absent' : `${(ms ?? 0).toFixed(3)} ms`;
    const against = row.kind === 'frame' ? 'reported' : limit === undefined ? 'no line' : `budget ${limit.toFixed(2)} ms`;
    const state = row.kind === 'frame' || limit === undefined || !present ? '' : (limit === 0 ? (ms ?? 0) > UNBUDGETED_MS : (ms ?? 0) > limit) ? ' OVER' : '';
    const own = row.kind === 'lines' ? tableWaiverOf(row.checkpoint, pkg) : undefined;
    const notes = [...waiversOf(row.checkpoint, pkg).map(describeWaiver), ...(own ? [describeTableWaiver(own)] : [])];
    return `${pkg}${pkg === 'core' ? '' : ` (${owner(pkg)})`}: ${measured} / ${against}${state}${notes.length > 0 ? ` [${notes.join('; ')}]` : ''}`;
  });
  lines.push(`frame: sum of the p99s ${row.frame.sum.toFixed(2)} ms / ${FRAME_BUDGET_MS} ms${row.frame.sum > FRAME_BUDGET_MS ? ' OVER' : ''}; typical ${row.frame.typical.toFixed(2)} ms`);
  return lines;
}

// ------------------------------------------------------------------------------------------- the baseline

export interface BaselineRow {
  kind: 'lines' | 'frame';
  loaded: string[];
  measured: Record<string, number>;
  budget: Record<string, number>;
  frame: { sum: number; typical: number };
  at: string;
  commit: string;
}

export interface BudgetBaseline {
  version: 1;
  /** The lead's note of the recording (who, when, on what tree, how quiet the machine was). */
  note: string;
  /** How the numbers were taken (resolution, windows): a later run compares like with like. */
  method: string;
  rows: Record<string, BaselineRow>;
}

/** The baseline with `row` put in (the lead's recording: a row measured again replaces its entry). */
export function withBaselineRow(baseline: BudgetBaseline | null, row: BudgetRow, meta: { note: string; method: string; at: string; commit: string }): BudgetBaseline {
  if (meta.note.trim().length < 8) throw new Error('recording the budget baseline needs the lead\'s note (BUDGET_RECORD="<who, when, why>")');
  const rows = { ...(baseline?.rows ?? {}) };
  rows[row.checkpoint] = { kind: row.kind, loaded: [...row.loaded], measured: { ...row.measured }, budget: { ...row.budget }, frame: { sum: row.frame.sum, typical: row.frame.typical }, at: meta.at, commit: meta.commit };
  return { version: 1, note: meta.note.trim(), method: meta.method, rows };
}

export interface BaselineComparison {
  row: string;
  baseline: number;
  now: number;
  /** (now - baseline) / baseline. */
  change: number;
  /** True when the summed GPU time rose by more than the tolerance. */
  regressed: boolean;
  /** Packages whose own time moved by more than the tolerance and by more than 0.02 ms (information). */
  packages: string[];
}

/**
 * A measured row against the recorded baseline: the SUM of the packages' p99s may not rise by more than
 * `tolerance` (a faster frame is reported, not failed). Null when the baseline has no such row, or was
 * recorded with other packages loaded (the sums are then not comparable).
 */
export function compareWithBaseline(baseline: BudgetBaseline, row: BudgetRow, tolerance = BASELINE_TOLERANCE): BaselineComparison | null {
  const then = baseline.rows[row.checkpoint];
  if (!then || [...then.loaded].sort().join() !== [...row.loaded].sort().join()) return null;
  const change = (row.frame.sum - then.frame.sum) / then.frame.sum;
  const packages: string[] = [];
  for (const pkg of new Set([...Object.keys(then.measured), ...Object.keys(row.measured)])) {
    const a = then.measured[pkg] ?? 0;
    const b = row.measured[pkg] ?? 0;
    if (Math.abs(b - a) > 0.02 && Math.abs(b - a) > tolerance * Math.max(a, 1e-9)) packages.push(`${pkg} ${a.toFixed(3)} -> ${b.toFixed(3)} ms`);
  }
  return { row: row.checkpoint, baseline: then.frame.sum, now: row.frame.sum, change, regressed: change > tolerance, packages };
}

/** A package's time counts as unchanged against the baseline within the tolerance or this many ms, whichever is more. */
export const PACKAGE_NOISE_MS = 0.02;

/**
 * The verdict's failures, split for the gate that asks "unchanged": `asRecorded` are the lines that are
 * over while their package's time (or the frame's sum) has not risen against the recorded row by more than
 * the tolerance (for a package: or by PACKAGE_NOISE_MS); `fresh` is everything else, and all of them when
 * the baseline has no comparable row.
 */
export function oversAgainstBaseline(baseline: BudgetBaseline | null, row: BudgetRow, verdict: RowVerdict, tolerance = BASELINE_TOLERANCE): { fresh: string[]; asRecorded: string[] } {
  const then = baseline?.rows[row.checkpoint];
  const comparable = then !== undefined && [...then.loaded].sort().join() === [...row.loaded].sort().join();
  const out = { fresh: [] as string[], asRecorded: [] as string[] };
  verdict.over.forEach((message, i) => {
    const about = verdict.overOf[i]!;
    let unchanged = false;
    if (comparable && about === 'frame') unchanged = row.frame.sum - then.frame.sum <= tolerance * then.frame.sum;
    else if (comparable && about !== 'loaded') {
      const a = then.measured[about];
      const b = row.measured[about];
      unchanged = a !== undefined && b !== undefined && b - a <= Math.max(PACKAGE_NOISE_MS, tolerance * a);
    }
    (unchanged ? out.asRecorded : out.fresh).push(message);
  });
  return out;
}

export function describeBaselineComparison(c: BaselineComparison): string {
  return (
    `${c.row}: summed GPU time ${c.now.toFixed(2)} ms against the recorded ${c.baseline.toFixed(2)} ms (${c.change >= 0 ? '+' : ''}${(c.change * 100).toFixed(1)} %)` +
    (c.regressed ? `: ROSE by more than ${(BASELINE_TOLERANCE * 100).toFixed(0)} %` : '') +
    (c.packages.length > 0 ? `; packages that moved: ${c.packages.join(', ')}` : '')
  );
}
