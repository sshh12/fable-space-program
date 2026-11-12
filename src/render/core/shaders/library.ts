/**
 * WGSL chunk registry: `#include "name"` expansion (each chunk at most once per module), compile-error
 * capture, dependency tracking so that re-registering a chunk rebuilds the pipelines that include it, and
 * `warm`: the pipelines of tracked builds created ahead, off the main thread.
 */
import type { ShaderLibrary } from '@/core/contracts/render';

export interface ExpandResult {
  code: string;
  /** Names of every chunk pulled in, in inclusion order. */
  includes: string[];
}

const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm;

/** Pure include expansion (unit-tested without a GPU). Throws on unknown chunks. */
export function expandIncludes(source: string, chunks: ReadonlyMap<string, string>, label = 'shader'): ExpandResult {
  const included: string[] = [];
  const seen = new Set<string>();
  const expand = (text: string, stack: string[]): string =>
    text.replace(INCLUDE_RE, (_m, name: string) => {
      if (seen.has(name)) return `// (already included: ${name})`;
      const chunk = chunks.get(name);
      if (chunk === undefined) throw new Error(`${label}: unknown shader chunk "${name}"${stack.length ? ` (included from ${stack.join(' > ')})` : ''}`);
      seen.add(name);
      included.push(name);
      return `// ---- begin chunk ${name}\n${expand(chunk, [...stack, name])}\n// ---- end chunk ${name}`;
    });
  return { code: expand(source, []), includes: included };
}

/** A lazily (re)built value that depends on shader chunks: rebuilt when any chunk it included is replaced. */
export interface Tracked<T> {
  get(): T;
  /** Changes whenever the value was rebuilt (lets owners rebuild bind groups that reference layouts). */
  readonly generation: number;
}

export interface CoreShaderLibrary extends ShaderLibrary {
  has(name: string): boolean;
  /** Monotonic version of one chunk (0 = never registered). */
  chunkVersion(name: string): number;
  /** Expanded source of a module (for diagnostics and tests). */
  expand(label: string, wgsl: string): ExpandResult;
  /**
   * Build something from shader modules (typically a pipeline) and rebuild it automatically when a chunk
   * that any `createModule` call inside `build` included is registered again.
   */
  tracked<T>(build: () => T): Tracked<T>;
  /**
   * Shader work that is outstanding: modules whose compilation info has not arrived yet, and pipelines that
   * `warm` is creating (with the `warm` calls that have not built their items yet). 0 = nothing is compiling.
   */
  pendingCompilations(): number;
  /** The same with the number of modules and pipelines started so far, for a progress display (request app-integration-11). */
  compilations(): { pending: number; total: number };
  /**
   * Create the pipelines of these tracked items ahead, off the main thread, and then build the items
   * (request app-integration-11). `await shaders.warm([a, b, c])` stands where `a.get(); b.get(); c.get();`
   * stood at the end of an `init`: the items are built when it resolves, and what `get()` returns is what it
   * would have returned without it.
   *
   * How: each item's build is run once without keeping its result, with the device's `createRenderPipeline`
   * and `createComputePipeline` replaced for the length of that call by functions that start
   * `create...PipelineAsync` with the same descriptor; when those have resolved (all items' pipelines compile
   * in parallel on the browser's worker threads while the main thread is free), every item is built by its
   * ordinary `get()`, whose synchronous creations the device answers from its pipeline cache. A build must
   * therefore be repeatable, which it already is: it runs again whenever one of its chunks is replaced. A
   * build that reads from a pipeline it has just created (`getBindGroupLayout`) is run again once that
   * pipeline exists, as often as it takes; so is a build one of whose chunks was replaced while its
   * pipelines were being created (another feature's `init` ran meanwhile): the pipelines of the new source
   * are created ahead as well. An item that is built already costs nothing; a creation that fails
   * asynchronously is left to `get()`, which reports it as it always did; on a device without the
   * asynchronous calls `warm` is the plain `get()`s.
   *
   * Not awaited, the call starts the creations and the items are built when they are there; an owner that
   * calls `get()` earlier (a frame is rendered first) builds synchronously, as without `warm`.
   */
  warm(items: readonly Tracked<unknown>[]): Promise<void>;
  /** Resolves when every `warm` started so far has finished, whether it succeeded or not. */
  warmed(): Promise<void>;
  /** Pipelines `warm` is creating now and has started creating so far, for a progress display. */
  warming(): { pending: number; total: number };
}

/** Thrown by the stand-in for a pipeline that `warm` has started and a build reads from before it exists. */
const NOT_CREATED_YET = Symbol('pipeline not created yet');

/** Stands for a pipeline whose asynchronous creation is running: it can be passed around, not read. */
function standIn(): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'symbol') return undefined;
        throw NOT_CREATED_YET;
      },
    },
  );
}

/**
 * A build is run again after the pipelines it found have been created at most this often (a pipeline read by
 * its own build, a chunk replaced meanwhile); after that `get()` builds what is missing synchronously.
 */
const WARM_ROUNDS = 8;

type AnyPipeline = GPURenderPipeline | GPUComputePipeline;
interface WarmEntry {
  promise: Promise<void>;
  pipeline: AnyPipeline | null;
}
/** What `warm` knows of one tracked item. */
interface Item {
  build: () => unknown;
  /** Built and none of its chunks replaced since. */
  current: () => boolean;
}
interface DryRun {
  entries: WarmEntry[];
  index: number;
  started: number;
}
/** One item of a `warm` call: the pipelines found for it, and the chunk versions they were found with. */
interface WarmWork {
  item: Item;
  entries: WarmEntry[];
  deps: Map<string, number>;
  done: boolean;
}

export interface ShaderLibraryOptions {
  /** False: `warm` creates nothing ahead, it is the plain `get()`s (RendererOptions.pipelineWarm). Default true. */
  warm?: boolean;
}

export function createShaderLibrary(device: GPUDevice, reportError: (message: string) => void, options: ShaderLibraryOptions = {}): CoreShaderLibrary {
  const chunks = new Map<string, string>();
  const versions = new Map<string, number>();
  let pending = 0;
  let total = 0;
  let tracking: Set<string> | null = null;

  const items = new WeakMap<object, Item>();
  /** Set while a build runs for `warm` only: nothing it makes is kept. */
  let dry: DryRun | null = null;
  /** `warm` calls in flight; while there are any, a module of the same label and source is created once. */
  let warms = 0;
  const warmModules = new Map<string, GPUShaderModule>();
  let warmPending = 0;
  let warmTotal = 0;
  let allWarm: Promise<void> = Promise.resolve();

  /**
   * Run the item's build with the device's synchronous pipeline creation replaced; returns how many
   * asynchronous creations it started, and notes the chunks the build included with their versions.
   */
  const dryRun = (w: WarmWork): number => {
    const state: DryRun = { entries: w.entries, index: 0, started: 0 };
    const patched = device as unknown as Record<string, unknown>;
    const intercept = <D>(create: (descriptor: D) => Promise<AnyPipeline>) => (descriptor: D): unknown => {
      const known = state.entries[state.index++];
      if (known) return known.pipeline ?? standIn();
      const entry: WarmEntry = { promise: Promise.resolve(), pipeline: null };
      warmPending++;
      warmTotal++;
      entry.promise = create(descriptor).then(
        (p) => {
          warmPending--;
          entry.pipeline = p;
        },
        () => {
          // Left to the synchronous creation in get(), which reports the error where it always was reported.
          warmPending--;
        },
      );
      state.entries.push(entry);
      state.started++;
      return standIn();
    };
    const names = ['createRenderPipeline', 'createComputePipeline'] as const;
    const saved = names.map((n) => Object.getOwnPropertyDescriptor(device, n));
    patched.createRenderPipeline = intercept((d: GPURenderPipelineDescriptor) => device.createRenderPipelineAsync(d));
    patched.createComputePipeline = intercept((d: GPUComputePipelineDescriptor) => device.createComputePipelineAsync(d));
    const outerTracking = tracking;
    const included = new Set<string>();
    tracking = included;
    dry = state;
    try {
      w.item.build();
    } catch {
      // A pipeline that does not exist yet was read (the next round has it), or the build itself failed
      // (get() will throw the same error where the owner expects it).
    } finally {
      dry = null;
      tracking = outerTracking;
      names.forEach((n, i) => {
        const d = saved[i];
        if (d) Object.defineProperty(device, n, d);
        else delete patched[n];
      });
    }
    w.deps = new Map([...included].map((n) => [n, versions.get(n) ?? 0]));
    return state.started;
  };

  const lib: CoreShaderLibrary = {
    register(name, wgsl) {
      chunks.set(name, wgsl);
      versions.set(name, (versions.get(name) ?? 0) + 1);
    },
    has: (name) => chunks.has(name),
    chunkVersion: (name) => versions.get(name) ?? 0,
    expand: (label, wgsl) => expandIncludes(wgsl, chunks, label),
    createModule(label, wgsl) {
      let expanded: ExpandResult;
      try {
        expanded = expandIncludes(wgsl, chunks, label);
      } catch (e) {
        reportError(`shader ${label}: ${(e as Error).message}`);
        expanded = { code: '', includes: [] };
      }
      if (tracking) for (const n of expanded.includes) tracking.add(n);
      // During a warm the same module is asked for twice (the run that finds the pipelines, then get()):
      // one module, one compilation, one report of its errors.
      const key = warms > 0 ? `${label}\n${expanded.code}` : null;
      const known = key === null ? undefined : warmModules.get(key);
      if (known) return known;
      const module = device.createShaderModule({ label, code: expanded.code });
      if (key !== null) warmModules.set(key, module);
      pending++;
      total++;
      module.getCompilationInfo().then(
        (info) => {
          pending--;
          const lines = expanded.code.split('\n');
          for (const m of info.messages) {
            if (m.type !== 'error') continue;
            const src = lines[m.lineNum - 1]?.trim() ?? '';
            reportError(`shader compile error in ${label}:${m.lineNum}:${m.linePos}: ${m.message}  >>  ${src}`);
          }
        },
        () => {
          pending--;
        },
      );
      return module;
    },
    tracked<T>(build: () => T): Tracked<T> {
      let value: T | undefined;
      let built = false;
      let deps = new Map<string, number>();
      const current = (): boolean => {
        if (!built) return false;
        for (const [n, v] of deps) if ((versions.get(n) ?? 0) !== v) return false;
        return true;
      };
      const t = {
        generation: 0,
        get(): T {
          if (current()) return value as T;
          // Inside another item's run for `warm`: its pipelines belong to that run, nothing is kept here.
          if (dry) return build();
          const outer = tracking;
          const mine = new Set<string>();
          tracking = mine;
          try {
            value = build();
          } finally {
            tracking = outer;
          }
          if (outer) for (const n of mine) outer.add(n);
          deps = new Map([...mine].map((n) => [n, versions.get(n) ?? 0]));
          built = true;
          t.generation++;
          return value as T;
        },
      };
      items.set(t, { build, current });
      return t;
    },
    pendingCompilations: () => pending + Math.max(warmPending, warms > 0 ? 1 : 0),
    compilations: () => ({ pending: pending + Math.max(warmPending, warms > 0 ? 1 : 0), total: total + warmTotal }),
    warm(list) {
      const run = (async (): Promise<void> => {
        warms++;
        try {
          const canWarm = options.warm !== false && typeof device.createRenderPipelineAsync === 'function' && typeof device.createComputePipelineAsync === 'function';
          const work: WarmWork[] = [];
          for (const t of list) {
            const item = items.get(t);
            if (canWarm && item && !item.current()) work.push({ item, entries: [], deps: new Map(), done: false });
          }
          for (let round = 0; round < WARM_ROUNDS; round++) {
            let started = 0;
            for (const w of work) {
              // Built meanwhile by its owner (a frame was rendered): nothing left to find.
              if (w.item.current()) continue;
              // A chunk of the build was replaced while its pipelines were being created: those are of the
              // old source, find the ones of the new.
              let replaced = false;
              for (const [n, v] of w.deps) if ((versions.get(n) ?? 0) !== v) replaced = true;
              if (replaced) {
                w.entries = [];
                w.done = false;
              }
              if (w.done) continue;
              const n = dryRun(w);
              if (n === 0) w.done = true;
              started += n;
            }
            if (started === 0) break;
            await Promise.all(work.flatMap((w) => w.entries.map((e) => e.promise)));
          }
          // The pipelines exist: the ordinary builds find them in the device's cache, which holds a pipeline
          // only while something refers to it - `work` does until the builds have run.
          for (const t of list) t.get();
          work.length = 0;
        } finally {
          warms--;
          if (warms === 0) warmModules.clear();
        }
      })();
      allWarm = Promise.allSettled([allWarm, run]).then(() => undefined);
      return run;
    },
    warmed: () => allWarm,
    warming: () => ({ pending: warmPending, total: warmTotal }),
  };
  return lib;
}
