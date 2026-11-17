/**
 * The reads of one tile job, awaited together (tileWorker.ts): the heights and the bake, the image layers, the
 * night image. They are asked for in one turn and each can fail on its own (a tile that is not there, a short
 * read, an image that does not decode). `Promise.all` gives up at the first failure and drops what the other
 * reads deliver afterwards, or have delivered already: a decoded `ImageBitmap` among that is never closed,
 * and a bitmap is memory the garbage collector does not see until it is. `settleAll` waits for every read
 * and, when one failed, hands every value that did arrive to `release` before it throws.
 *
 * Pure: no worker and no bitmap type. The worker passes the function that closes a bitmap.
 */

/**
 * The values of `pending` in its order, when every one of them is fulfilled (a plain value passes through, as
 * in `Promise.all`). When any is rejected: every one is waited for, `release` is called once with each value
 * that was fulfilled, in the order of the list, and then the first rejection in that order is thrown.
 * `release` decides what holds a resource and frees it; it must not throw.
 */
export async function settleAll<T extends readonly unknown[] | []>(pending: T, release: (value: Awaited<T[number]>) => void): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled: readonly PromiseSettledResult<unknown>[] = await Promise.allSettled(pending);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed === undefined) return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
  for (const s of settled) if (s.status === 'fulfilled') release(s.value as Awaited<T[number]>);
  throw failed.reason;
}
