/**
 * The checks of an activated body library (tools/bodies/activate.mjs runs this): the library under a defs
 * root loads and the body system accepts it, the lunar mission's start (tools/sim/start-time.json) still meets
 * its three constraints, the Sun's declination at the solstices and equinoxes is within 0.05 deg of the real
 * instants (the sim-orbits gate), and the Sun's direction at the Earth is the shipped library's within 0.0035
 * deg of declination over 2029-2031. Prints one JSON object; exit code 1 when a check fails.
 *
 *   npx tsx tools/bodies/activate-check.ts --defs <defs root> [--reference <defs root>]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { DEG } from '../../src/core/math/scalar';
import { createBodySystem } from '../../src/sim/bodies/bodySystem';
import { checkStartConstraints, type StartLaunchKind } from '../../src/sim/nav/startWindow';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const utOf = (iso: string): number => (Date.parse(iso) - Date.UTC(2000, 0, 1, 12)) / 1000;

/** UTC instants of the 2024 and 2025 equinoxes and solstices and the Sun's declination there (the sim-orbits gate). */
const SEASONS: [string, number][] = [
  ['2024-03-20T03:06Z', 0],
  ['2024-06-20T20:51Z', 23.4362],
  ['2024-09-22T12:44Z', 0],
  ['2024-12-21T09:20Z', -23.4362],
  ['2025-03-20T09:01Z', 0],
  ['2025-06-21T02:42Z', 23.4362],
  ['2025-09-22T18:19Z', 0],
  ['2025-12-21T15:03Z', -23.4362],
];

async function main(): Promise<void> {
  const defsRoot = arg('defs');
  if (!defsRoot) throw new Error('usage: activate-check.ts --defs <defs root> [--reference <defs root>]');
  const defs = await loadDefs(fsDefSource(defsRoot));
  const system = createBodySystem(defs);
  const out: Record<string, unknown> = { defsRoot, bodies: system.ids.length, root: system.rootId, star: system.starId };
  const failures: string[] = [];

  const earth = Object.values(defs.sites)[0]!.bodyId;
  const sunDecAt = (sys: typeof system, ut: number): number => Math.asin(sys.sunDirectionAt(earth, { x: 0, y: 0, z: 0 }, ut).dir.z) / DEG;
  let worstSeason = 0;
  for (const [iso, dec] of SEASONS) worstSeason = Math.max(worstSeason, Math.abs(sunDecAt(system, utOf(iso)) - dec));
  out['solsticeWorstDeg'] = worstSeason;
  if (!(worstSeason < 0.05)) failures.push(`Sun declination at the solstices and equinoxes off by ${worstSeason.toFixed(4)} deg (gate 0.05)`);

  const refRoot = arg('reference') ?? path.join(repoRoot, 'data', 'defs');
  const ref = createBodySystem(await loadDefs(fsDefSource(refRoot)));
  let worstDec = 0;
  const t0 = utOf('2029-01-01T00:00Z');
  const t1 = utOf('2031-01-01T00:00Z');
  for (let k = 0; k <= 1000; k++) {
    const ut = t0 + ((t1 - t0) * k) / 1000;
    worstDec = Math.max(worstDec, Math.abs(sunDecAt(system, ut) - sunDecAt(ref, ut)));
  }
  out['sunDeclinationAgainstReferenceDeg'] = worstDec;
  if (!(worstDec < 0.0035)) failures.push(`Sun declination at the Earth differs from the reference library by ${worstDec} deg over 2029-2031 (gate 0.0035)`);

  const st = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools', 'sim', 'start-time.json'), 'utf8')) as {
    startUt: number;
    site: { bodyId: string; latDeg: number; lonDeg: number; padElevation: number };
    targetBodyId: string;
    landing: { bodyId: string; latDeg: number; lonDeg: number };
    constraints: { launchKind: StartLaunchKind; padSunElevationDeg: [number, number]; landingWindowDays: [number, number]; landingSunElevationDeg: [number, number] };
  };
  const r = checkStartConstraints(
    system,
    { bodyId: st.site.bodyId, latitude: st.site.latDeg * DEG, longitude: st.site.lonDeg * DEG, elevation: st.site.padElevation },
    st.targetBodyId,
    { bodyId: st.landing.bodyId, latitude: st.landing.latDeg * DEG, longitude: st.landing.lonDeg * DEG },
    st.startUt,
    {
      launchKind: st.constraints.launchKind,
      padSunElevationDeg: st.constraints.padSunElevationDeg,
      landingWindow: [st.constraints.landingWindowDays[0] * 86400, st.constraints.landingWindowDays[1] * 86400],
      landingSunElevationDeg: st.constraints.landingSunElevationDeg,
    },
  );
  out['startConstraints'] = { ok: r.ok, launch: r.launch, padSun: r.padSun, landingSun: r.landingSun };
  if (!r.ok) failures.push('the lunar mission start no longer meets its constraints (checkStartConstraints)');
  out['failures'] = failures;
  console.log(JSON.stringify(out, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
