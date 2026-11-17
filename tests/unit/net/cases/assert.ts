/**
 * The assertions of the shared net cases: the same module runs under vitest in Node and in Chrome
 * (tests/browser/net), so it depends on neither. Numbers compare with Object.is (so -0 and +0 differ, as
 * bits do), typed arrays byte by byte, objects by their own keys.
 */

export class AssertionError extends Error {
  override name = 'AssertionError';
}

export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

/** The first difference between two values, as a path and a description; null when equal. */
export function diff(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${a} !== ${b}`;
  if (a === b) return null;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return `${path}: one is not a Uint8Array`;
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${path}[${i}]: ${a[i]} !== ${b[i]}`;
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: one is not an array`;
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join(',') !== kb.join(',')) return `${path}: keys [${ka.join(',')}] !== [${kb.join(',')}]`;
    for (const k of ka) {
      const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${String(a)} !== ${String(b)}`;
}

export function equal(a: unknown, b: unknown, msg = 'values differ'): void {
  const d = diff(a, b);
  if (d) throw new AssertionError(`${msg}: ${d}`);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array, msg = 'bytes differ'): void {
  equal(a, b, msg);
}

/** One shared case: a name and a body that throws on failure. */
export interface NetCase {
  name: string;
  run(): void | Promise<void>;
  /** Wall-time limit for runners that enforce one, ms. */
  timeoutMs?: number;
}
