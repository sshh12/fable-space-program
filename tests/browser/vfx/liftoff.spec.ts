/**
 * Lift-off: the jets of the booster must be in the picture from the first seconds on, not buried in the pad
 * cloud. Measured as the reviewer of the first build measured it: the scene is stopped, the engines are
 * switched off and on again, and the difference of the HDR target on the jet axis below the nozzles is what
 * the plume (and the smoke it lights in front of itself) adds to the picture, in cd/m^2.
 */
import { PNG } from 'pngjs';
import type {} from '../../../labs/vfx/main';
import { expect, expectNoErrors, saveScreenshot, test, waitIdle } from '../harness';
import { openLab, runAndSettle } from './helpers';

test.describe.configure({ timeout: 600_000 });

/** A sunlit white surface is about 30,000 cd/m^2: the jet must stand out against one. */
const VISIBLE = 30_000;
/**
 * ... and the flame itself is blinding: three stops and more over that surface, so that it clips at a daylight
 * exposure and blooms (critics of round 1: "no booster flame clips, by day or by night"; it read 0.2 to 0.3
 * million cd/m^2 then, about 2 million since round 2).
 */
const BLINDING = 8 * VISIBLE;

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
        expect(probe.near, `T+${T}: 12 m below the nozzles`).toBeGreaterThan(BLINDING);
        // Further down it is behind the launch mount until the vehicle has cleared it.
        if (T >= 4) expect(probe.far, `T+${T}: 30 m below the nozzles`).toBeGreaterThan(BLINDING);
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

/**
 * Straight level lines in a picture: for every row, the columns in which the luminance steps by more than
 * `threshold` (8-bit) from this row to the next AND by 2.5 times less on either side of that step (a one-pixel
 * edge, not a gradient). Returns the row with the most such columns, and the longest unbroken run of them.
 */
function levelLines(buffer: Buffer, threshold = 10): { row: number; columns: number; run: number } {
  const im = PNG.sync.read(buffer);
  const L = (x: number, y: number): number => {
    const a = (y * im.width + x) * 4;
    return 0.2126 * im.data[a]! + 0.7152 * im.data[a + 1]! + 0.0722 * im.data[a + 2]!;
  };
  let worst = { row: -1, columns: 0, run: 0 };
  for (let y = 2; y < im.height - 3; y++) {
    let run = 0;
    let longest = 0;
    let columns = 0;
    for (let x = 0; x < im.width; x++) {
      const d = Math.abs(L(x, y + 1) - L(x, y));
      const beside = Math.max(Math.abs(L(x, y) - L(x, y - 1)), Math.abs(L(x, y + 2) - L(x, y + 1)));
      if (d > threshold && d > 2.5 * beside) {
        run++;
        columns++;
        longest = Math.max(longest, run);
      } else run = 0;
    }
    if (columns > worst.columns) worst = { row: y, columns, run: longest };
  }
  return worst;
}

// The pad cloud ended on a ruler-straight, one-pixel-sharp line along the horizon (critics of round 2): the
// rows of rays next to the horizon were kept apart by the depth of the ground behind the cloud. Seen at night
// (the cloud is the only thing in the picture besides the vehicle) from the pad camera, whose eye is level
// with the top of the cloud at T+10 s, and from 26 m lower, where the body of the cloud crosses the horizon:
// no row of the picture holds a level edge. Before the fix the horizon row held 67 and 41 such columns.
test('the pad cloud has no level edge along the horizon', async ({ page, pageLog }) => {
  for (const cam of [
    { name: 'eye level with the top of the cloud', query: '', file: 'level' },
    { name: 'eye 26 m lower', query: '&pitch=-2', file: 'low' },
  ]) {
    // (From the south-south-east, 28 degrees off the trench: the view the edge was found in.)
    await openLab(page, `scene=pad&night=1&yaw=152${cam.query}`);
    await runAndSettle(page, 14);
    const shot = await saveScreenshot(page, 'vfx/liftoff-probe', `horizon-${cam.file}`);
    const lines = levelLines(shot.buffer);
    console.log(`pad cloud at T+10 s, ${cam.name}: most columns with a one-pixel level edge in one row: ${lines.columns} (row ${lines.row}, longest run ${lines.run})`);
    expect(lines.columns, `${cam.name}: columns of row ${lines.row} with a one-pixel level edge`).toBeLessThan(24);
    expect(lines.run, `${cam.name}: longest run of such columns in row ${lines.row}`).toBeLessThan(12);
  }
  await expectNoErrors(page, pageLog);
});
