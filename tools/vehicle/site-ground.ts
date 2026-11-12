/**
 * Site ground report: the real terrain height under every structure of every launch site, relative to the
 * pad plane, from the baked tiles (data/tiles) through the terrain provider.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/vehicle/site-ground.ts [radial | survey | verify]
 *
 * Prints, per structure, the terrain height at its origin and the lowest / highest terrain inside its
 * footprint radius; with `radial` also the terrain profile along eight bearings out to the blend radius.
 * A report for a person placing structures (how deep a skirt must go, where a slab would stand proud).
 *
 * `survey` writes the ground survey of every site (data/defs/visuals/sites/<siteId>.json, section
 * `visuals/sites/<siteId>`; src/render/vehicle/site/survey.ts): the highest and the lowest terrain round
 * every node of a 5 m grid over everything the site's structures cover, from the height authority at 1 m
 * spacing. The earthworks, roads, fences and supports of the site feature are built on it. Run it again
 * whenever the terrain tiles, the pad shape or the extent of the structures change; `verify` re-samples the
 * terrain and fails if any point lies outside the bounds of the survey in the library.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { latLonToDir } from '../../src/core/geo/cubeSphere';
import { v3 } from '../../src/core/math';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../src/terrain/provider';
import { generateStructure } from '../../src/render/vehicle/site';
import { LEVEL_GROUND, siteGround, siteSurvey, surveySectionOf, type SiteSurveyDef } from '../../src/render/vehicle/site/survey';

const DEG = Math.PI / 180;

async function main(): Promise<void> {
  const defs = await loadDefs(fsDefSource());
  const terrain = await createTerrainProvider(defs, createFsTileSource(path.resolve('data/tiles')));
  const radial = process.argv.includes('radial');
  const survey = process.argv.includes('survey');
  const verify = process.argv.includes('verify');
  let failed = false;
  for (const site of Object.values(defs.sites)) {
    const body = defs.bodies[site.bodyId]!;
    const up = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
    let east = v3.cross({ x: 0, y: 0, z: 1 }, up);
    east = v3.normalize(east);
    const north = v3.cross(up, east);
    await terrain.ensureLoaded(site.bodyId, up, site.pad.blendRadius + 200, 'site-ground');
    const pad = typeof site.location.padElevation === 'number' ? site.location.padElevation : terrain.heightAt(site.bodyId, up);
    const R = body.radius + pad;
    /** Terrain height above the pad's tangent plane at an east / north offset, m. */
    const above = (e: number, n: number): number => {
      const p = v3.add(v3.scale(up, R), v3.add(v3.scale(east, e), v3.scale(north, n)));
      const dir = v3.normalize(p);
      const h = terrain.heightAt(site.bodyId, dir);
      // Height of the terrain point over the tangent plane (the curvature drop is part of what a structure sees).
      return v3.dot(v3.scale(dir, body.radius + h), up) - R;
    };
    if (survey) {
      // Extent: everything the structures cover (their meshes on level ground, in the site frame), plus a margin.
      let e0 = Infinity;
      let e1 = -Infinity;
      let n0 = Infinity;
      let n1 = -Infinity;
      for (const s of site.structures) {
        const v = generateStructure(defs, site, s.model, s.params ?? {}, s, LEVEL_GROUND);
        const h = s.headingDeg * DEG;
        for (const m of Object.values(v.models)) {
          const p = m.lods[m.lods.length - 1]!.positions;
          for (let k = 0; k < p.length; k += 3) {
            const x = p[k]!;
            const z = p[k + 2]!;
            const ee = s.offsetEnu[0] + x * Math.cos(h) - z * Math.sin(h);
            const nn = s.offsetEnu[1] - x * Math.sin(h) - z * Math.cos(h);
            e0 = Math.min(e0, ee);
            e1 = Math.max(e1, ee);
            n0 = Math.min(n0, nn);
            n1 = Math.max(n1, nn);
          }
        }
      }
      const step = 5;
      const margin = 20;
      const east0 = Math.floor((e0 - margin) / step) * step;
      const north0 = Math.floor((n0 - margin) / step) * step;
      const nx = Math.ceil((e1 + margin - east0) / step) + 1;
      const ny = Math.ceil((n1 + margin - north0) / step) + 1;
      // Terrain at half-metre spacing over the grid and one step beyond it; a node carries the extremes within
      // one step of it, widened by what stones and hummocks smaller than the sampling can add (5 cm).
      const sub = 2;
      const W = ((nx - 1) * step + 2 * step) * sub + 1;
      const Hh = ((ny - 1) * step + 2 * step) * sub + 1;
      const fine = new Float32Array(W * Hh);
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) fine[j * W + i] = above(east0 - step + i / sub, north0 - step + j / sub);
      const hiCm: number[] = [];
      const loCm: number[] = [];
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let dj = 0; dj <= 2 * step * sub; dj++) {
            for (let di = 0; di <= 2 * step * sub; di++) {
              const h = fine[(j * step * sub + dj) * W + i * step * sub + di]!;
              lo = Math.min(lo, h);
              hi = Math.max(hi, h);
            }
          }
          hiCm.push(Math.ceil(hi * 100) + 5);
          loCm.push(Math.floor(lo * 100) - 5);
        }
      }
      const doc: { survey: SiteSurveyDef } = {
        survey: { source: `terrain provider (data/tiles), pad shape of ${site.id}; tools/vehicle/site-ground.ts survey`, step, east0, north0, nx, ny, hiCm, loCm },
      };
      // One line of the file per row of the grid.
      const NL = String.fromCharCode(10);
      const rows = (a: number[]): string => {
        const out: string[] = [];
        for (let j = 0; j < ny; j++) out.push(`      ${a.slice(j * nx, (j + 1) * nx).join(',')}`);
        return ['[', out.join(`,${NL}`), '    ]'].join(NL);
      };
      const s = doc.survey;
      const text = ['{', '  "survey": {', `    "source": ${JSON.stringify(s.source)},`, `    "step": ${s.step},`, `    "east0": ${s.east0},`, `    "north0": ${s.north0},`, `    "nx": ${s.nx},`, `    "ny": ${s.ny},`, `    "hiCm": ${rows(s.hiCm)},`, `    "loCm": ${rows(s.loCm)}`, '  }', '}', ''].join(NL);
      const file = path.resolve('data/defs', `${surveySectionOf(site.id)}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`site ${site.id}: survey ${nx} x ${ny} nodes at ${step} m from E ${east0} N ${north0}, terrain ${Math.min(...loCm) / 100} .. ${Math.max(...hiCm) / 100} m about the pad plane -> ${file} (${(text.length / 1024).toFixed(0)} KB)`);
      continue;
    }
    if (verify) {
      const s = siteSurvey(defs, site);
      if (!s) {
        console.log(`site ${site.id}: no survey in the library`);
        failed = true;
        continue;
      }
      const g = siteGround(defs, site);
      let worst = 0;
      let n = 0;
      for (let nn = s.north0; nn <= s.north0 + (s.ny - 1) * s.step; nn += 1.37) {
        for (let ee = s.east0; ee <= s.east0 + (s.nx - 1) * s.step; ee += 1.37) {
          const h = above(ee, nn);
          worst = Math.max(worst, h - g.hi(ee, -nn), g.lo(ee, -nn) - h);
          n++;
        }
      }
      console.log(`site ${site.id}: ${n} terrain samples against the survey, worst excess over its bounds ${worst.toFixed(3)} m`);
      if (worst > 0.01) failed = true;
      continue;
    }
    console.log(`site ${site.id}: pad elevation ${pad.toFixed(2)} m, terrain at the centre ${terrain.heightAt(site.bodyId, up).toFixed(2)} m, flat ${site.pad.flatRadius} m, blend ${site.pad.blendRadius} m`);
    if (radial) {
      for (let b = 0; b < 360; b += 45) {
        const row: string[] = [];
        for (const d of [50, 100, 140, 160, 200, 250, 300, 350, 400, 450, 500, 600, 750, 900]) row.push(`${d}:${above(Math.sin(b * DEG) * d, Math.cos(b * DEG) * d).toFixed(2)}`);
        console.log(`  bearing ${String(b).padStart(3)}  ${row.join('  ')}`);
      }
    }
    for (const s of site.structures) {
      const [e, n, u] = s.offsetEnu;
      const p = (s.params ?? {}) as Record<string, unknown>;
      const reach = Math.max(Number(p['radius'] ?? 0), Number(p['length'] ?? 0) / 2, Number(p['width'] ?? 0) / 2, Number(p['size'] ?? 0) / 2, 5);
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        for (const f of [0.5, 1]) {
          const h = above(e + Math.cos(a) * reach * f, n + Math.sin(a) * reach * f);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      console.log(`  ${s.model.padEnd(20)} at E ${e.toFixed(0).padStart(5)} N ${n.toFixed(0).padStart(5)} y ${u.toFixed(2).padStart(6)}  terrain ${above(e, n).toFixed(2).padStart(7)}  within ${reach.toFixed(0).padStart(4)} m: ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
    }
  }
  if (failed) {
    console.error('site ground: the survey in the library does not bound the terrain; run `site-ground.ts survey`');
    process.exitCode = 1;
  }
}

await main();
