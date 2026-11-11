import type { Page } from "@playwright/test";
import { PNG } from "pngjs";
import {
  assertRealImage,
  expect,
  saveScreenshot,
  test,
  waitIdle,
} from "../harness";
import {
  expectClean,
  openIntegration,
  requireFeatures,
} from "../integration/helpers";

/**
 * The sky with the real Earth (request sky-lighting-5; both visual critics of round 1): the integration lab of
 * core-support (labs/integration: terrain, ocean, atmosphere and clouds, vehicle, sky, every package present),
 * driven from here, at the settled AUTOMATIC exposure. The sky lab's stand-in Earth has no atmosphere; these
 * are the views the flare, the probe's lighting and the night sky are judged on.
 *
 *   integration-sun-above-limb     low orbit, the sun 6 deg above the limb (its line of sight passes 130 km up:
 *                                  no extinction yet), the limb in the lower part of the frame
 *   integration-sun-at-limb        the sun 0.3 deg above the limb: seen through the atmosphere, dimmed and reddened
 *   integration-hull-over-earth    the vehicle in daylight over the Earth, the sun behind the camera's shoulder:
 *                                  its Earth-facing side lit by the probe, its space-facing side dark
 *   integration-leo-night          the night side, looking along the Milky Way above the limb
 */
test.describe.configure({ timeout: 900_000 });

interface V {
  x: number;
  y: number;
  z: number;
}

/** Page-side helpers: the sub-vessel site, a free camera from a forward / up pair, projection of a direction. */
async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sub = (a: V, b: V): V => ({
      x: a.x - b.x,
      y: a.y - b.y,
      z: a.z - b.z,
    });
    const add = (a: V, b: V, s = 1): V => ({
      x: a.x + s * b.x,
      y: a.y + s * b.y,
      z: a.z + s * b.z,
    });
    const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const cross = (a: V, b: V): V => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    });
    const norm = (a: V): V => {
      const l = Math.hypot(a.x, a.y, a.z);
      return { x: a.x / l, y: a.y / l, z: a.z / l };
    };
    type Q = { x: number; y: number; z: number; w: number };
    const rotate = (q: Q, v: V): V => {
      // v + 2 w (q x v) + 2 q x (q x v)
      const t = cross(q, v);
      const t2 = { x: 2 * t.x, y: 2 * t.y, z: 2 * t.z };
      return add(add(v, t2, q.w), cross(q, t2));
    };
    const conj = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
    /** Rotation taking view axes (x right, y up, z back) to ROOT: columns right, up, -forward (lab lookRotation). */
    const lookQuat = (forward: V, upHint: V): Q => {
      const f = norm(forward);
      const r = norm(cross(f, upHint));
      const u = cross(r, f);
      const b = { x: -f.x, y: -f.y, z: -f.z };
      const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = [
        r.x,
        r.y,
        r.z,
        u.x,
        u.y,
        u.z,
        b.x,
        b.y,
        b.z,
      ];
      const tr = m00 + m11 + m22;
      if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        return {
          w: 0.25 * s,
          x: (m21 - m12) / s,
          y: (m02 - m20) / s,
          z: (m10 - m01) / s,
        };
      }
      if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return {
          w: (m21 - m12) / s,
          x: 0.25 * s,
          y: (m01 + m10) / s,
          z: (m02 + m20) / s,
        };
      }
      if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return {
          w: (m02 - m20) / s,
          x: (m01 + m10) / s,
          y: 0.25 * s,
          z: (m12 + m21) / s,
        };
      }
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      return {
        w: (m10 - m01) / s,
        x: (m02 + m20) / s,
        y: (m12 + m21) / s,
        z: 0.25 * s,
      };
    };
    let cam: { q: Q; fovY: number } | null = null;
    const w = window as unknown as Record<string, unknown>;
    w.__skyInt = {
      /** The active vessel, its body, the local vertical, the body's radius and the vessel's altitude. */
      frame() {
        const lab = window.__lab!;
        const s = lab.snapshot();
        const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
        const b = s.bodies.find((x) => x.id === v.bodyId)!;
        const up = norm(sub(v.rRoot, b.rRoot));
        const radius = lab.defs.bodies[v.bodyId]!.radius;
        const r = sub(v.rRoot, b.rRoot);
        return {
          pos: v.rRoot,
          up,
          bodyId: v.bodyId,
          radius,
          altitude: Math.hypot(r.x, r.y, r.z) - radius,
          q: b.qFixedToRoot,
        };
      },
      /** The body-fixed point under the active vessel (a Site of the integration lab). */
      siteUnder() {
        const f = (
          w.__skyInt as { frame(): { up: V; bodyId: string; q: Q } }
        ).frame();
        const d = rotate(conj(f.q), f.up);
        return {
          bodyId: f.bodyId,
          latDeg: (Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180) / Math.PI,
          lonDeg: (Math.atan2(d.y, d.x) * 180) / Math.PI,
          alt: 0,
        };
      },
      look(pos: V, forward: V, up: V, fovDeg: number) {
        const lab = window.__lab!;
        cam = { q: lookQuat(forward, up), fovY: (fovDeg * Math.PI) / 180 };
        lab.camera.settings.kind = "external";
        lab.camera.settings.fovY = cam.fovY;
        lab.camera.spec = {
          type: "free",
          positionRoot: pos,
          qViewToRoot: cam.q,
        };
      },
      /** Display pixel of a ROOT direction in the last `look` (null behind the camera). */
      project(d: V) {
        if (!cam) return null;
        const v = rotate(conj(cam.q), d);
        if (v.z >= 0) return null;
        const [w0, h0] = window.__lab!.renderer.frameContext!.displaySize;
        const tanY = Math.tan(cam.fovY / 2);
        const tanX = (tanY * w0) / h0;
        return {
          x: ((v.x / -v.z / tanX + 1) / 2) * w0,
          y: ((1 - v.y / -v.z / tanY) / 2) * h0,
        };
      },
      helpers: { add, sub, dot, cross, norm, rotate },
    };
  });
}

/** Horizon dip (deg) of the vessel's body seen from the vessel. */
const dipOf = (f: { radius: number; altitude: number }): number =>
  (Math.acos(f.radius / (f.radius + f.altitude)) * 180) / Math.PI;

async function settledExposure(page: Page): Promise<number> {
  await page.waitForFunction(
    () => {
      const e = window.__lab!.renderer.exposureInfo();
      return Math.abs(e.ev100 - e.targetEv100) < 0.02;
    },
    undefined,
    { timeout: 240_000 },
  );
  return page.evaluate(() => window.__lab!.renderer.exposureInfo().ev100);
}

async function settle(page: Page, frames = 90): Promise<void> {
  await waitIdle(page, 8, 400_000);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

type SkyHandle = {
  status(): { flareDrawn: boolean };
  readFlareState(): Promise<{
    visible: number;
    cloud: number;
    inView: number;
    hood: number;
    transmittance: number[];
  }>;
};
const flareState = (page: Page) =>
  page.evaluate(async () => {
    const sky = window.__integration!.handles[
      "sky.createSkyFeature"
    ] as SkyHandle;
    return { drawn: sky.status().flareDrawn, ...(await sky.readFlareState()) };
  });

/**
 * Sun `aboveLimbDeg` over the limb, straight ahead; camera 40 m to the side of the vessel (it is out of the frame),
 * looking `belowSunDeg` under the sun with the horizon level.
 */
async function sunOverLimb(
  page: Page,
  aboveLimbDeg: number,
  belowSunDeg: number,
  fovDeg: number,
): Promise<{ dip: number }> {
  const f = await page.evaluate(() =>
    (
      window as unknown as {
        __skyInt: { frame(): { radius: number; altitude: number } };
      }
    ).__skyInt.frame(),
  );
  const dip = dipOf(f);
  await page.evaluate(
    ([el]) => {
      const h = (
        window as unknown as {
          __skyInt: {
            siteUnder(): {
              bodyId: string;
              latDeg: number;
              lonDeg: number;
              alt: number;
            };
          };
        }
      ).__skyInt;
      window.__integration!.setSun(h.siteUnder(), 90, el!);
    },
    [-dip + aboveLimbDeg],
  );
  await page.evaluate(() => window.__test!.waitFrames(2));
  await page.evaluate(
    ([below, fov]) => {
      type H = {
        frame(): { pos: V; up: V };
        look(p: V, f: V, u: V, fov: number): void;
        helpers: {
          add(a: V, b: V, s?: number): V;
          norm(a: V): V;
          cross(a: V, b: V): V;
          dot(a: V, b: V): number;
        };
      };
      const h = (window as unknown as { __skyInt: H }).__skyInt;
      const fr = h.frame();
      const sun = window.__lab!.renderer.frameContext!.sun.dirRoot;
      // The sun's direction tilted down by `below` degrees in the vertical plane through it.
      const horiz = h.helpers.norm(
        h.helpers.add(sun, fr.up, -h.helpers.dot(sun, fr.up)),
      );
      const side = h.helpers.norm(h.helpers.cross(horiz, fr.up));
      const elSun = Math.asin(h.helpers.dot(sun, fr.up));
      const el = elSun - (below! * Math.PI) / 180;
      const fwd = h.helpers.add(
        {
          x: horiz.x * Math.cos(el),
          y: horiz.y * Math.cos(el),
          z: horiz.z * Math.cos(el),
        },
        fr.up,
        Math.sin(el),
      );
      h.look(h.helpers.add(fr.pos, side, 40), fwd, fr.up, fov!);
    },
    [belowSunDeg, fovDeg],
  );
  return { dip };
}

/** Rows and columns of a frame: the largest step of a row's (column's) mean against the mean of its neighbours. */
function lineStructure(
  png: PNG,
  skip: (x: number, y: number) => boolean,
): number {
  const luma = (x: number, y: number): number => {
    const i = (y * png.width + x) * 4;
    return (
      0.2126 * png.data[i]! +
      0.7152 * png.data[i + 1]! +
      0.0722 * png.data[i + 2]!
    );
  };
  const rows: number[] = [];
  for (let y = 0; y < png.height; y++) {
    let s = 0;
    let n = 0;
    for (let x = 0; x < png.width; x++) {
      if (skip(x, y)) continue;
      s += luma(x, y);
      n++;
    }
    rows.push(n > png.width / 4 ? s / n : NaN);
  }
  let worst = 0;
  for (let y = 1; y < rows.length - 1; y++) {
    if (![rows[y - 1], rows[y], rows[y + 1]].every((v) => Number.isFinite(v)))
      continue;
    worst = Math.max(
      worst,
      Math.abs(rows[y]! - 0.5 * (rows[y - 1]! + rows[y + 1]!)),
    );
  }
  return worst;
}

test("the sun over the real limb from low orbit: 6 deg above it, and rising through the atmosphere", async ({
  page,
  pageLog,
}) => {
  const info = await openIntegration(page, "scene=lowOrbit&hud=0");
  requireFeatures(test, info, ["sky", "atmosphere", "terrain"]);
  await installHelpers(page);
  await page.evaluate(() => window.__lab!.setPaused(true));

  // (1) 6 deg above the limb: the line of sight passes ~130 km up, outside the air: an unattenuated flare over the
  // blue limb arc and the lit cloud field towards the sun.
  const { dip } = await sunOverLimb(page, 6, 8, 60);
  await settle(page, 150);
  const ev = await settledExposure(page);
  await settle(page, 60);
  const shot = await saveScreenshot(page, "sky", "integration-sun-above-limb");
  const st = await flareState(page);
  const sunPx = await page.evaluate(() =>
    (
      window as unknown as {
        __skyInt: { project(d: V): { x: number; y: number } | null };
      }
    ).__skyInt.project(window.__lab!.renderer.frameContext!.sun.dirRoot),
  );
  console.log(
    `sun 6 deg above the limb (dip ${dip.toFixed(2)} deg): EV100 ${ev.toFixed(2)}, flare drawn ${st.drawn}, visible ${st.visible.toFixed(3)}, transmittance ${st.transmittance.map((t) => t.toFixed(3)).join(" / ")}, sun at ${sunPx ? `${sunPx.x.toFixed(0)}, ${sunPx.y.toFixed(0)}` : "-"}`,
  );
  assertRealImage(shot.stats, "integration-sun-above-limb", {
    minNonBlack: 0.05,
    minStd: 5,
    minBuckets: 30,
  });
  expect(st.drawn).toBe(true);
  expect(st.visible).toBe(1);
  // No row / column structure further than 10 deg from the sun (the frame's 60 deg are 720 rows: 10 deg = 124 px).
  const png = PNG.sync.read(shot.buffer);
  const near = (x: number, y: number): boolean =>
    !!sunPx && Math.hypot(x - sunPx.x, y - sunPx.y) < 124;
  const rowsStep = lineStructure(png, near);
  console.log(
    `largest row step against its neighbours further than 10 deg from the sun: ${rowsStep.toFixed(2)}/255`,
  );
  expect(rowsStep).toBeLessThan(2);

  // (2) 0.3 deg above the limb: the sun seen through the air is dimmed and reddened, and so is its flare.
  await sunOverLimb(page, 0.3, 5, 40);
  await settle(page, 150);
  const ev2 = await settledExposure(page);
  await settle(page, 60);
  await saveScreenshot(page, "sky", "integration-sun-at-limb");
  const st2 = await flareState(page);
  console.log(
    `sun 0.3 deg above the limb: EV100 ${ev2.toFixed(2)}, flare drawn ${st2.drawn}, visible ${st2.visible.toFixed(3)}, transmittance ${st2.transmittance.map((t) => t.toFixed(3)).join(" / ")}`,
  );
  expect(st2.drawn).toBe(true);
  expect(st2.transmittance[2]!).toBeLessThan(0.9 * st2.transmittance[0]!);
  expect(st2.transmittance[0]!).toBeLessThan(1);
  await expectClean(page, pageLog, info);
});

test("the vehicle over the real Earth in daylight: lit from below by the probe, dark towards space", async ({
  page,
  pageLog,
}) => {
  const info = await openIntegration(page, "scene=lowOrbit&hud=0");
  requireFeatures(test, info, ["sky", "atmosphere", "terrain", "vehicle"]);
  await installHelpers(page);
  await page.evaluate(() => window.__lab!.setPaused(true));
  // Sun 40 deg up behind the camera's shoulder; the camera looks down at the vehicle with the Earth behind it.
  await page.evaluate(() => {
    const h = (
      window as unknown as {
        __skyInt: {
          siteUnder(): {
            bodyId: string;
            latDeg: number;
            lonDeg: number;
            alt: number;
          };
        };
      }
    ).__skyInt;
    window.__integration!.setSun(h.siteUnder(), 120, 40);
    window.__integration!.watchVesselFromSunSide(38, 30);
  });
  await settle(page, 150);
  const ev = await settledExposure(page);
  await settle(page, 60);
  const shot = await saveScreenshot(page, "sky", "integration-hull-over-earth");
  console.log(
    `vehicle over the Earth by day: EV100 ${ev.toFixed(2)}, mean level ${shot.stats.meanLuma.toFixed(1)}/255`,
  );
  assertRealImage(shot.stats, "integration-hull-over-earth", {
    minNonBlack: 0.2,
    minStd: 10,
    minBuckets: 40,
  });
  await expectClean(page, pageLog, info);
});

for (const variant of ["moonless", "moonlit"] as const) {
  test(`the night side of a low orbit (${variant}): the Milky Way above the real limb at the automatic exposure`, async ({
    page,
    pageLog,
  }) => {
    const info = await openIntegration(page, "scene=lowOrbit&hud=0");
    requireFeatures(test, info, ["sky", "atmosphere", "terrain"]);
    await installHelpers(page);
    await page.evaluate(() => window.__lab!.setPaused(true));
    // The Moon stays where the FakeSim has it; the sun is put deep in the vessel's shadow. Moonless: the sun 25 deg
    // under the horizon at the Moon's azimuth (the Moon, if it is up at all, is then a thin crescent near the sun:
    // about 2 % of full moonlight); moonlit: the sun under the opposite horizon (a nearly full Moon, if it is up).
    const moon = await page.evaluate((v) => {
      type H = {
        frame(): { pos: V; up: V };
        helpers: {
          add(a: V, b: V, s?: number): V;
          norm(a: V): V;
          cross(a: V, b: V): V;
          dot(a: V, b: V): number;
          rotate(q: { x: number; y: number; z: number; w: number }, a: V): V;
        };
      };
      const h = (window as unknown as { __skyInt: H }).__skyInt;
      const s = window.__lab!.snapshot();
      const ves = s.vessels.find((x) => x.id === s.activeVesselId)!;
      const fr = h.frame();
      const m = s.bodies.find((b) => b.id === "moon");
      const md = m
        ? h.helpers.norm(h.helpers.add(m.rRoot, ves.rRoot, -1))
        : h.helpers.norm(h.helpers.cross(fr.up, { x: 0, y: 0, z: 1 }));
      const horiz = h.helpers.norm(
        h.helpers.add(md, fr.up, -h.helpers.dot(md, fr.up)),
      );
      const D = Math.PI / 180;
      const el = -25 * D;
      const toward =
        v === "moonless" ? horiz : { x: -horiz.x, y: -horiz.y, z: -horiz.z };
      const sun = h.helpers.add(
        {
          x: toward.x * Math.cos(el),
          y: toward.y * Math.cos(el),
          z: toward.z * Math.cos(el),
        },
        fr.up,
        Math.sin(el),
      );
      // In the vessel's frame (VES axes): q rotates VES to ROOT.
      const q = ves.q;
      window.__integration!.setSunInVesselFrame(
        h.helpers.rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, sun),
      );
      return {
        elevation: (Math.asin(h.helpers.dot(md, fr.up)) * 180) / Math.PI,
        phase: (Math.acos(-h.helpers.dot(md, sun)) * 180) / Math.PI,
      };
    }, variant);
    console.log(
      `${variant}: the Moon ${moon.elevation.toFixed(1)} deg above the vessel's horizon, phase angle ${moon.phase.toFixed(0)} deg`,
    );
    if (variant === "moonlit" && moon.elevation < 2) {
      console.log(
        "the Moon is below the horizon in this scene: no moonlit view",
      );
      return;
    }
    // The point of the galactic equator nearest the centre that stands 15 deg above the horizon, looked at from 40 m
    // beside the vessel with the horizon level and the limb in the lower third.
    const target = await page.evaluate(() => {
      type H = {
        frame(): { pos: V; up: V };
        look(p: V, f: V, u: V, fov: number): void;
        helpers: {
          add(a: V, b: V, s?: number): V;
          norm(a: V): V;
          cross(a: V, b: V): V;
          dot(a: V, b: V): number;
        };
      };
      const h = (window as unknown as { __skyInt: H }).__skyInt;
      const D = Math.PI / 180;
      const radec = (ra: number, dec: number): V => ({
        x: Math.cos(dec * D) * Math.cos(ra * D),
        y: Math.cos(dec * D) * Math.sin(ra * D),
        z: Math.sin(dec * D),
      });
      const gc = radec(266.40499, -28.93617);
      const ngp = radec(192.85948, 27.12825);
      const b = h.helpers.cross(ngp, gc);
      const fr = h.frame();
      let best = { score: Infinity, p: gc, l: 0, el: 0 };
      for (let t = -180; t < 180; t += 1) {
        const p = h.helpers.add(
          {
            x: gc.x * Math.cos(t * D),
            y: gc.y * Math.cos(t * D),
            z: gc.z * Math.cos(t * D),
          },
          b,
          Math.sin(t * D),
        );
        const el = Math.asin(h.helpers.dot(p, fr.up)) / D;
        const score = Math.abs(el - 15) + 0.02 * Math.abs(t);
        if (score < best.score) best = { score, p, l: t, el };
      }
      const horiz = h.helpers.norm(
        h.helpers.add(best.p, fr.up, -h.helpers.dot(best.p, fr.up)),
      );
      const side = h.helpers.norm(h.helpers.cross(horiz, fr.up));
      const el = 6 * D;
      h.look(
        h.helpers.add(fr.pos, side, 40),
        h.helpers.add(
          {
            x: horiz.x * Math.cos(el),
            y: horiz.y * Math.cos(el),
            z: horiz.z * Math.cos(el),
          },
          fr.up,
          Math.sin(el),
        ),
        fr.up,
        70,
      );
      return { dir: best.p, longitude: best.l, elevation: best.el };
    });
    await settle(page, 150);
    const ev = await settledExposure(page);
    await settle(page, 90);
    const shot = await saveScreenshot(
      page,
      "sky",
      variant === "moonless"
        ? "integration-leo-night"
        : "integration-leo-night-moonlit",
    );
    const px = await page.evaluate(
      (d) =>
        (
          window as unknown as {
            __skyInt: { project(d: V): { x: number; y: number } | null };
          }
        ).__skyInt.project(d),
      target.dir,
    );
    const png = PNG.sync.read(shot.buffer);
    const windowMean = (cx: number, cy: number, r: number): number => {
      let s = 0;
      let n = 0;
      for (
        let y = Math.max(0, Math.round(cy - r));
        y < Math.min(png.height, Math.round(cy + r));
        y++
      ) {
        for (
          let x = Math.max(0, Math.round(cx - r));
          x < Math.min(png.width, Math.round(cx + r));
          x++
        ) {
          const i = (y * png.width + x) * 4;
          s +=
            0.2126 * png.data[i]! +
            0.7152 * png.data[i + 1]! +
            0.0722 * png.data[i + 2]!;
          n++;
        }
      }
      return s / Math.max(n, 1);
    };
    const band = px ? windowMean(px.x, px.y, 30) : 0;
    console.log(
      `LEO night (${variant}): EV100 ${ev.toFixed(2)}; galactic longitude ${target.longitude} deg at ${target.elevation.toFixed(1)} deg elevation, at pixel ${px ? `${px.x.toFixed(0)}, ${px.y.toFixed(0)}` : "-"}: mean ${band.toFixed(1)}/255 over 60 px`,
    );
    expect(px).not.toBeNull();
    if (variant === "moonless") {
      expect(ev).toBeLessThan(-4);
      expect(band).toBeGreaterThanOrEqual(12);
    }
    await expectClean(page, pageLog, info);
  });
}
