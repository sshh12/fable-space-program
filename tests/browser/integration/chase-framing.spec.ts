/**
 * The default chase view of the game from low orbit to deep space and back (request app-integration-10): the
 * body of the vessel's sphere of influence is in the frame below the vehicle, the sun is behind the camera, and
 * the vehicle is seen from a distance that fits what is left of it. The app at its QA scenarios, nothing
 * touched by the player; pictures in out/screens/core-support/chase-<scenario>.png (looked at).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/chase-framing.spec.ts --project=functional
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';
import { repoRoot } from './helpers';

test.setTimeout(10 * 60_000);

interface Framing {
  bodyId: string;
  /** Angles from the view axis, degrees: the body's centre, its near and far limb; its angular radius. */
  centre: number;
  near: number;
  far: number;
  radius: number;
  below: boolean;
  /** Angle of the body's centre right of and above the view axis, degrees (negative: left, below). */
  right: number;
  up: number;
  /** Angle of the sun from the view axis, degrees. */
  sun: number;
  /** Camera distance from the vessel's centre of mass and the vessel's bounding radius, m. */
  distance: number;
  boundingRadius: number;
  fovY: number;
  altitudeKm: number;
}

/** Radius of every body of the definitions, m. */
function bodyRadii(): Record<string, number> {
  const dir = path.join(repoRoot, 'data', 'defs', 'bodies');
  const out: Record<string, number> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { id: string; radius: number };
    out[def.id] = def.radius;
  }
  return out;
}

async function framing(page: Page): Promise<Framing> {
  return page.evaluate((radii) => {
    const s = window.__test!.state()!;
    const c = window.__test!.camera()!;
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    const radius = radii[v.bodyId]!;
    const rot = (q: { x: number; y: number; z: number; w: number }, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      // v' = v + 2 q.w (q x v) + 2 q x (q x v)
      const cx = q.y * p.z - q.z * p.y;
      const cy = q.z * p.x - q.x * p.z;
      const cz = q.x * p.y - q.y * p.x;
      return { x: p.x + 2 * (q.w * cx + q.y * cz - q.z * cy), y: p.y + 2 * (q.w * cy + q.z * cx - q.x * cz), z: p.z + 2 * (q.w * cz + q.x * cy - q.y * cx) };
    };
    const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { x: number; y: number; z: number } => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const len = (a: { x: number; y: number; z: number }): number => Math.hypot(a.x, a.y, a.z);
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const deg = 180 / Math.PI;
    const forward = rot(c.qViewToRoot, { x: 0, y: 0, z: -1 });
    const up = rot(c.qViewToRoot, { x: 0, y: 1, z: 0 });
    const right = rot(c.qViewToRoot, { x: 1, y: 0, z: 0 });
    const to = sub(body.rRoot, c.positionRoot);
    const d = len(to);
    const centre = Math.acos(Math.max(-1, Math.min(1, dot(to, forward) / d))) * deg;
    const ang = Math.asin(Math.min(1, radius / d)) * deg;
    const com = (() => {
      const o = rot(v.q, v.comLocal);
      return { x: v.rRoot.x + o.x, y: v.rRoot.y + o.y, z: v.rRoot.z + o.z };
    })();
    return {
      bodyId: v.bodyId,
      centre,
      near: centre - ang,
      far: centre + ang,
      radius: ang,
      below: dot(to, up) < 0,
      right: Math.asin(Math.max(-1, Math.min(1, dot(to, right) / d))) * deg,
      up: Math.asin(Math.max(-1, Math.min(1, dot(to, up) / d))) * deg,
      sun: Math.acos(Math.max(-1, Math.min(1, dot(body.sunDir, forward)))) * deg,
      distance: len(sub(c.positionRoot, com)),
      boundingRadius: v.boundingRadius,
      fovY: c.fovY * deg,
      altitudeKm: s.readouts.altitudeAsl / 1000,
    };
  }, bodyRadii());
}

const SCENARIOS = ['qa-leo', 'qa-translunar', 'qa-lunar-orbit', 'qa-trans-earth', 'qa-entry'] as const;

for (const scenario of SCENARIOS) {
  test(`${scenario}: the default chase view has the body in the frame, the sun behind the camera and the vehicle near`, async ({ page, pageLog }) => {
    await openPage(page, `/?scenario=${scenario}&capture=0&mute=1`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000, polling: 200 });
    await page.evaluate(() => window.__test!.waitFrames(120));
    const f = await framing(page);
    await saveScreenshot(page, 'core-support', `chase-${scenario}`);
    console.log(`  ${scenario}: ${f.bodyId} at ${f.altitudeKm.toFixed(0)} km, angular radius ${f.radius.toFixed(1)} deg, limb ${f.near.toFixed(1)}..${f.far.toFixed(1)} deg from the axis (half field ${(f.fovY / 2).toFixed(1)}), centre ${f.right.toFixed(1)} deg right and ${f.up.toFixed(1)} deg up, below ${f.below}; sun ${f.sun.toFixed(0)} deg from the axis; camera ${f.distance.toFixed(1)} m from a vessel of bounding radius ${f.boundingRadius.toFixed(1)} m`);
    const half = f.fovY / 2;
    expect(f.below, 'the body is below the vehicle in the frame').toBe(true);
    expect(f.near, 'near limb, degrees from the view axis').toBeLessThan(0.75 * half);
    if (f.radius < 6) {
      // A small disc: whole in the frame and beside the vehicle to the lower left, clear of the instruments in the
      // bottom middle of the HUD (it was hidden behind the navball when it stood straight below the vehicle).
      expect(-f.up + f.radius, 'lower edge of the disc, degrees below the axis').toBeLessThan(half);
      expect(f.right + f.radius, 'right edge of the disc, degrees right of the axis').toBeLessThan(-8);
      expect(f.near, 'the disc clears the middle of the frame').toBeGreaterThan(0.5 * half);
    }
    // Half the diagonal of the 16:9 frame is 48 degrees; the sun is at least 25 degrees outside it.
    expect(f.sun, 'sun, degrees from the view axis').toBeGreaterThan(48 + 25);
    // The vehicle is not a speck: the camera is within a few radii of what is left of it.
    expect(f.distance).toBeLessThanOrEqual(Math.max(8.5, 3.3 * 2 * f.boundingRadius));
    await expectNoErrors(page, pageLog);
  });
}
