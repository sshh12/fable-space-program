/**
 * The menu store fixture against the session contract (session.ts, the visible launch queue), and the shell's
 * spawn flow over it: the queue's place and estimate, leaving it, another offer while waiting, a stale entry
 * while reconnecting, a place lost to a takeover, a refusal with an alternative, a held acknowledgement.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SpawnRequest } from '@/core/contracts/session';
import { padOf, padsOf } from '@/core/defs/sites';
import { createMenuFixture, menuShipsFixture } from '@/core/fakes/menuStores';
import { createSpawnFlow, formatEstimate, ordinal } from '@/shell/spawnFlow';
import { loadLibrary } from '../../../tools/sim/realWorld';

let defs: DefLibrary;
let request: SpawnRequest;
beforeAll(async () => {
  defs = await loadLibrary();
  const site = Object.values(defs.sites)[0]!;
  request = { vehicleId: Object.keys(defs.vehicles)[0]!, site: site.id, pad: padOf(site).id, slot: { kind: 'live' }, name: 'Test 1' };
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the menu fixture', () => {
  it('states every pad of every site of the library, from the site files', () => {
    const f = createMenuFixture(defs, { padLoad: 'busy' });
    const pads = f.stores.pads.get();
    const expected = Object.values(defs.sites).reduce((n, s) => n + padsOf(s).length, 0);
    expect(pads).toHaveLength(expected);
    for (const p of pads) expect(padsOf(defs.sites[p.siteId]!).some((d) => d.id === p.padId && d.class === p.class)).toBe(true);
  });

  it('seats a spawn when a pad is free, after the acknowledgement delay', async () => {
    const f = createMenuFixture(defs, { padLoad: 'free', ackDelaySeconds: 5 });
    let result: unknown = null;
    void f.universe.spawn(request).then((r) => (result = r));
    f.advance(4);
    await flush();
    expect(result).toBeNull();
    expect(f.stores.launchQueue.get()).toBeNull();
    f.advance(1);
    await flush();
    expect(result).toMatchObject({ ok: true });
  });

  it('a full class queues: the place moves up, the estimate follows it, the request is seated after place 1', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full', queueStart: 3, queueStepSeconds: 30 });
    let result: unknown = null;
    void f.universe.spawn(request).then((r) => (result = r));
    const first = f.stores.launchQueue.get()!;
    expect(first.position).toBe(3);
    expect(first.etaSeconds).toBe(90);
    expect(first.request).toEqual(request);
    expect(first.padClass).toBe(padOf(defs.sites[request.site]!, request.pad).class);
    f.advance(30);
    expect(f.stores.launchQueue.get()!.position).toBe(2);
    f.advance(60);
    await flush();
    expect(result).toMatchObject({ ok: true });
    expect(f.stores.launchQueue.get()).toBeNull();
  });

  it('cancelSpawn leaves the queue; with nothing waiting it says so', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full' });
    expect((await f.universe.cancelSpawn()).ok).toBe(false);
    const p = f.universe.spawn(request);
    expect((await f.universe.cancelSpawn()).ok).toBe(true);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(f.stores.launchQueue.get()).toBeNull();
  });

  it('ships name a vehicle of the library and carry their expiry', () => {
    const ships = menuShipsFixture(defs, 1_800_000_000_000);
    expect(ships.length).toBeGreaterThan(0);
    for (const s of ships) {
      expect(defs.vehicles[s.vehicleId]).toBeDefined();
      expect(defs.bodies[s.bodyId]).toBeDefined();
    }
  });
});

describe('the spawn flow over the fixture', () => {
  it('shows the queue, leaves it, and says the player left', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full' });
    const flow = createSpawnFlow(f.universe, f.stores);
    void flow.spawn(request);
    expect(flow.phase().kind).toBe('queued');
    await flow.leaveQueue();
    await flush();
    const p = flow.phase();
    expect(p.kind).toBe('refused');
    expect(p.kind === 'refused' && p.cause).toBe('left');
  });

  it('marks the entry stale while reconnecting and keeps the place on resume', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full', queueStart: 4 });
    const flow = createSpawnFlow(f.universe, f.stores);
    void flow.spawn(request);
    f.setLink('reconnecting');
    let p = flow.phase();
    expect(p.kind === 'queued' && p.stale).toBe(true);
    f.advance(600);
    p = flow.phase();
    expect(p.kind === 'queued' && p.entry.position).toBe(4);
    f.setLink('online');
    p = flow.phase();
    expect(p.kind === 'queued' && !p.stale && p.entry.position).toBe(4);
  });

  it('a takeover loses the place and explains it', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full' });
    const flow = createSpawnFlow(f.universe, f.stores);
    void flow.spawn(request);
    f.setLink('takenOver');
    await flush();
    const p = flow.phase();
    expect(p.kind === 'refused' && p.cause).toBe('lost');
    expect(p.kind === 'refused' && p.reason).toContain('place in the launch queue is gone');
  });

  it('another offer while waiting is leaving and spawning again', async () => {
    const f = createMenuFixture(defs, { padLoad: 'full' });
    const flow = createSpawnFlow(f.universe, f.stores);
    void flow.spawn(request);
    const cohort: SpawnRequest = { ...request, slot: { kind: 'cohort', tick: 36000 } };
    const next = flow.choose(cohort);
    await flush();
    f.advance(1);
    const r = await next;
    expect(r.ok).toBe(true);
    expect(f.requests.map((q) => q.slot.kind)).toEqual(['live', 'cohort']);
  });

  it('a refusal carries the alternative', async () => {
    const f = createMenuFixture(defs, { padLoad: 'free' });
    f.refuseNext('The pad was taken a moment before you.', { site: request.site, pad: request.pad });
    const flow = createSpawnFlow(f.universe, f.stores);
    await flow.spawn(request);
    const p = flow.phase();
    expect(p.kind === 'refused' && p.cause).toBe('refused');
    expect(p.kind === 'refused' && p.alternative).toMatchObject({ site: request.site, pad: request.pad });
  });

  it('words the estimate as an estimate and the place as an ordinal', () => {
    expect(formatEstimate(30)).toBe('under a minute');
    expect(formatEstimate(240)).toBe('about 4 min');
    expect(formatEstimate(4800)).toBe('about 1 h 20 min');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 214].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '214th']);
  });
});
