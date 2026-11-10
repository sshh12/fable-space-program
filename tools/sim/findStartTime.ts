/**
 * Deterministic search for a scenario start time (docs/research/sim-design.md 15.3).
 *
 *   npx tsx tools/sim/findStartTime.ts [--site <id>] [--pad-elevation <m>] [--target <bodyId>]
 *        [--landing-body <bodyId>] [--landing-lat <deg>] [--landing-lon <deg>]
 *        [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--extend-years <n>] [--out <path>]
 *
 * Constraints (checked by checkStartConstraints in src/sim/nav/startWindow.ts, which tests re-run for any
 * scenario): (a) a coplanar ascending-azimuth launch opportunity into the target's orbit plane opens 600 s
 * after the start; (b) Sun 10-35 deg above the pad horizon and rising; (c) from start + 3 d to start + 5 d
 * the Sun at the landing target stays 5-35 deg, rising, disc fully visible.
 *
 * Search: every ascending plane crossing in [from, to) is a candidate (start = crossing - 600 s, so (a)
 * holds exactly); the first candidate that satisfies all constraints with a 1 deg margin on every
 * elevation bound is chosen (the first plain solution if none has the margin). When NO candidate in the
 * requested range [--from, --to) (default 2027-01-01 .. 2031-01-01) satisfies the constraints, the tool
 * says so, records the closest in-range near misses, and continues year by year (at most --extend-years,
 * default 20; 0 = fail instead) to the first exact solution; the output then has search.searchExtended =
 * true. Constraints are never relaxed.
 *
 * Defaults come from data/defs: the site of the first scenario with a suggested landing (else the only
 * site), its numeric padElevation (0 m when the definition says 'terrain' - the pad elevation does not
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
import { DEG } from '../../src/core/math/scalar';
import { createBodySystem } from '../../src/sim/bodies/bodySystem';
import { computeLaunchWindow } from '../../src/sim/nav/launchWindow';
import { checkStartConstraints, padSunOk, START_CONSTRAINT_DEFAULTS, type StartConstraintReport, type SurfacePoint } from '../../src/sim/nav/startWindow';

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

  let padElevation = num(args, 'pad-elevation');
  let padElevationSource = 'argument';
  if (padElevation === undefined) {
    if (typeof site.location.padElevation === 'number') {
      padElevation = site.location.padElevation;
      padElevationSource = `data/defs/sites (${site.id}.location)`;
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

  const sitePoint: SurfacePoint = { bodyId: site.bodyId, latitude: site.location.latDeg * DEG, longitude: site.location.lonDeg * DEG, elevation: padElevation };
  const landingPoint = { bodyId: landing.bodyId, latitude: landing.latDeg * DEG, longitude: landing.lonDeg * DEG };
  const delay = START_CONSTRAINT_DEFAULTS.launchDelay;

  const extendYears = num(args, 'extend-years') ?? 20;
  type Found = { startUt: number; report: StartConstraintReport };
  /** Every ascending opportunity with start in [a, b): solutions, the margin-preferred choice, and near misses. */
  const searchRange = (a: number, b: number): { solutions: Found[]; chosen: Found | null; candidates: number; nearMisses: (Found & { violationDeg: number })[] } => {
    const solutions: Found[] = [];
    const nearMisses: (Found & { violationDeg: number })[] = [];
    let chosen: Found | null = null;
    let candidates = 0;
    let t = a + delay;
    while (t < b + delay) {
      const w = computeLaunchWindow({ system, bodyId: site.bodyId, latitude: sitePoint.latitude, longitude: sitePoint.longitude, elevation: padElevation, ut: t, targetBodyId, kind: 'ascending' });
      if (!w || !w.coplanar) throw new Error(`site latitude ${site.location.latDeg} deg allows no coplanar launch into the ${targetBodyId} plane`);
      const startUt = w.crossingUt - delay;
      t = w.crossingUt + 1;
      if (startUt < a || startUt >= b) continue;
      candidates++;
      if (!padSunOk(system, sitePoint, startUt)) continue;
      const report = checkStartConstraints(system, sitePoint, targetBodyId, landingPoint, startUt);
      const ls = report.landingSun;
      if (!report.ok) {
        if (report.launch.ok && report.padSun.ok && ls.rising && ls.minDeg > 0) {
          const violationDeg = Math.max(0, START_CONSTRAINT_DEFAULTS.landingSunElevationDeg[0] - ls.minDeg) + Math.max(0, ls.maxDeg - START_CONSTRAINT_DEFAULTS.landingSunElevationDeg[1]);
          nearMisses.push({ startUt, report, violationDeg });
        }
        continue;
      }
      solutions.push({ startUt, report });
      const withMargin =
        report.padSun.elevationDeg >= START_CONSTRAINT_DEFAULTS.padSunElevationDeg[0] + 1 &&
        report.padSun.elevationDeg <= START_CONSTRAINT_DEFAULTS.padSunElevationDeg[1] - 1 &&
        ls.minDeg >= START_CONSTRAINT_DEFAULTS.landingSunElevationDeg[0] + 1 &&
        ls.maxDeg <= START_CONSTRAINT_DEFAULTS.landingSunElevationDeg[1] - 1;
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
    site: { id: site.id, bodyId: site.bodyId, latDeg: site.location.latDeg, lonDeg: site.location.lonDeg, padElevation, padElevationSource },
    targetBodyId,
    landing: { ...landing, source: landingSource },
    constraints: {
      launchDelaySeconds: delay,
      launchDelayToleranceSeconds: START_CONSTRAINT_DEFAULTS.launchDelayTolerance,
      padSunElevationDeg: START_CONSTRAINT_DEFAULTS.padSunElevationDeg,
      landingWindowDays: START_CONSTRAINT_DEFAULTS.landingWindow.map((s) => s / 86400),
      landingSunElevationDeg: START_CONSTRAINT_DEFAULTS.landingSunElevationDeg,
    },
    startUt: chosen.startUt,
    startUtc: iso(chosen.startUt),
    launch: {
      opportunityUt: r.launch.crossingUt,
      opportunityUtc: iso(r.launch.crossingUt!),
      delaySeconds: round(r.launch.delay!, 3),
      launchAzimuthDeg: round(r.launch.launchAzimuthDeg!),
      inertialAzimuthDeg: round(r.launch.inertialAzimuthDeg!),
    },
    padSun: { elevationDeg: round(r.padSun.elevationDeg), elevationAtLaunchDeg: round(r.padSun.elevationAtLaunchDeg!), rising: r.padSun.rising },
    landingSun: {
      windowStartUtc: iso(chosen.startUt + START_CONSTRAINT_DEFAULTS.landingWindow[0]),
      windowEndUtc: iso(chosen.startUt + START_CONSTRAINT_DEFAULTS.landingWindow[1]),
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
  };
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`start ${result.startUtc} (ut ${result.startUt}); launch ${result.launch.opportunityUtc} az ${result.launch.launchAzimuthDeg} deg; pad Sun ${result.padSun.elevationDeg} deg; landing Sun ${result.landingSun.startDeg} -> ${result.landingSun.endDeg} deg`);
  console.log(`${solutions.length} solutions among ${candidates} launch opportunities; wrote ${path.relative(repoRoot, outPath)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
