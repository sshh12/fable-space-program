/**
 * What the calibration's shots need before it may start (ARCHITECTURE 23, 24, 29.2): the files each shot
 * reads from a cold page (tiles, sky data, cloud maps, models and textures), recorded on the reference
 * machine by tests/browser/bench/calibration.perf.spec.ts (`NEEDS_RECORD=1`: every request of the bench lab
 * while it opens and settles each shot, workers included) into `needs` of data/defs/render/quality.json. The
 * app streams them behind the title with `prefetchNeeds` (the boot pack and the deferred-load layout take
 * the same list) and the calibration starts only when `residentFor` says every one of them is in.
 */
export interface ShotNeeds {
  shotId: string;
  /** URL paths (no origin, no query) the shot fetched. */
  paths: string[];
  /** Their size, bytes. */
  bytes: number;
}

/** True when every path every shot needs is resident (`has`: the page's own test, e.g. a completed prefetch). */
export function residentFor(needs: readonly ShotNeeds[], has: (path: string) => boolean): boolean {
  return needs.length > 0 && needs.every((n) => n.paths.every(has));
}

/** The paths still missing, for the status line ("calibration data: 312 of 1,040 files"). */
export function missingFor(needs: readonly ShotNeeds[], has: (path: string) => boolean): string[] {
  const out = new Set<string>();
  for (const n of needs) for (const p of n.paths) if (!has(p)) out.add(p);
  return [...out];
}

/**
 * Fetch every needed path once, `concurrency` at a time, through the page's `fetcher` (true = the file is
 * in: fetched and kept by the page's cache or store). `done` is filled as files arrive, so `residentFor(needs,
 * (p) => done.has(p))` can be asked at any moment; the promise resolves when every path has been tried.
 */
export async function prefetchNeeds(
  needs: readonly ShotNeeds[],
  fetcher: (path: string) => Promise<boolean>,
  done: Set<string>,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ failed: string[] }> {
  const queue = [...new Set(needs.flatMap((n) => n.paths))].filter((p) => !done.has(p));
  const total = queue.length + done.size;
  const failed: string[] = [];
  const worker = async (): Promise<void> => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      let ok = false;
      try {
        ok = await fetcher(p);
      } catch {
        ok = false;
      }
      if (ok) done.add(p);
      else failed.push(p);
      opts.onProgress?.(done.size, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  return { failed };
}
