/**
 * Staging and shadows of the vessel and site features in the lab.
 *
 *  - A scripted staging sequence through the whole stage stack with public.ts `splitForStage` (the lab sim's
 *    `fireStage`): after every stage each separated piece is its own vessel and is drawn as its full model
 *    (the instance count of the whole scene does not drop), and expired debris fades out and is released.
 *  - Shadows: the vessel is a moving caster, so it is never submitted to a staggered cascade (counter), and
 *    the swing arms of the launch complex are moving casters only while they swing.
 */
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, test } from '../harness';
import { openLab, shot } from './lab';

test.describe('vehicle staging and shadows', () => {
  test.setTimeout(8 * 60_000);

  test('scripted staging sequence: separated pieces are full models, expired debris fades out', async ({ page, pageLog }) => {
    await openLab(page, 'scene=lowOrbit&planet=0&sunv=0.6,0.35,0.7&eye=75,-38,60&at=0,-46,0&fov=55');
    await assertDiscreteGpu(page);
    const start = await page.evaluate(async () => {
      const lab = window.__veh!;
      await window.__test!.waitFrames(8);
      return { labels: lab.sim.stageLabels, instances: lab.vehicle.stats.instances, vessels: lab.vehicle.stats.vessels, parts: lab.sim.partsOf(lab.sim.vesselIds[0]!).length };
    });
    expect(start.vessels).toBe(1);
    expect(start.labels.length).toBeGreaterThanOrEqual(6);
    await shot(page, 'staging-00-stack', 24);

    let instances = start.instances;
    let vessels = 1;
    let spawnedTotal = 0;
    for (let i = 0; i < start.labels.length; i++) {
      // Later stages are small: bring the camera in as the stack gets shorter.
      const step = await page.evaluate(async (index) => {
        const lab = window.__veh!;
        const fired = lab.sim.fireStage();
        // 1.5 s of drift: the pieces have come apart but are all still in view.
        for (let k = 0; k < 90; k++) lab.sim.advance(1 / 60);
        const ids = lab.sim.vesselIds;
        const main = lab.sim.partsOf(ids[0]!);
        const reach = Math.max(8, ...main.map((p) => Math.hypot(p.localPos.x, p.localPos.y, p.localPos.z))) + 6;
        lab.setView([reach * 0.95, -reach * 0.35, reach * 0.8], [0, -reach * 0.45, 0]);
        await window.__test!.waitFrames(8);
        return {
          index,
          stage: fired.stage,
          spawned: fired.spawned,
          ids,
          parts: ids.map((id) => lab.sim.partsOf(id).length),
          stats: { ...lab.vehicle.stats },
        };
      }, i);
      expect(step.stage).toBe(i);
      vessels += step.spawned.length;
      spawnedTotal += step.spawned.length;
      expect(step.ids.length).toBe(vessels);
      expect(step.stats.vessels).toBe(vessels);
      // Every part of every vessel is still drawn: nothing is replaced by a proxy or dropped at separation.
      // (A fairing is one part drawing N petals before the split and N one-petal vessels after it.)
      expect(step.stats.instances, `stage ${i} "${start.labels[i]}"`).toBe(instances);
      expect(step.stats.ghosts).toBe(0);
      for (const n of step.parts) expect(n).toBeGreaterThan(0);
      instances = step.stats.instances;
      console.log(`stage ${i} "${start.labels[i]}": +${step.spawned.length} vessel(s) [${step.spawned.join(', ')}], ${step.stats.vessels} vessels, ${step.stats.instances} instances, ${step.stats.triangles} triangles`);
      const s = await shot(page, `staging-${String(i + 1).padStart(2, '0')}-${start.labels[i]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, 24);
      assertRealImage(s.stats, `staging ${i}`, { minNonBlack: 0.01, minStd: 2, minBuckets: 12 });
    }
    expect(spawnedTotal).toBeGreaterThanOrEqual(6);

    // Expire one piece of debris as the simulation does: it fades out as a ghost, then its resources go.
    const fade = await page.evaluate(async () => {
      const lab = window.__veh!;
      const victim = lab.sim.vesselIds[1]!;
      const before = { ...lab.vehicle.stats };
      // The fade runs on presentation time, which the screenshots above froze.
      window.__test!.setDeterministic(false);
      lab.sim.expire(victim);
      await window.__test!.waitFrames(3);
      const during = { ...lab.vehicle.stats };
      let frames = 0;
      while (lab.vehicle.stats.ghosts > 0 && frames < 900) {
        await window.__test!.waitFrames(5);
        frames += 5;
      }
      return { victim, before, during, after: { ...lab.vehicle.stats }, frames };
    });
    expect(fade.during.ghosts).toBe(1);
    expect(fade.during.vessels).toBe(fade.before.vessels - 1);
    expect(fade.after.ghosts).toBe(0);
    expect(fade.after.instances).toBeLessThan(fade.before.instances);
    console.log(`expired ${fade.victim}: ghost for ${fade.frames} frames, instances ${fade.before.instances} -> ${fade.after.instances}`);
    await expectNoErrors(page, pageLog);
  });

  test('shadows: no vessel caster in a staggered cascade; swing arms are moving casters only while they swing', async ({ page, pageLog }) => {
    await openLab(page, 'scene=pad&sun=205,40&eye=60,-50,75&at=0,-50,0&fov=60');
    await assertDiscreteGpu(page);
    const res = await page.evaluate(async () => {
      const lab = window.__veh!;
      const site = lab.site!;
      await window.__test!.waitFrames(120);
      const atRest = { vehicle: { ...lab.vehicle.stats }, site: { ...site.stats }, state: { ...site.state('ka-lae-lc1')! } };
      // Ignition on the pad: the complex retracts its arms, as at lift-off. Watch them swing.
      lab.sim.setEngines(1);
      let movingMax = 0;
      let frames = 0;
      let seenMoving = false;
      for (; frames < 1800; frames += 2) {
        await window.__test!.waitFrames(2);
        movingMax = Math.max(movingMax, site.stats.movingInstances);
        if (site.stats.movingInstances > 0) seenMoving = true;
        else if (seenMoving) break;
      }
      await window.__test!.waitFrames(20);
      const retracted = { vehicle: { ...lab.vehicle.stats }, site: { ...site.stats }, state: { ...site.state('ka-lae-lc1')! } };
      return { atRest, retracted, movingMax, frames };
    });
    // The core offered staggered cascades to the feature, and the feature submitted nothing to them.
    expect(res.atRest.vehicle.staggeredCascades).toBeGreaterThan(0);
    expect(res.atRest.vehicle.everyFrameCascades).toBeGreaterThan(0);
    expect(res.atRest.vehicle.shadowTriangles).toBeGreaterThan(0);
    expect(res.atRest.vehicle.staggeredSubmissions).toBe(0);
    expect(res.retracted.vehicle.staggeredSubmissions).toBe(0);
    // The complex is static at rest, its arms move for a while, and it is static again afterwards.
    expect(res.atRest.site.movingInstances).toBe(0);
    expect(res.atRest.site.shadowTriangles).toBeGreaterThan(0);
    expect(res.atRest.state.arms).toBe(0);
    expect(res.movingMax).toBeGreaterThan(0);
    expect(res.retracted.site.movingInstances).toBe(0);
    expect(res.retracted.state.arms).toBe(1);
    expect(res.retracted.state.crewArm).toBe(1);
    console.log(`arms: up to ${res.movingMax} moving casters for about ${res.frames} frames; vessel shadow: ${res.atRest.vehicle.shadowTriangles} triangles, staggered cascades seen ${res.retracted.vehicle.staggeredCascades}, submitted to ${res.retracted.vehicle.staggeredSubmissions}`);
    const s = await shot(page, 'pad-arms-retracted');
    assertRealImage(s.stats, 'pad-arms-retracted', { minNonBlack: 0.5, minStd: 6, minBuckets: 30 });
    await expectNoErrors(page, pageLog);
  });
});
