/**
 * A small schema language for the wire codec: one description of a type gives its encoder, its decoder
 * (bounded, never throwing: failures go to the reader's typed error) and a seeded generator of random valid
 * instances (the round-trip and fuzz suites). The low-rate messages are described with it; the high-rate
 * island messages are hand-written codecs with the same `Codec` shape (island.ts).
 *
 * Layout rules: a struct is its fields in declaration order, preceded by a presence bit set when it has
 * optional (`?:`) fields; a union is a u8 variant index (declaration order: never reorder, append only)
 * followed by the variant's fields; `nullable` is a u8 flag; arrays and strings are varint-counted.
 */
import { WIRE_RANGES } from '@/core/contracts/net';
import { Prng } from '@/core/math/hash';
import { ByteReader, ByteWriter, MAX_VARINT_SIGNED, WireEncodeError, utf8Length } from './bytes';

/** Source of random valid values for the generators (seeded, deterministic). */
export class Gen {
  readonly prng: Prng;
  /** Nesting depth of arrays (generators keep nested arrays short). */
  depth = 0;
  constructor(seed: number) {
    this.prng = new Prng(seed);
  }
  next(): number {
    return this.prng.next();
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.prng.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.prng.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.prng.next() * xs.length)]!;
  }
  /** Uniform safe integer in [0, max] (max <= 2^53 - 1). */
  safeInt(max: number): number {
    if (max < 4294967296) return Math.floor(this.prng.next() * (max + 1));
    const hi = Math.floor(this.prng.next() * (Math.floor(max / 4294967296) + 1));
    const lo = this.prng.nextU32();
    const v = hi * 4294967296 + lo;
    return v > max ? v % (max + 1) : v;
  }
  /** A finite float64 from a spread of magnitudes, both zeros, subnormals and integers included. */
  f64(): number {
    switch (this.int(0, 7)) {
      case 0:
        return this.pick([0, -0, 1, -1, 0.5, Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, 2 ** 53, 1e-300]);
      case 1:
        return this.int(-1000, 1000);
      case 2:
        return (this.next() - 0.5) * 2000;
      case 3:
      case 4: {
        // Random exponent and mantissa: every finite magnitude class.
        const m = 1 + this.next();
        const e = this.int(-1074, 1023);
        const v = m * 2 ** e;
        const s = this.chance(0.5) ? -v : v;
        return Number.isFinite(s) ? s : 1e308;
      }
      default:
        return (this.next() - 0.5) * 10 ** this.int(-6, 12);
    }
  }
  /** A finite float32 value. */
  f32(): number {
    for (;;) {
      const v = Math.fround(this.chance(0.5) ? this.f64() : (this.next() - 0.5) * 10 ** this.int(-4, 8));
      if (Number.isFinite(v)) return v;
    }
  }
  /** An id: printable ASCII without spaces (what the `id` codec accepts), at most `maxChars`. */
  id(maxChars = 12): string {
    const n = this.int(0, maxChars);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.int(0x21, 0x7e));
    return s;
  }
  /** A string with ASCII, the id separators, and 2-, 3- and 4-byte UTF-8 characters. */
  str(maxChars = 12): string {
    const n = this.int(0, maxChars);
    let s = '';
    for (let i = 0; i < n; i++) {
      const k = this.int(0, 9);
      if (k < 6) s += String.fromCharCode(this.int(0x20, 0x7e));
      else if (k === 6) s += this.pick(['~', '/', '.', '-', '#']);
      else if (k === 7) s += String.fromCharCode(this.int(0xa0, 0x7ff));
      else if (k === 8) s += String.fromCharCode(this.pick([0x20ac, 0x4e2d, 0xfffd, 0x3042]));
      else s += String.fromCodePoint(this.int(0x1f300, 0x1f64f));
    }
    return s;
  }
}

/** Encoder, decoder and generator of one type. */
export interface Codec<T> {
  /** Smallest encoding, bytes (bounds counts before allocating). */
  readonly min: number;
  write(w: ByteWriter, v: T): void;
  /** Decode one value; on failure the reader holds the error and the returned value is meaningless. */
  read(r: ByteReader): T;
  /** A random valid instance whose encoding decodes to an equal value. */
  random(g: Gen): T;
}

/** Marker of an optional (`?:`) struct field. */
export interface Opt<T> {
  readonly optional: true;
  readonly codec: Codec<T>;
}

export function opt<T>(codec: Codec<T>): Opt<T> {
  return { optional: true, codec };
}

type FieldSpec<V> = undefined extends V ? Opt<Exclude<V, undefined>> : Codec<V>;
/** One codec per field of T; optional fields take `opt(...)`. */
export type Fields<T> = { [K in keyof T]-?: FieldSpec<T[K]> };

function fail(msg: string): never {
  throw new WireEncodeError(msg);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// ---------------------------------------------------------------------------------------- primitives

function intRange(name: string, lo: number, hi: number, write: (w: ByteWriter, v: number) => void, read: (r: ByteReader) => number, size: number): Codec<number> {
  return {
    min: size,
    write(w, v) {
      if (!isInt(v) || v < lo || v > hi) fail(`${name}: ${String(v)} is not an integer in [${lo}, ${hi}]`);
      write(w, v);
    },
    read,
    random: (g) => g.int(lo, hi),
  };
}

export const u8: Codec<number> = intRange('u8', 0, 255, (w, v) => w.u8(v), (r) => r.u8(), 1);
export const i8: Codec<number> = intRange('i8', -128, 127, (w, v) => w.i8(v), (r) => r.i8(), 1);
/** -127..127 (the symmetric i8 of control axes); -128 is refused on decode. */
export const axis8: Codec<number> = {
  min: 1,
  write(w, v) {
    if (!isInt(v) || v < -127 || v > 127) fail(`axis: ${String(v)} is not an integer in [-127, 127]`);
    w.i8(v);
  },
  read(r) {
    const v = r.i8();
    if (v === -128) r.fail('badValue');
    return v;
  },
  random: (g) => g.int(-127, 127),
};
export const u16: Codec<number> = intRange('u16', 0, 65535, (w, v) => w.u16(v), (r) => r.u16(), 2);
export const i16: Codec<number> = intRange('i16', -32768, 32767, (w, v) => w.i16(v), (r) => r.i16(), 2);
export const u32: Codec<number> = intRange('u32', 0, 0xffffffff, (w, v) => w.u32(v), (r) => r.u32(), 4);

/** Unsigned varint of a safe integer in [0, max]. */
export function varUint(max: number = Number.MAX_SAFE_INTEGER): Codec<number> {
  return {
    min: 1,
    write(w, v) {
      if (!isInt(v) || v < 0 || v > max) fail(`varUint: ${String(v)} is not an integer in [0, ${max}]`);
      w.varUint(v);
    },
    read: max === Number.MAX_SAFE_INTEGER ? (r) => r.varUint() : (r) => r.varUintMax(max),
    random(g) {
      const k = g.int(0, 3);
      const cap = k === 0 ? 127 : k === 1 ? 16383 : k === 2 ? 4294967295 : max;
      return g.safeInt(Math.min(cap, max));
    },
  };
}

/** The common varint: counts, sequence numbers, revisions, ids of requests. */
export const uint = varUint();

/** Signed varint of an integer with |v| <= 2^52. */
export const sint: Codec<number> = {
  min: 1,
  write(w, v) {
    if (!isInt(v) || Math.abs(v) > MAX_VARINT_SIGNED) fail(`varInt: ${String(v)} is not an integer with |v| <= 2^52`);
    w.varInt(v);
  },
  read: (r) => r.varInt(),
  random(g) {
    const k = g.int(0, 2);
    const m = k === 0 ? g.int(0, 63) : k === 1 ? g.safeInt(4294967295) : g.safeInt(MAX_VARINT_SIGNED);
    return g.chance(0.5) && m !== 0 ? -m : m;
  },
};

/** A finite float64. */
export const f64: Codec<number> = {
  min: 8,
  write(w, v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`f64: ${String(v)} is not finite`);
    w.f64(v);
  },
  read: (r) => r.finiteF64(),
  random: (g) => g.f64(),
};

/** A finite float32 value (the encoder rounds a float64 to the nearest float32). */
export const f32: Codec<number> = {
  min: 4,
  write(w, v) {
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v))) fail(`f32: ${String(v)} is not a finite float32`);
    w.f32(v);
  },
  read: (r) => r.finiteF32(),
  random: (g) => g.f32(),
};

/** A tick: an integer float64 (ARCHITECTURE 3, 13.1). */
export const tick: Codec<number> = {
  min: 8,
  write(w, v) {
    if (!isInt(v)) fail(`tick: ${String(v)} is not a safe integer`);
    w.f64(v);
  },
  read: (r) => r.tick(),
  random(g) {
    const k = g.int(0, 3);
    if (k === 0) return g.int(0, 1000);
    if (k === 1) return 112_582_906_000 + g.int(-1e9, 1e9);
    if (k === 2) return -g.safeInt(1e12);
    return g.safeInt(Number.MAX_SAFE_INTEGER);
  },
};

export const bool: Codec<boolean> = {
  min: 1,
  write(w, v) {
    if (typeof v !== 'boolean') fail(`bool: ${String(v)} is not a boolean`);
    w.bool(v);
  },
  read: (r) => r.bool(),
  random: (g) => g.chance(0.5),
};

/** Maximum UTF-8 lengths of the string kinds. */
export const MAX_ID_BYTES = 256;
export const MAX_TEXT_BYTES = 4096;

/** A UTF-8 string of at most `maxBytes` bytes. */
export function str(maxBytes: number = MAX_ID_BYTES): Codec<string> {
  return {
    min: 1,
    write(w, v) {
      if (typeof v !== 'string') fail(`string: ${String(v)} is not a string`);
      if (utf8Length(v) > maxBytes) fail(`string: longer than ${maxBytes} bytes`);
      w.str(v);
    },
    read: (r) => r.str(maxBytes),
    random: (g) => g.str(Math.min(12, Math.floor(maxBytes / 4))),
  };
}

/** Ids: printable ASCII without spaces, at most `WIRE_RANGES.maxIdBytes` (craft, vessel, account, body, site, clock ids, callsigns, part keys). */
export const id: Codec<string> = {
  min: 1,
  write(w, v) {
    if (typeof v !== 'string' || v.length > WIRE_RANGES.maxIdBytes || !ID_RE.test(v)) fail(`id: ${JSON.stringify(String(v)).slice(0, 40)} is not printable ASCII of at most ${WIRE_RANGES.maxIdBytes} bytes`);
    w.str(v);
  },
  read(r) {
    const s = r.str(WIRE_RANGES.maxIdBytes);
    if (!r.failed && !ID_RE.test(s)) r.fail('badValue');
    return s;
  },
  random(g) {
    const n = g.int(0, 12);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(g.int(0x21, 0x7e));
    return s;
  },
};
const ID_RE = /^[\x21-\x7e]*$/;

/** Names a client gives (a craft's name): at most `WIRE_RANGES.maxNameBytes` of UTF-8, no control characters. */
export const name: Codec<string> = {
  min: 1,
  write(w, v) {
    if (typeof v !== 'string' || utf8Length(v) > WIRE_RANGES.maxNameBytes || CONTROL_RE.test(v)) fail('name: longer than allowed or with control characters');
    w.str(v);
  },
  read(r) {
    const s = r.str(WIRE_RANGES.maxNameBytes);
    if (!r.failed && CONTROL_RE.test(s)) r.fail('badValue');
    return s;
  },
  random: (g) => g.str(10).replace(CONTROL_RE, 'x'),
};
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export const text = str(MAX_TEXT_BYTES);

/** A finite float64 in [lo, hi]. */
export function ranged(lo: number, hi: number): Codec<number> {
  return {
    min: 8,
    write(w, v) {
      if (typeof v !== 'number' || !(v >= lo && v <= hi)) fail(`number: ${String(v)} is not in [${lo}, ${hi}]`);
      w.f64(v === 0 ? 0 : v);
    },
    read(r) {
      const v = r.finiteF64();
      if (!r.failed && !(v >= lo && v <= hi)) r.fail('badValue');
      return v === 0 ? 0 : v;
    },
    random: (g) => lo + (hi - lo) * g.next(),
  };
}

/** A byte string of at most `maxBytes`. */
export function blob(maxBytes: number): Codec<Uint8Array> {
  return {
    min: 1,
    write(w, v) {
      if (!(v instanceof Uint8Array)) fail('blob: not a Uint8Array');
      if (v.length > maxBytes) fail(`blob: longer than ${maxBytes} bytes`);
      w.blob(v);
    },
    read: (r) => r.blob(maxBytes),
    random(g) {
      const out = new Uint8Array(g.int(0, Math.min(32, maxBytes)));
      for (let i = 0; i < out.length; i++) out[i] = g.int(0, 255);
      return out;
    },
  };
}

/** One of a fixed list of values, as its u8 index (append only). */
export function enumOf<T extends string | number>(values: readonly T[]): Codec<T> {
  if (values.length > 256) throw new Error('enumOf: more than 256 values');
  return {
    min: 1,
    write(w, v) {
      const i = values.indexOf(v);
      if (i < 0) fail(`enum: ${String(v)} is not one of ${values.join(', ')}`);
      w.u8(i);
    },
    read(r) {
      const i = r.u8();
      if (i >= values.length) {
        r.fail('badEnum');
        return values[0]!;
      }
      return values[i]!;
    },
    random: (g) => g.pick(values),
  };
}

/** T or null, behind a u8 flag. */
export function nullable<T>(c: Codec<T>, nullChance = 0.3): Codec<T | null> {
  return {
    min: 1,
    write(w, v) {
      if (v === null) w.u8(0);
      else {
        w.u8(1);
        c.write(w, v);
      }
    },
    read(r) {
      const f = r.u8();
      if (f === 0) return null;
      if (f !== 1) {
        r.fail('badEnum');
        return null;
      }
      return c.read(r);
    },
    random: (g) => (g.chance(nullChance) ? null : c.random(g)),
  };
}

/** An array of at most `max` elements. */
export function array<T>(c: Codec<T>, max: number): Codec<T[]> {
  return {
    min: 1,
    write(w, v) {
      if (!Array.isArray(v)) fail('array: not an array');
      if (v.length > max) fail(`array: more than ${max} elements`);
      w.varUint(v.length);
      for (let i = 0; i < v.length; i++) {
        try {
          c.write(w, v[i]!);
        } catch (e) {
          throw prefix(e, `[${i}]`);
        }
      }
    },
    read(r) {
      const n = r.count(c.min, max);
      const out: T[] = new Array<T>(n);
      for (let i = 0; i < n; i++) {
        out[i] = c.read(r);
        if (r.failed) return [];
      }
      return out;
    },
    random(g) {
      g.depth++;
      const n = g.int(0, Math.min(max, g.depth > 2 ? 1 : 3));
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(c.random(g));
      g.depth--;
      return out;
    },
  };
}

/** A string-keyed record of values (insertion order kept). */
export function record<V>(c: Codec<V>, max: number): Codec<Record<string, V>> {
  return {
    min: 1,
    write(w, v) {
      const keys = Object.keys(v);
      if (keys.length > max) fail(`record: more than ${max} keys`);
      w.varUint(keys.length);
      for (const k of keys) {
        id.write(w, k);
        try {
          c.write(w, v[k]!);
        } catch (e) {
          throw prefix(e, `.${k}`);
        }
      }
    },
    read(r) {
      const n = r.count(1 + c.min, max);
      const out: Record<string, V> = {};
      for (let i = 0; i < n; i++) {
        const k = id.read(r);
        const v = c.read(r);
        if (r.failed) return {};
        // Keys are plain data: refuse the one key an object literal cannot hold as data.
        if (k === '__proto__' || Object.prototype.hasOwnProperty.call(out, k)) {
          r.fail('badValue');
          return {};
        }
        out[k] = v;
      }
      return out;
    },
    random(g) {
      const out: Record<string, V> = {};
      const n = g.int(0, Math.min(3, max));
      for (let i = 0; i < n; i++) out[`k${i}${id.random(g).slice(0, 6)}`] = c.random(g);
      return out;
    },
  };
}

function prefix(e: unknown, at: string): unknown {
  if (e instanceof WireEncodeError) return new WireEncodeError(`${at}: ${e.message}`);
  return e;
}

interface FieldEntry {
  key: string;
  codec: Codec<unknown>;
  optional: boolean;
}

function entriesOf(fields: Record<string, Codec<unknown> | Opt<unknown>>): FieldEntry[] {
  return Object.keys(fields).map((key) => {
    const f = fields[key]!;
    return 'optional' in f ? { key, codec: f.codec, optional: true } : { key, codec: f as Codec<unknown>, optional: false };
  });
}

function writeFields(w: ByteWriter, v: Record<string, unknown>, list: FieldEntry[], optCount: number): void {
  if (optCount > 0) {
    let mask = 0;
    let bit = 1;
    for (const f of list) {
      if (!f.optional) continue;
      if (v[f.key] !== undefined) mask |= bit;
      bit <<= 1;
    }
    w.varUint(mask);
  }
  for (const f of list) {
    const x = v[f.key];
    if (f.optional && x === undefined) continue;
    try {
      f.codec.write(w, x);
    } catch (e) {
      throw prefix(e, f.key);
    }
  }
}

function readFields(r: ByteReader, out: Record<string, unknown>, list: FieldEntry[], optCount: number): void {
  let mask = 0;
  if (optCount > 0) {
    mask = r.varUint();
    if (mask >= 2 ** optCount) {
      r.fail('badEnum');
      return;
    }
  }
  let bit = 1;
  for (const f of list) {
    if (f.optional) {
      const present = (mask & bit) !== 0;
      bit <<= 1;
      if (!present) continue;
    }
    out[f.key] = f.codec.read(r);
    if (r.failed) return;
  }
}

function randomFields(g: Gen, out: Record<string, unknown>, list: FieldEntry[]): void {
  for (const f of list) {
    if (f.optional && g.chance(0.5)) continue;
    out[f.key] = f.codec.random(g);
  }
}

function minOf(list: FieldEntry[], optCount: number): number {
  let m = optCount > 0 ? 1 : 0;
  for (const f of list) if (!f.optional) m += f.codec.min;
  return m;
}

/** A struct: its fields in declaration order. */
export function struct<T>(fields: Fields<T>): Codec<T> {
  const list = entriesOf(fields as unknown as Record<string, Codec<unknown> | Opt<unknown>>);
  const optCount = list.filter((f) => f.optional).length;
  if (optCount > 30) throw new Error('struct: more than 30 optional fields');
  return {
    min: minOf(list, optCount),
    write(w, v) {
      if (v === null || typeof v !== 'object') fail('struct: not an object');
      writeFields(w, v as Record<string, unknown>, list, optCount);
    },
    read(r) {
      const out: Record<string, unknown> = {};
      readFields(r, out, list, optCount);
      return out as T;
    },
    random(g) {
      const out: Record<string, unknown> = {};
      randomFields(g, out, list);
      return out as T;
    },
  };
}

type VariantFields<T, K extends keyof T, V> = Fields<Omit<Extract<T, { [P in K]: V }>, K>>;

/** A tagged union: the u8 index of the variant (declaration order), then its fields. */
export function union<T extends { [P in K]: string }, K extends keyof T & string>(tag: K, variants: { [V in T[K]]: VariantFields<T, K, V> }): Codec<T> {
  const names = Object.keys(variants);
  if (names.length > 256) throw new Error('union: more than 256 variants');
  const table = names.map((name) => {
    const list = entriesOf((variants as Record<string, Record<string, Codec<unknown> | Opt<unknown>>>)[name]!);
    const optCount = list.filter((f) => f.optional).length;
    return { name, list, optCount, min: minOf(list, optCount) };
  });
  const index = new Map(names.map((n, i) => [n, i]));
  return {
    min: 1 + Math.min(...table.map((t) => t.min)),
    write(w, v) {
      const name = (v as Record<string, unknown>)[tag];
      const i = typeof name === 'string' ? index.get(name) : undefined;
      if (i === undefined) fail(`union: ${String(name)} is not a variant of ${tag}`);
      w.u8(i);
      const t = table[i]!;
      try {
        writeFields(w, v as Record<string, unknown>, t.list, t.optCount);
      } catch (e) {
        throw prefix(e, `${t.name}`);
      }
    },
    read(r) {
      const i = r.u8();
      const t = table[i];
      if (t === undefined) {
        r.fail('badEnum');
        return { [tag]: names[0] } as T;
      }
      const out: Record<string, unknown> = { [tag]: t.name };
      readFields(r, out, t.list, t.optCount);
      return out as T;
    },
    random(g) {
      const t = g.pick(table);
      const out: Record<string, unknown> = { [tag]: t.name };
      randomFields(g, out, t.list);
      return out as T;
    },
  };
}
