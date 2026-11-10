/**
 * WGSL chunk registry: `#include "name"` expansion (each chunk at most once per module), compile-error
 * capture, and dependency tracking so that re-registering a chunk rebuilds the pipelines that include it.
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
  /** Number of modules whose compilation info has not arrived yet. */
  pendingCompilations(): number;
}

export function createShaderLibrary(device: GPUDevice, reportError: (message: string) => void): CoreShaderLibrary {
  const chunks = new Map<string, string>();
  const versions = new Map<string, number>();
  let pending = 0;
  let tracking: Set<string> | null = null;

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
      const module = device.createShaderModule({ label, code: expanded.code });
      pending++;
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
      const t = {
        generation: 0,
        get(): T {
          if (built) {
            let stale = false;
            for (const [n, v] of deps) if ((versions.get(n) ?? 0) !== v) stale = true;
            if (!stale) return value as T;
          }
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
      return t;
    },
    pendingCompilations: () => pending,
  };
  return lib;
}
