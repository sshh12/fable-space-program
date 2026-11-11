/**
 * Lift-off: the jets of the booster must be in the picture from the first seconds on, not buried in the pad
 * cloud. Measured as the reviewer of the first build measured it: the scene is stopped, the engines are
 * switched off and on again, and the difference of the HDR target on the jet axis below the nozzles is what
 * the plume (and the smoke it lights in front of itself) adds to the picture, in cd/m^2.
 */
import type {} from '../../../labs/vfx/main';
import { expect, expectNoErrors, saveScreenshot, test, waitIdle } from '../harness';
import { openLab } from './helpers';

test.describe.configure({ timeout: 600_000 });

/** A sunlit white surface is about 30,000 cd/m^2: the jet must stand out against one. */
const VISIBLE = 30_000;

const CAMERAS = [
  { name: 'pad camera at 430 m', file: 'pad', query: '', follow: false },
  { name: 'chase camera at 150 m', file: 'chase', query: '&dist=150&pitch=4', follow: true },
];

interface Probe {
  /** Plume signal 12 m and 30 m below the nozzle exits, cd/m^2 (NaN: the point is outside the frame). */
  near: number;
  far: number;
  /** The same points with the engines off (smoke, sky or ground). */
  nearOff: number;
  farOff: number;
  nozzleHeight: number;
  ev100: number;
}

for (const night of [false, true]) {
  for (const cam of CAMERAS) {
    test(`lift-off ${night ? 'at night' : 'by day'}, ${cam.name}: the jets are in the picture from T+2 s to T+8 s`, async ({ page, pageLog }) => {
      await openLab(page, `scene=pad${night ? '&night=1' : ''}${cam.query}`);
      const rows: string[] = [];
      for (const T of [2, 4, 6, 8]) {
        await page.evaluate((t) => window.__vfx!.runTo(t), 4 + T);
        const probe: Probe = await page.evaluate(async (follow) => {
          const lab = window.__vfx!;
          const renderer = lab.app.renderer;
          const engines = lab.scene.controls!.engines!;
          const nozzle = lab.nozzleEnu('stack');
          if (follow) lab.setCamera({ target: { x: 0, y: 0, z: nozzle.z - 14 } });
          const read = async (below: number): Promise<number> => {
            const p = lab.project({ x: nozzle.x, y: nozzle.y, z: nozzle.z - below });
            const [w, h] = renderer.frameContext!.renderSize;
            if (!p || p.x < 3 || p.y < 3 || p.x > w - 4 || p.y > h - 4) return NaN;
            const px = await renderer.readHdrPixels('hdr', { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 });
            const lum: number[] = [];
            for (let i = 0; i < px.data.length; i += 4) lum.push(0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!);
            lum.sort((a, b) => a - b);
            const exposure = 1 / (1.2 * 2 ** renderer.exposureInfo().ev100);
            return lum[12]! / exposure;
          };
          engines(1);
          await lab.renderExact(3, false);
          const on = [await read(12), await read(30)];
          const ev100 = renderer.exposureInfo().ev100;
          engines(0);
          await lab.renderExact(3, false);
          const off = [await read(12), await read(30)];
          engines(1);
          await lab.renderExact(1, false);
          lab.resume();
          return { near: on[0]! - off[0]!, far: on[1]! - off[1]!, nearOff: off[0]!, farOff: off[1]!, nozzleHeight: nozzle.z, ev100 };
        }, cam.follow);
        rows.push(`T+${T}: nozzles ${probe.nozzleHeight.toFixed(0)} m up, EV100 ${probe.ev100.toFixed(1)}; 12 m below ${probe.near.toFixed(0)} (off ${probe.nearOff.toFixed(0)}), 30 m below ${probe.far.toFixed(0)} (off ${probe.farOff.toFixed(0)}) cd/m^2`);
        // Under the vehicle the flame is seen at every moment (the first metres below the nozzles are the
        // translucent core of the jets with its Mach discs, dim by day by design: the probe is in the flame).
        expect(probe.near, `T+${T}: 12 m below the nozzles`).toBeGreaterThan(VISIBLE);
        // Further down it is behind the launch mount until the vehicle has cleared it.
        if (T >= 4) expect(probe.far, `T+${T}: 30 m below the nozzles`).toBeGreaterThan(VISIBLE);
        if (T === 2 || T === 6) {
          await waitIdle(page, 30);
          await saveScreenshot(page, 'vfx/liftoff-probe', `${cam.file}-${night ? 'night' : 'day'}-T${T}`);
        }
      }
      console.log(`plume signal (engines on - off), ${night ? 'night' : 'day'}, ${cam.name}:\n  ${rows.join('\n  ')}`);
      await expectNoErrors(page, pageLog);
    });
  }
}
