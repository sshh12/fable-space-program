/**
 * Deterministic search for a scenario start time (docs/research/sim-design.md 15.3).
 *
 *   npx tsx tools/sim/findStartTime.ts [--site <id>] [--pad <id>] [--pad-elevation <m>] [--target <bodyId>]
 *        [--landing-body <bodyId>] [--landing-lat <deg>] [--landing-lon <deg>]
 *        [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--extend-years <n>] [--out <path>]
 *        [--pad-sun-min <deg>] [--pad-sun-max <deg>] [--landing-sun-min <deg>] [--landing-sun-max <deg>]
 *        [--stay-from-days <d>] [--stay-to-days <d>] [--launch-kind ascending|descending|either]
 *
 * Constraints (checked by checkStartConstraints in src/sim/nav/startWindow.ts, which tests re-run for any
 * scenario): (a) a coplanar launch opportunity into the target's orbit plane opens 600 s after the start -
 * by default an ascending-azimuth (northbound) one as the brief defines it; --launch-kind descending /
 * either accepts the southbound crossing as well (also coplanar: no plane change at TLI); (b) Sun 10-35 deg
 * above the pad horizon and rising; (c) from start + 3 d to start + 5 d the Sun at the landing target stays
 * 5-35 deg, rising, disc fully visible. The numbers of (b) and (c) can be overridden with the flags above;
 * the values used are written to the output (`constraints`).
 *
 * Search: every plane crossing of the selected kind in [from, to) is a candidate (start = crossing - 600 s
 * snapped to the nearest whole tick of 1/120 s, the grid every scenario start is on: ARCHITECTURE section 3;
 * so (a) holds to half a tick); the first candidate that satisfies all constraints with a 1 deg margin on every
 * elevation bound is chosen (the first plain solution if none has the margin). When NO candidate in the
 * requested range [--from, --to) (default 2027-01-01 .. 2031-01-01) satisfies the constraints, the tool
 * says so, records the closest in-range near misses, and continues year by year (at most --extend-years,
 * default 20; 0 = fail instead) to the first exact solution; the output then has search.searchExtended =
 * true. Constraints are never relaxed. For the lead's start-policy decision the output also lists, under
 * `otherLaunchKinds`, what the requested range holds for each other launch kind (same (b) and (c)).
 *
 * Defaults come from data/defs: the site of the first scenario with a suggested landing (else the only
 * site) and the pad that scenario stands on (--pad; else the site's first pad), its numeric padElevation (0 m when the definition says 'terrain' - the pad elevation does not
 * change geocentric angles measurably; recorded in the output), the scenario's target (else the first
 * attractor orbiting the site's body), and the scenario's suggested landing (else 0.674 N, 23.473 E on the
 * target body). Result: tools/sim/start-time.json (or --out).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary, ScenarioDef } from '../../src/core/contracts/defs';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { padLocationOf, padOf } from '../../src/core/defs/sites';
import { DEG } from '../../src/core/math/scalar';
import { createBodySystem } from '../../src/sim/bodies/bodySystem';
import { nearestTick, snapToTick } from '../../src/sim/clock';
import { computeLaunchWindow } from '../../src/sim/nav/launchWindow';
import {
  checkStartConstraints,
  launchWindowKind,
  padSunOk,
  START_CONSTRAINT_DEFAULTS,
  type StartConstraintReport,
  type StartLaunchKind,
  type SurfacePoint,
} from '../../src/sim/nav/startWindow';

const LAUNCH_KINDS: readonly StartLaunchKind[] = ['ascending', 'descending', 'either'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DEFAULT_LANDING = { latDeg: 0.674, lonDeg: 23.473 };

const utFromDate = (s: string): number => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`bad date "${s}" (want YYYY-MM-DD)`);
  return (ms - J2000_MS) / 1000;
};
const iso = (ut: number): string => new Date(J2000_MS + ut * 1000).toISOString();
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${a}`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

function num(args: Record<string, string>, key: string): number | undefined {
  if (args[key] === undefined) return undefined;
  const x = Number(args[key]);
  if (!Number.isFinite(x)) throw new Error(`--${key} must be a number`);
  return x;
}

function pickScenario(defs: DefLibrary, siteId: string | undefined): ScenarioDef | undefined {
  return Object.values(defs.scenarios)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .find((s) => s.suggestedLanding && (siteId === undefined || s.site === siteId));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const defs = await loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs')));
  const system = createBodySystem(defs);

  const scenario = pickScenario(defs, args['site']);
  const siteIds = Object.keys(defs.sites).sort();
  const siteId = args['site'] ?? scenario?.site ?? (siteIds.length === 1 ? siteIds[0] : undefined);
  if (!siteId || !defs.sites[siteId]) throw new Error(`choose a site with --site (known: ${siteIds.join(', ')})`);
  const site = defs.sites[siteId]!;
  // The pad: the argument, else the pad of the scenario when it is the scenario's site, else the first pad.
  const pad = padOf(site, args['pad'] ?? (scenario?.site === site.id ? scenario.pad : undefined));
  const where = padLocationOf(site, pad.id);

  let padElevation = num(args, 'pad-elevation');
  let padElevationSource = 'argument';
  if (padElevation === undefined) {
    if (typeof where.padElevation === 'number') {
      padElevation = where.padElevation;
      padElevationSource = `data/defs/sites (${site.id}.location, pad ${pad.id})`;
    } else {
      padElevation = 0;
      padElevationSource = "definition says 'terrain': 0 m assumed (geocentric angles do not depend on it)";
    }
  }

  const targetBodyId = args['target'] ?? scenario?.target ?? system.body(site.bodyId).childIds[0];
  if (!targetBodyId || !defs.bodies[targetBodyId]) throw new Error('no target body (use --target)');

  let landingSource = 'argument';
  let landing = {
    bodyId: args['landing-body'] ?? scenario?.suggestedLanding?.bodyId ?? targetBodyId,
    latDeg: num(args, 'landing-lat') ?? scenario?.suggestedLanding?.latDeg ?? DEFAULT_LANDING.latDeg,
    lonDeg: num(args, 'landing-lon') ?? scenario?.suggestedLanding?.lonDeg ?? DEFAULT_LANDING.lonDeg,
  };
  if (args['landing-lat'] === undefined && args['landing-lon'] === undefined) {
    landingSource = scenario?.suggestedLanding ? `data/defs/scenarios/${scenario.id}.json suggestedLanding` : 'built-in default (0.674 N, 23.473 E)';
  }
  if (!defs.bodies[landing.bodyId]) throw new Error(`unknown landing body "${landing.bodyId}"`);

  const fromUt = utFromDate(args['from'] ?? '2027-01-01');
  const toUt = utFromDate(args['to'] ?? '2031-01-01');
  const outPath = path.resolve(repoRoot, args['out'] ?? 'tools/sim/start-time.json');

  const sitePoint: SurfacePoint = { bodyId: site.bodyId, latitude: where.latDeg * DEG, longitude: where.lonDeg * DEG, elevation: padElevation };
  const landingPoint = { bodyId: landing.bodyId, latitude: landing.latDeg * DEG, longitude: landing.lonDeg * DEG };
  // Constraint values: the defaults of src/sim/nav/startWindow.ts unless overridden on the command line.
  const D = START_CONSTRAINT_DEFAULTS;
  const launchKindArg = args['launch-kind'] ?? D.launchKind;
  if (!LAUNCH_KINDS.includes(launchKindArg as StartLaunchKind)) throw new Error(`--launch-kind must be one of ${LAUNCH_KINDS.join(', ')}`);
  const launchKind = launchKindArg as StartLaunchKind;
  const cons = {
    launchDelay: D.launchDelay,
    launchDelayTolerance: D.launchDelayTolerance,
    launchKind,
    padSunElevationDeg: [num(args, 'pad-sun-min') ?? D.padSunElevationDeg[0], num(args, 'pad-sun-max') ?? D.padSunElevationDeg[1]] as const,
    landingWindow: [(num(args, 'stay-from-days') ?? D.landingWindow[0] / 86400) * 86400, (num(args, 'stay-to-days') ?? D.landingWindow[1] / 86400) * 86400] as const,
    landingSunElevationDeg: [num(args, 'landing-sun-min') ?? D.landingSunElevationDeg[0], num(args, 'landing-sun-max') ?? D.landingSunElevationDeg[1]] as const,
    sampleStep: D.sampleStep,
  };
  const delay = cons.launchDelay;

  const extendYears = num(args, 'extend-years') ?? 20;
  type Found = { startUt: number; report: StartConstraintReport };
  type RangeResult = { solutions: Found[]; chosen: Found | null; candidates: number; nearMisses: (Found & { violationDeg: number })[] };
  /** Every opportunity of `kind` with start in [a, b): solutions, the margin-preferred choice, and near misses. */
  const searchRange = (a: number, b: number, kind: StartLaunchKind = launchKind): RangeResult => {
    const solutions: Found[] = [];
    const nearMisses: (Found & { violationDeg: number })[] = [];
    const kindCons = { ...cons, launchKind: kind };
    let chosen: Found | null = null;
    let candidates = 0;
    let t = a + delay;
    while (t < b + delay) {
      const w = computeLaunchWindow({ system, bodyId: site.bodyId, latitude: sitePoint.latitude, longitude: sitePoint.longitude, elevation: padElevation, ut: t, targetBodyId, kind: launchWindowKind(kind) });
      if (!w || !w.coplanar) throw new Error(`site latitude ${site.location.latDeg} deg allows no coplanar launch into the ${targetBodyId} plane`);
      const startUt = snapToTick(w.crossingUt - delay);
      t = w.crossingUt + 1;
      if (startUt < a || startUt >= b) continue;
      candidates++;
      if (!padSunOk(system, sitePoint, startUt, cons.padSunElevationDeg)) continue;
      const report = checkStartConstraints(system, sitePoint, targetBodyId, landingPoint, startUt, kindCons);
      const ls = report.landingSun;
      if (!report.ok) {
        if (report.launch.ok && report.padSun.ok && ls.rising && ls.minDeg > 0) {
          const violationDeg = Math.max(0, cons.landingSunElevationDeg[0] - ls.minDeg) + Math.max(0, ls.maxDeg - cons.landingSunElevationDeg[1]);
          nearMisses.push({ startUt, report, violationDeg });
        }
        continue;
      }
      solutions.push({ startUt, report });
      const withMargin =
        report.padSun.elevationDeg >= cons.padSunElevationDeg[0] + 1 &&
        report.padSun.elevationDeg <= cons.padSunElevationDeg[1] - 1 &&
        ls.minDeg >= cons.landingSunElevationDeg[0] + 1 &&
        ls.maxDeg <= cons.landingSunElevationDeg[1] - 1;
      if (!chosen && withMargin) chosen = { startUt, report };
    }
    nearMisses.sort((p, q) => p.violationDeg - q.violationDeg || p.startUt - q.startUt);
    return { solutions, chosen: chosen ?? solutions[0] ?? null, candidates, nearMisses };
  };

  const inRange = searchRange(fromUt, toUt);
  let found = inRange;
  let searchedTo = toUt;
  let extendedYears = 0;
  while (!found.chosen && extendedYears < extendYears) {
    const next = (Date.parse(`${iso(searchedTo).slice(0, 4)}-01-01T00:00:00Z`) - J2000_MS) / 1000;
    const yEnd = utFromDate(`${Number(iso(next).slice(0, 4)) + 1}-01-01`);
    found = searchRange(searchedTo, yEnd);
    searchedTo = yEnd;
    extendedYears++;
  }
  const chosen = found.chosen;
  if (!chosen) {
    const best = inRange.nearMisses[0];
    throw new Error(
      `no start time in [${iso(fromUt)}, ${iso(searchedTo)}) satisfies the constraints (${inRange.candidates} opportunities in the requested range)` +
        (best ? `; closest in range: ${iso(best.startUt)} (landing Sun ${best.report.landingSun.minDeg.toFixed(2)}-${best.report.landingSun.maxDeg.toFixed(2)} deg)` : ''),
    );
  }
  const solutions = found.solutions;
  const candidates = inRange.candidates;
  const extended = extendedYears > 0;
  if (extended) {
    console.log(`WARNING: no start time in the requested range [${iso(fromUt)}, ${iso(toUt)}) satisfies all constraints; search extended to ${iso(searchedTo)}.`);
    for (const m of inRange.nearMisses.slice(0, 3)) {
      console.log(`  near miss ${iso(m.startUt)}: pad Sun ${m.report.padSun.elevationDeg.toFixed(2)} deg, landing Sun ${m.report.landingSun.minDeg.toFixed(2)} -> ${m.report.landingSun.maxDeg.toFixed(2)} deg (violation ${m.violationDeg.toFixed(2)} deg)`);
    }
  }

  const brief = (s: Found) => ({
    startUt: s.startUt,
    startUtc: iso(s.startUt),
    ascending: s.report.launch.ascending,
    launchAzimuthDeg: round(s.report.launch.launchAzimuthDeg!, 2),
    padSunDeg: round(s.report.padSun.elevationDeg, 2),
    landingSunStartDeg: round(s.report.landingSun.startDeg, 2),
    landingSunEndDeg: round(s.report.landingSun.endDeg, 2),
  });
  // What the requested range holds under each other definition of constraint (a) (same (b) and (c)).
  const otherLaunchKinds = LAUNCH_KINDS.filter((k) => k !== launchKind).map((k) => {
    const res = searchRange(fromUt, toUt, k);
    return { launchKind: k, opportunities: res.candidates, solutionsInRequestedRange: res.solutions.length, chosen: res.chosen ? brief(res.chosen) : null, solutions: res.solutions.slice(0, 12).map(brief) };
  });
  for (const alt of otherLaunchKinds) {
    console.log(
      `launch kind '${alt.launchKind}': ${alt.solutionsInRequestedRange} solutions in the requested range` +
        (alt.chosen ? `; would choose ${alt.chosen.startUtc} (az ${alt.chosen.launchAzimuthDeg} deg, pad Sun ${alt.chosen.padSunDeg} deg, landing Sun ${alt.chosen.landingSunStartDeg} -> ${alt.chosen.landingSunEndDeg} deg)` : ''),
    );
  }

  const r = chosen.report;
  const result = {
    generatedBy: 'tools/sim/findStartTime.ts',
    note: 'Re-run when the bakes move the pad or the landing target; tests re-check these constraints for the scenario.',
    search: {
      from: iso(fromUt),
      to: iso(toUt),
      launchOpportunitiesChecked: candidates,
      solutionsInRequestedRange: inRange.solutions.length,
      searchExtended: extended,
      ...(extended
        ? {
            extendedTo: iso(searchedTo),
            extensionReason: 'no launch opportunity in the requested range satisfies all three constraints; the first exact solution after it was taken',
            nearMissesInRequestedRange: inRange.nearMisses.slice(0, 5).map((m) => ({
              startUt: m.startUt,
              startUtc: iso(m.startUt),
              padSunDeg: round(m.report.padSun.elevationDeg, 2),
              landingSunMinDeg: round(m.report.landingSun.minDeg, 2),
              landingSunMaxDeg: round(m.report.landingSun.maxDeg, 2),
              violationDeg: round(m.violationDeg, 2),
            })),
          }
        : {}),
      selection: 'first solution with >= 1 deg margin on every elevation bound (else the first solution)',
    },
    site: { id: site.id, pad: pad.id, bodyId: site.bodyId, latDeg: where.latDeg, lonDeg: where.lonDeg, padElevation, padElevationSource },
    targetBodyId,
    landing: { ...landing, source: landingSource },
    constraints: {
      launchKind,
      launchDelaySeconds: delay,
      launchDelayToleranceSeconds: cons.launchDelayTolerance,
      padSunElevationDeg: cons.padSunElevationDeg,
      landingWindowDays: cons.landingWindow.map((s) => s / 86400),
      differFromDefaults:
        JSON.stringify([launchKind, cons.padSunElevationDeg, cons.landingWindow, cons.landingSunElevationDeg]) !==
        JSON.stringify([D.launchKind, D.padSunElevationDeg, D.landingWindow, D.landingSunElevationDeg]),
      landingSunElevationDeg: cons.landingSunElevationDeg,
    },
    startUt: chosen.startUt,
    startTick: nearestTick(chosen.startUt),
    startUtc: iso(chosen.startUt),
    launch: {
      opportunityUt: r.launch.crossingUt,
      opportunityUtc: iso(r.launch.crossingUt!),
      delaySeconds: round(r.launch.delay!, 3),
      ascending: r.launch.ascending,
      launchAzimuthDeg: round(r.launch.launchAzimuthDeg!),
      inertialAzimuthDeg: round(r.launch.inertialAzimuthDeg!),
    },
    padSun: { elevationDeg: round(r.padSun.elevationDeg), elevationAtLaunchDeg: round(r.padSun.elevationAtLaunchDeg!), rising: r.padSun.rising },
    landingSun: {
      windowStartUtc: iso(chosen.startUt + cons.landingWindow[0]),
      windowEndUtc: iso(chosen.startUt + cons.landingWindow[1]),
      startDeg: round(r.landingSun.startDeg),
      endDeg: round(r.landingSun.endDeg),
      minDeg: round(r.landingSun.minDeg),
      maxDeg: round(r.landingSun.maxDeg),
      rising: r.landingSun.rising,
      lit: r.landingSun.lit,
      minVisibility: round(r.landingSun.minVisibility, 6),
    },
    alternatives: solutions.slice(0, 12).map((s) => ({
      startUt: s.startUt,
      startUtc: iso(s.startUt),
      padSunDeg: round(s.report.padSun.elevationDeg, 2),
      landingSunStartDeg: round(s.report.landingSun.startDeg, 2),
      landingSunEndDeg: round(s.report.landingSun.endDeg, 2),
    })),
    otherLaunchKinds: {
      note: 'Requested range only, same pad-Sun and landing-Sun constraints; constraint (a) with the given launch kind (--launch-kind).',
      results: otherLaunchKinds,
    },
  };
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`start ${result.startUtc} (ut ${result.startUt}); ${launchKind} launch ${result.launch.opportunityUtc} az ${result.launch.launchAzimuthDeg} deg; pad Sun ${result.padSun.elevationDeg} deg; landing Sun ${result.landingSun.startDeg} -> ${result.landingSun.endDeg} deg`);
  console.log(`${solutions.length} solutions among ${candidates} launch opportunities; wrote ${path.relative(repoRoot, outPath)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
