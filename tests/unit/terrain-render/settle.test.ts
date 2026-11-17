/**
 * `settleAll` (src/render/terrain/settle.ts), the step of a tile job that waits for all of its reads: when one
 * fails, what the others decoded is released before the failure is reported. The tile worker has no harness;
 * this is the part of it that decides whether a decoded bitmap is ever closed.
 */
import { describe, expect, it } from 'vitest';
import { settleAll } from '@/render/terrain/settle';

/** Stands for a decoded bitmap: it counts how often it was closed. */
class Bitmap {
  closed = 0;
  constructor(readonly name: string) {}
  close(): void {
    this.closed++;
  }
}

/** What the worker passes: close what is a bitmap, leave everything else (bakes, byte arrays, null). */
const closeBitmap = (value: unknown): void => {
  if (value instanceof Bitmap) value.close();
};

const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const failLater = (ms: number, message: string): Promise<never> => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

describe('the reads of a tile job, settled together', () => {
  it('are their values in order when all arrive, with nothing released', async () => {
    const albedo = new Bitmap('albedo');
    const night = new Uint8Array(4);
    const released: unknown[] = [];
    const [bake, image, water, none, dark] = await settleAll([later(5, { heights: 1 }), later(1, albedo), Promise.resolve(undefined), null, night], (v) => released.push(v));
    expect(bake).toEqual({ heights: 1 });
    expect(image).toBe(albedo);
    expect(water).toBeUndefined();
    expect(none).toBeNull();
    expect(dark).toBe(night);
    expect(released).toEqual([]);
    expect(albedo.closed).toBe(0);
  });

  it('close the bitmap that was decoded before another read failed', async () => {
    const albedo = new Bitmap('albedo');
    await expect(settleAll([failLater(5, 'bake failed'), Promise.resolve(albedo), null], closeBitmap)).rejects.toThrow('bake failed');
    expect(albedo.closed).toBe(1);
  });

  it('close the bitmap that is decoded after another read has failed already: the failure is not reported before every read is in', async () => {
    const albedo = new Bitmap('albedo');
    let reported = false;
    const job = settleAll([Promise.reject(new Error('bake failed')), later(20, albedo)], closeBitmap).catch((e: unknown) => {
      reported = true;
      throw e;
    });
    // With Promise.all the failure is out at once and the bitmap that arrives 20 ms later belongs to nobody.
    await later(5, null);
    expect(reported).toBe(false);
    expect(albedo.closed).toBe(0);
    await expect(job).rejects.toThrow('bake failed');
    expect(albedo.closed).toBe(1);
  });

  it('release every value that arrived, once each and in order, and throw the first failure of the list', async () => {
    const a = new Bitmap('a');
    const b = new Bitmap('b');
    const bytes = new Uint8Array(2);
    const released: unknown[] = [];
    const release = (v: unknown): void => {
      released.push(v);
      closeBitmap(v);
    };
    // The second failure of the list arrives first in time: the list's order decides which is reported.
    await expect(settleAll([later(8, a), failLater(10, 'first in the list'), bytes, failLater(1, 'second in the list'), later(3, b), null], release)).rejects.toThrow('first in the list');
    expect(released).toEqual([a, bytes, b, null]);
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
  });

  it('throw what was thrown, whatever it is', async () => {
    const reason = { code: 404 };
    await expect(settleAll([Promise.reject(reason)], closeBitmap)).rejects.toBe(reason);
  });
});
