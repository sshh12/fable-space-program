import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderFeature } from '@/core/contracts/render';
import type { TemporalFeature } from '@/render/core';
import { MEMBERS, timedFeature } from './featureTiming';

type Contract = RenderFeature & TemporalFeature;

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** A feature with every member of the contract; each function notes its call (name, `this`, arguments). */
function fullFeature(calls: { name: string; self: unknown; args: unknown[] }[]): Contract {
  const feature: Record<string, unknown> = {
    id: 'thing',
    order: 7,
    quality: { levels: ['low', 'high'] },
    requires: ['scene.colorCopy'],
    // Not part of the contract: a package's own handle (the terrain's `debug`, the cockpit's `displays`).
    debug: { secret: true },
  };
  for (const [name, how] of Object.entries(MEMBERS)) {
    if (how === 'value') continue;
    feature[name] = function (this: unknown, ...args: unknown[]): unknown {
      calls.push({ name, self: this, args });
      if (how === 'timed') now += 2;
      return name === 'isIdle' ? false : name === 'init' ? Promise.resolve('started') : undefined;
    };
  }
  return feature as unknown as Contract;
}

describe('timedFeature', () => {
  it('exposes exactly the members of the contract that the bare feature has', () => {
    const bare = fullFeature([]);
    const wrapped = timedFeature(bare, () => undefined) as unknown as Record<string, unknown>;
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(MEMBERS).sort());
    // Nothing of the package's own leaks through the stand-in.
    expect('debug' in wrapped).toBe(false);
    for (const [name, how] of Object.entries(MEMBERS)) {
      expect(typeof wrapped[name], name).toBe(how === 'value' ? typeof (bare as unknown as Record<string, unknown>)[name] : 'function');
    }
  });

  it('leaves out what the bare feature does not have', () => {
    const calls: { name: string; self: unknown; args: unknown[] }[] = [];
    const bare = { id: 'bare', init: () => calls.push({ name: 'init', self: null, args: [] }), drawGBuffer: () => undefined } as unknown as RenderFeature;
    const wrapped = timedFeature(bare, () => undefined) as unknown as Record<string, unknown>;
    expect(Object.keys(wrapped).sort()).toEqual(['drawGBuffer', 'id', 'init']);
    // The core asks `if (f.drawShadow)`, `f.isIdle ? ... : true`, `f.resetTemporal?.()`: all absent as on the bare feature.
    for (const name of Object.keys(MEMBERS)) expect(wrapped[name] === undefined, name).toBe((bare as unknown as Record<string, unknown>)[name] === undefined);
  });

  it('reads the values through, also when the feature changes them', () => {
    const bare = fullFeature([]) as unknown as { id: string; order: number; quality: unknown; requires: unknown };
    const wrapped = timedFeature(bare as unknown as RenderFeature, () => undefined);
    expect(wrapped.id).toBe('thing');
    expect(wrapped.order).toBe(7);
    expect(wrapped.requires).toBe(bare.requires);
    expect(wrapped.quality).toBe(bare.quality);
    bare.order = 9;
    expect(wrapped.order).toBe(9);
  });

  it('forwards every call to the feature itself with its arguments and its result', async () => {
    const calls: { name: string; self: unknown; args: unknown[] }[] = [];
    const bare = fullFeature(calls);
    const wrapped = timedFeature(bare, () => undefined) as Contract;
    const [frame, pass, cascade] = [{ f: 1 }, { p: 2 }, { c: 3 }];
    await expect(wrapped.init({ ctx: true } as never)).resolves.toBe('started');
    expect(wrapped.isIdle!()).toBe(false);
    wrapped.resetTemporal!();
    wrapped.drawShadow!(frame as never, pass as never, cascade as never);
    wrapped.dispose!();
    expect(calls.map((c) => c.name)).toEqual(['init', 'isIdle', 'resetTemporal', 'drawShadow', 'dispose']);
    for (const c of calls) expect(c.self, c.name).toBe(bare);
    expect(calls[0]!.args[0]).toEqual({ ctx: true });
    expect(calls[3]!.args.slice(0, 3)).toEqual([frame, pass, cascade]);
  });

  it('times the frame hooks, and only them, also when a hook throws', () => {
    const sunk: [string, string, number][] = [];
    const bare = fullFeature([]);
    const wrapped = timedFeature(bare, (id, key, ms) => sunk.push([id, key, ms])) as Contract;
    for (const [name, how] of Object.entries(MEMBERS)) if (how !== 'value') (wrapped as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!({}, {}, {});
    const hooks = Object.entries(MEMBERS)
      .filter(([, how]) => how === 'timed')
      .map(([name]) => name);
    expect(sunk.map(([, key]) => key)).toEqual(hooks.map((h) => `thing.${h}`));
    for (const [id, , ms] of sunk) {
      expect(id).toBe('thing');
      expect(ms).toBe(2);
    }
    const failing = timedFeature({ id: 'x', init: () => undefined, prepare: () => { now += 5; throw new Error('boom'); } } as unknown as RenderFeature, (id, key, ms) => sunk.push([id, key, ms]));
    expect(() => failing.prepare!({} as never)).toThrow('boom');
    expect(sunk[sunk.length - 1]).toEqual(['x', 'x.prepare', 5]);
  });
});
