/**
 * What the package gives to everything drawn after it: transparents and half-resolution volumes that go
 * through the render core's applyAtmosphere() ('atmosphere.aerialPerspective', 'clouds.screen',
 * 'clouds.depth'). The lab draws bright emissive quads and a fog sphere through it.
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test } from '../harness';
import { luminance, openLab, PAD, setScene, settle, shot } from './lab';

const EV = 14.6;

type Quad = {
  id: string;
  kind: 'transparent' | 'opaque';
  place: { type: 'view'; ndc: [number, number]; distance: number } | { type: 'site'; enu: [number, number, number] };
  halfSize: number;
  luminance: [number, number, number];
  alpha?: number;
};

/** Luminance (cd/m^2, rgb) at the centre of each quad after a few settled frames. */
async function measure(page: Page, quads: Quad[], frames = 6): Promise<Record<string, [number, number, number]>> {
  return page.evaluate(
    async ({ q, n }) => {
      const lab = window.__atmo!;
      lab.setQuads(q);
      await window.__test!.waitFrames(n);
      const out: Record<string, [number, number, number]> = {};
      for (const quad of q) {
        const p = lab.quads.project(quad.id);
        if (p) out[quad.id] = await lab.probe(p.x, p.y, 2);
      }
      return out;
    },
    { q: quads, n: frames },
  );
}

/** Luminance at given NDC positions with nothing drawn. */
async function baseline(page: Page, ndcs: [number, number][]): Promise<[number, number, number][]> {
  return page.evaluate(async (list) => {
    const lab = window.__atmo!;
    lab.setQuads([]);
    lab.volume.set(null);
    await window.__test!.waitFrames(6);
    const [w, h] = lab.app.renderer.frameContext!.renderSize;
    const out: [number, number, number][] = [];
    for (const [x, y] of list) out.push(await lab.probe((x * 0.5 + 0.5) * w, (0.5 - y * 0.5) * h, 2));
    return out;
  }, ndcs);
}

/** Half-resolution cloud pixels whose whole neighbourhood is thick cloud, and whose whole neighbourhood is clear. */
async function findCloudAndGap(page: Page): Promise<{ thick: { ndc: [number, number]; begin: number; end: number } | null; gap: { ndc: [number, number] } | null }> {
  return page.evaluate(async () => {
    const b = await window.__atmo!.feature.debug.clouds()!.readBuffers();
    const pick = (ok: (t: number) => boolean): { x: number; y: number } | null => {
      let best: { x: number; y: number; d: number } | null = null;
      for (let y = 20; y < b.height - 20; y += 3) {
        for (let x = 20; x < b.width - 20; x += 3) {
          let all = true;
          for (let dy = -6; dy <= 6 && all; dy += 2) for (let dx = -6; dx <= 6 && all; dx += 2) all = ok(b.radiance[((y + dy) * b.width + x + dx) * 4 + 3]!);
          if (!all) continue;
          const d = Math.hypot(x - b.width / 2, y - b.height / 2);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      return best;
    };
    const ndc = (p: { x: number; y: number }): [number, number] => [((p.x + 0.5) / b.width) * 2 - 1, 1 - ((p.y + 0.5) / b.height) * 2];
    const t = pick((v) => v < 0.002);
    const g = pick((v) => v > 0.985);
    return {
      thick: t ? { ndc: ndc(t), begin: b.geometry[(t.y * b.width + t.x) * 4]!, end: b.geometry[(t.y * b.width + t.x) * 4 + 1]! } : null,
      gap: g ? { ndc: ndc(g) } : null,
    };
  });
}

const BRIGHT: [number, number, number] = [120000, 120000, 120000];
const visibility = (seen: [number, number, number], base: [number, number, number], emitted: number): number => (luminance(seen) - luminance(base)) / (emitted - luminance(base));

test.describe('transparents through applyAtmosphere', () => {
  test('a quad and a fog volume climbing through an overcast deck are hidden by it', async ({ page, pageLog }) => {
    await openLab(page, `cover=0.9,4&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 2, headingDeg: 0, pitchDeg: 40, fovDeg: 60 }, { azDeg: 160, elDeg: 55 });
    await settle(page, 40);
    const [base] = await baseline(page, [[0, 0]]);
    const geom = await page.evaluate(async () => {
      const b = await window.__atmo!.feature.debug.clouds()!.readBuffers();
      const o = ((b.height >> 1) * b.width + (b.width >> 1)) * 4;
      return { begin: b.geometry[o]!, end: b.geometry[o + 1]!, transmittance: b.radiance[o + 3]! };
    });
    console.log(`deck above the camera: begins ${geom.begin.toFixed(0)} m along the view ray, opaque by ${geom.end.toFixed(0)} m, transmittance ${geom.transmittance.toFixed(4)}; luminance ${luminance(base!).toFixed(0)} cd/m^2`);
    expect(geom.transmittance).toBeLessThan(0.01);
    // The cloud base is 1200 m up: 1870 m along a ray 40 degrees above the horizontal.
    expect(geom.begin).toBeGreaterThan(1500);
    expect(geom.begin).toBeLessThan(2300);
    const climb: string[] = [];
    let previous = 2;
    for (const f of [0.3, 0.6, 0.85, 1.0, 1.15, 1.6, 3, 5]) {
      const d = geom.begin * f;
      const seen = (await measure(page, [{ id: 'q', kind: 'transparent', place: { type: 'view', ndc: [0, 0], distance: d }, halfSize: d * 0.03, luminance: BRIGHT }]))['q']!;
      const v = visibility(seen, base!, BRIGHT[0]);
      climb.push(`${d.toFixed(0)} m: ${v.toFixed(3)}`);
      // In front of the deck: there. Behind it: gone. Never more visible farther up.
      if (f <= 0.85) expect(v, `quad at ${d.toFixed(0)} m`).toBeGreaterThan(0.85);
      if (f >= 1.6) expect(v, `quad at ${d.toFixed(0)} m`).toBeLessThan(0.02);
      expect(v).toBeLessThanOrEqual(previous + 0.02);
      previous = v;
      if (f === 0.6) await shot(page, 'transparent-quad-under-deck');
      if (f === 3) await shot(page, 'transparent-quad-above-deck-hidden');
    }
    console.log(`visibility of the climbing quad: ${climb.join(', ')}`);

    // The half-resolution fog volume, same path: under the base (600 m up), then above the deck (6 km up).
    const fog = async (up: number, radius: number): Promise<number> => {
      const seen = await page.evaluate(
        async ({ up: u, radius: r }) => {
          const lab = window.__atmo!;
          lab.setQuads([]);
          lab.volume.set({ enu: [0, u / Math.tan((40 * Math.PI) / 180), u], radius: r, luminance: [60000, 60000, 60000], density: 6 / r });
          await window.__test!.waitFrames(8);
          const p = lab.volume.project()!;
          return lab.probe(p.x, p.y, 2);
        },
        { up, radius },
      );
      return luminance(seen) / luminance(base!) - 1;
    };
    const under = await fog(600, 120);
    await shot(page, 'transparent-volume-under-deck');
    const above = await fog(6000, 1200);
    console.log(`fog volume: ${(under * 100).toFixed(1)} % brighter than the deck under it, ${(above * 100).toFixed(2)} % above it`);
    expect(under).toBeGreaterThan(0.5);
    expect(Math.abs(above)).toBeLessThan(0.02);
    await expectNoErrors(page, pageLog);
  });

  test('above a broken layer a quad is hidden behind the clouds and reappears in the gaps', async ({ page, pageLog }) => {
    await openLab(page, `cover=0.4,3&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 2, headingDeg: 35, pitchDeg: 45, fovDeg: 70 }, { azDeg: 160, elDeg: 55 });
    await settle(page, 40);
    const found = await findCloudAndGap(page);
    expect(found.thick, 'a thick cloud in view').not.toBeNull();
    expect(found.gap, 'a gap in view').not.toBeNull();
    const thick = found.thick!;
    const gap = found.gap!;
    const [baseThick, baseGap] = await baseline(page, [thick.ndc, gap.ndc]);
    const far = Math.max(thick.end * 1.6, 9000);
    const quads: Quad[] = [
      { id: 'behind', kind: 'transparent', place: { type: 'view', ndc: thick.ndc, distance: far }, halfSize: far * 0.012, luminance: BRIGHT },
      { id: 'gap', kind: 'transparent', place: { type: 'view', ndc: gap.ndc, distance: far }, halfSize: far * 0.012, luminance: BRIGHT },
    ];
    const seen = await measure(page, quads);
    await shot(page, 'transparent-quads-broken-layer');
    const vBehind = visibility(seen['behind']!, baseThick!, BRIGHT[0]);
    const vGap = visibility(seen['gap']!, baseGap!, BRIGHT[0]);
    const front = await measure(page, [{ id: 'front', kind: 'transparent', place: { type: 'view', ndc: thick.ndc, distance: thick.begin * 0.6 }, halfSize: thick.begin * 0.6 * 0.012, luminance: BRIGHT }]);
    const vFront = visibility(front['front']!, baseThick!, BRIGHT[0]);
    console.log(`cloud from ${thick.begin.toFixed(0)} to ${thick.end.toFixed(0)} m; quad at ${far.toFixed(0)} m: visibility ${vBehind.toFixed(3)} behind the cloud, ${vGap.toFixed(3)} in the gap; in front of the cloud ${vFront.toFixed(3)}`);
    expect(vBehind).toBeLessThan(0.02);
    expect(vGap).toBeGreaterThan(0.8);
    expect(vFront).toBeGreaterThan(0.85);
    await expectNoErrors(page, pageLog);
  });

  test('50 km away at low altitude: aerial perspective of a transparent quad matches the opaque scene within 5 %', async ({ page, pageLog }) => {
    await openLab(page, `clouds=0&relief=0&sky=0&ev=${EV}`);
    // Sun behind the camera: the two quads, left and right of the view axis, see the same phase angle.
    await setScene(page, { ...PAD, alt: 100, headingDeg: 90, pitchDeg: 0, fovDeg: 40 }, { azDeg: 270, elDeg: 40 });
    await settle(page, 12);
    const d = 50000;
    const rows: string[] = [];
    for (const [name, lum] of [
      ['dark', 0],
      ['bright', 20000],
    ] as const) {
      const quads: Quad[] = [
        { id: 't', kind: 'transparent', place: { type: 'view', ndc: [-0.3, 0.03], distance: d }, halfSize: 1500, luminance: [lum, lum, lum] },
        { id: 'o', kind: 'opaque', place: { type: 'view', ndc: [0.3, 0.03], distance: d }, halfSize: 1500, luminance: [lum, lum, lum] },
      ];
      const seen = await measure(page, quads, 10);
      if (lum > 0) await shot(page, 'transparent-vs-opaque-50km');
      const t = seen['t']!;
      const o = seen['o']!;
      rows.push(`${name}: transparent rgb ${t.map((v) => v.toFixed(0)).join(', ')} / opaque rgb ${o.map((v) => v.toFixed(0)).join(', ')} (ratio ${(luminance(t) / luminance(o)).toFixed(4)})`);
      // Luminance within 5 %. Per channel the in-scatter matches as well; the light of the surface itself is
      // dimmed by ONE transmittance for the three channels (the alpha of 'atmosphere.aerialPerspective'), so a
      // white emitter keeps its brightness but not the reddening of the opaque scene (see the hand-off).
      expect(luminance(t) / luminance(o), name).toBeGreaterThan(0.95);
      expect(luminance(t) / luminance(o), name).toBeLessThan(1.05);
      if (lum === 0) {
        for (let c = 0; c < 3; c++) expect(Math.abs(t[c]! / o[c]! - 1), `${name} channel ${c}`).toBeLessThan(0.05);
      }
      // And the haze is there at all: 50 km of air adds thousands of cd/m^2 and takes a third of the light.
      if (lum === 0) expect(luminance(o)).toBeGreaterThan(1500);
      else expect(luminance(o)).toBeLessThan(lum * 0.95 + 6000);
    }
    console.log(rows.join('\n'));
    await expectNoErrors(page, pageLog);
  });

  test('the aerial volume agrees with the per-pixel march at 20 froxels within 5 %', async ({ page, pageLog }) => {
    await openLab(page, `clouds=0&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 50, headingDeg: 60, pitchDeg: 12, fovDeg: 60 }, { azDeg: 200, elDeg: 35 });
    await settle(page, 12);
    // Texel centres of the volume: columns 4, 10, 16, 22, 28 of row 12 (above the horizon), four slices.
    const columns = [4, 10, 16, 22, 28];
    const row = 12;
    const slices = [10, 16, 20, 24];
    let worst = 0;
    const lines: string[] = [];
    for (const k of slices) {
      const distance = 50 * (2 ** ((k + 0.5) / 2) - 1);
      // In-scatter from black opaque quads, transmittance from emitting ones at the same places.
      const place = (i: number): Quad['place'] => ({ type: 'view', ndc: [((i + 0.5) / 32) * 2 - 1, 1 - ((row + 0.5) / 32) * 2], distance });
      const dark = await measure(page, columns.map((i) => ({ id: `c${i}`, kind: 'opaque' as const, place: place(i), halfSize: distance * 0.02, luminance: [0, 0, 0] as [number, number, number] })));
      const lit = await measure(page, columns.map((i) => ({ id: `c${i}`, kind: 'opaque' as const, place: place(i), halfSize: distance * 0.02, luminance: [30000, 30000, 30000] as [number, number, number] })));
      const table = await page.evaluate(
        async ({ k: slice, row: r, columns: cols }) => {
          const t = await window.__atmo!.feature.debug.readTable('aerial');
          return cols.map((i) => Array.from(t.data.subarray(((slice * t.height + r) * t.width + i) * 4, ((slice * t.height + r) * t.width + i) * 4 + 4)));
        },
        { k, row, columns },
      );
      columns.forEach((i, n) => {
        const march = dark[`c${i}`]!;
        const through = lit[`c${i}`]!;
        const volume = table[n]!;
        const marchT = (luminance(through) - luminance(march)) / 30000;
        const dL = Math.abs(luminance([volume[0]!, volume[1]!, volume[2]!]) / luminance(march) - 1);
        const dT = Math.abs(volume[3]! - marchT);
        worst = Math.max(worst, dL, dT);
        lines.push(`slice ${k} (${(distance / 1000).toFixed(1)} km) column ${i}: in-scatter volume ${luminance([volume[0]!, volume[1]!, volume[2]!]).toFixed(0)} / march ${luminance(march).toFixed(0)} cd/m^2, transmittance ${volume[3]!.toFixed(3)} / ${marchT.toFixed(3)}`);
        expect(dL, `in-scatter, slice ${k} column ${i}`).toBeLessThan(0.05);
        expect(dT, `transmittance, slice ${k} column ${i}`).toBeLessThan(0.05);
      });
    }
    console.log(lines.join('\n'));
    console.log(`worst difference over 20 froxels: ${(worst * 100).toFixed(2)} %`);
    await expectNoErrors(page, pageLog);
  });

  test('from orbit a quad below the cloud tops is covered by them', async ({ page, pageLog }) => {
    await openLab(page, `cover=1,6&relief=0&sky=0&ev=${EV}`);
    await setScene(page, { ...PAD, alt: 400000, headingDeg: 0, pitchDeg: -89.9, fovDeg: 40 }, { azDeg: 160, elDeg: 50 });
    await settle(page, 40);
    const [base] = await baseline(page, [[0, 0]]);
    const at = async (up: number): Promise<number> => {
      const seen = await measure(page, [{ id: 'q', kind: 'transparent', place: { type: 'site', enu: [0, 0, up] }, halfSize: 9000, luminance: BRIGHT }]);
      return visibility(seen['q']!, base!, BRIGHT[0]);
    };
    const below = await at(1000);
    await shot(page, 'transparent-quad-under-clouds-from-orbit');
    const justAbove = await at(15000);
    const above = await at(150000);
    await shot(page, 'transparent-quad-over-clouds-from-orbit');
    console.log(`from 400 km: quad 1 km up (cloud tops at 6 km) visibility ${below.toFixed(4)}; quad 150 km up ${above.toFixed(3)}; quad 15 km up ${justAbove.toFixed(3)}; cloud deck ${luminance(base!).toFixed(0)} cd/m^2`);
    expect(Math.abs(below)).toBeLessThan(0.02);
    expect(above).toBeGreaterThan(0.85);
    // 15 km up, 9 km above the tops and 385 km from the eye: in front of the cloud, and seen, now that
    // 'clouds.depth' carries where the cloud begins and ends (request atmosphere-clouds-1, resolved).
    expect(justAbove).toBeGreaterThan(0.85);
    await expectNoErrors(page, pageLog);
  });

  test('with no atmosphere in range the published buffers are neutral', async ({ page, pageLog }) => {
    await openLab(page, `relief=0&sky=0&ev=${EV}`);
    // In orbit, looking away from the planet: its shell is behind the camera and nothing is marched.
    await setScene(page, { ...PAD, alt: 400000, headingDeg: 20, pitchDeg: 80, fovDeg: 40 }, { azDeg: 200, elDeg: 50 });
    await settle(page, 8);
    const state = await page.evaluate(async () => {
      const lab = window.__atmo!;
      lab.setQuads([{ id: 'q', kind: 'transparent', place: { type: 'view', ndc: [0, 0], distance: 5000 }, halfSize: 500, luminance: [1000, 2000, 3000] }]);
      await window.__test!.waitFrames(6);
      const p = lab.quads.project('q')!;
      return { marched: lab.feature.debug.selection().bodies.length, seen: await lab.probe(p.x, p.y, 2) };
    });
    console.log(`no atmosphere in view: ${state.marched} bodies marched; quad of 1000, 2000, 3000 cd/m^2 reads ${state.seen.map((v) => v.toFixed(1)).join(', ')}`);
    expect(state.marched).toBe(0);
    // (Half-float target: three significant digits.)
    for (let c = 0; c < 3; c++) expect(Math.abs(state.seen[c]! / (1000 * (c + 1)) - 1)).toBeLessThan(0.002);
    await expectNoErrors(page, pageLog);
  });
});
