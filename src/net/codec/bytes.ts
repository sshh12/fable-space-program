/**
 * Byte writer and reader of the wire codec (ARCHITECTURE 13.1: little-endian, varints, UTF-8 strings).
 *
 * The WRITER grows its buffer by doubling and is meant to be reused: after the first frames it allocates
 * nothing (`reset()` keeps the buffer). The READER never throws and never reads outside its window: every
 * read checks the remaining length first, and the first failure is recorded as a typed `DecodeErrorCode`
 * (sticky: later reads return 0 and the decoder unwinds). Counts and lengths are checked against the bytes
 * that remain before anything is allocated for them, so a decoder allocates at most a small multiple of its
 * input.
 */

/** Why a decoder refused its input. */
export type DecodeErrorCode =
  /** The input ended inside a value. */
  | 'truncated'
  /** A varint was longer than 8 bytes or above 2^53 - 1. */
  | 'badVarint'
  /** A length prefix exceeds the bytes that remain or the field's maximum. */
  | 'badLength'
  /** A count exceeds what the remaining bytes can hold or the field's maximum. */
  | 'badCount'
  /** A string is not valid UTF-8. */
  | 'badUtf8'
  /** An enumeration, union tag or flag value outside its range. */
  | 'badEnum'
  /** A float is NaN or infinite where the type forbids it. */
  | 'nonFinite'
  /** A tick is not an integer, or outside the safe integer range. */
  | 'badTick'
  /** A value outside its documented range (a grid integer, a signed field). */
  | 'badValue'
  /** A message type code that does not exist. */
  | 'badType'
  /** A message that the receiving side never accepts from this sender. */
  | 'wrongDirection'
  /** Bytes left over after a message or a frame. */
  | 'trailing'
  /** A frame above the receiver's size limit. */
  | 'tooLarge'
  /** A handle that was never assigned. */
  | 'unknownHandle';

export interface DecodeError {
  code: DecodeErrorCode;
  /** Byte offset in the input where the failure was detected. */
  offset: number;
  /** Which message (type name) or field was being decoded, when known. */
  where: string;
}

/** Thrown by an ENCODER when its input is not a valid value of its type (a bug of the producer). Decoders never throw. */
export class WireEncodeError extends Error {
  override name = 'WireEncodeError';
  constructor(message: string) {
    super(message);
  }
}

/** Largest magnitude a signed varint carries (sign in the low bit; the varint stays below 2^53). */
export const MAX_VARINT_SIGNED = 2 ** 52 - 1;

/** Gives strings handles while encoding (a session's handle table, or a census document's own table). */
export interface StringTableOut {
  handleOf(s: string): number;
}

/** Resolves handles while decoding. */
export interface StringTableIn {
  lookup(handle: number): string | undefined;
}

export class ByteWriter {
  buf: Uint8Array;
  private view: DataView;
  pos = 0;
  /** The string table that handle fields are written against (null: messages with handles cannot be written). */
  table: StringTableOut | null = null;

  constructor(initialBytes = 1024) {
    this.buf = new Uint8Array(initialBytes);
    this.view = new DataView(this.buf.buffer);
  }

  reset(): void {
    this.pos = 0;
  }

  /** Make room for `n` more bytes (allocates only when the buffer must grow). */
  ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  /** The bytes written so far (a view of the internal buffer: copy it before the next reset if it must outlive it). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }
  i8(v: number): void {
    this.u8(v < 0 ? v + 256 : v);
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /** Unsigned LEB128 varint of a non-negative safe integer (callers validate). */
  varUint(v: number): void {
    this.ensure(8);
    const b = this.buf;
    let p = this.pos;
    if (v < 0x10000000) {
      while (v >= 0x80) {
        b[p++] = (v & 0x7f) | 0x80;
        v >>>= 7;
      }
      b[p++] = v;
    } else {
      // Above 2^28: arithmetic, exact for every safe integer.
      while (v >= 0x80) {
        const low = v % 128;
        b[p++] = low | 0x80;
        v = (v - low) / 128;
      }
      b[p++] = v;
    }
    this.pos = p;
  }

  /** Signed varint (magnitude times two plus the sign bit) of an integer with |v| <= 2^52. */
  varInt(v: number): void {
    this.varUint(v < 0 ? -v * 2 - 1 : v * 2);
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  raw(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  /** A string as varint byte length + UTF-8 (a lone surrogate is written as U+FFFD, as TextEncoder does). */
  str(s: string): void {
    const n = utf8Length(s);
    this.varUint(n);
    this.ensure(n);
    const b = this.buf;
    let p = this.pos;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        b[p++] = c;
      } else if (c < 0x800) {
        b[p++] = 0xc0 | (c >> 6);
        b[p++] = 0x80 | (c & 0x3f);
      } else if (c >= 0xd800 && c <= 0xdfff) {
        const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
          b[p++] = 0xf0 | (c >> 18);
          b[p++] = 0x80 | ((c >> 12) & 0x3f);
          b[p++] = 0x80 | ((c >> 6) & 0x3f);
          b[p++] = 0x80 | (c & 0x3f);
        } else {
          b[p++] = 0xef;
          b[p++] = 0xbf;
          b[p++] = 0xbd;
        }
      } else {
        b[p++] = 0xe0 | (c >> 12);
        b[p++] = 0x80 | ((c >> 6) & 0x3f);
        b[p++] = 0x80 | (c & 0x3f);
      }
    }
    this.pos = p;
  }

  /** Bytes as varint length + raw. */
  blob(src: Uint8Array): void {
    this.varUint(src.length);
    this.raw(src);
  }

  /**
   * Write a length-prefixed section: `body()` writes the payload, then its length is inserted before it as a
   * varint (the payload is moved when the length needs more than one byte).
   */
  section(body: () => void): void {
    this.ensure(1);
    const at = this.pos;
    this.pos = at + 1;
    body();
    this.closeSection(at);
  }

  /** Reserve the one-byte length slot of a section at `pos` (returned); close it with `closeSection`. */
  openSection(): number {
    this.ensure(1);
    const at = this.pos;
    this.pos = at + 1;
    return at;
  }

  closeSection(at: number): void {
    const len = this.pos - at - 1;
    const extra = varUintSize(len) - 1;
    if (extra > 0) {
      this.ensure(extra);
      this.buf.copyWithin(at + 1 + extra, at + 1, this.pos);
      this.pos += extra;
    }
    const end = this.pos;
    this.pos = at;
    this.varUint(len);
    this.pos = end;
  }
}

/** Bytes a varUint takes. */
export function varUintSize(v: number): number {
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/** UTF-8 length of a string (lone surrogates count as the 3 bytes of U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export class ByteReader {
  buf: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(this.buf.buffer);
  pos = 0;
  end = 0;
  error: DecodeErrorCode | null = null;
  errorAt = 0;
  /** Name of the message or field being decoded, for the error report. */
  where = '';
  /** The table handle fields resolve against (kept across `reset`; null: a handle is an error). */
  table: StringTableIn | null = null;

  constructor(buf?: Uint8Array) {
    if (buf) this.reset(buf);
  }

  /** Read `buf[start, end)`. */
  reset(buf: Uint8Array, start = 0, end = buf.length): void {
    if (buf !== this.buf) {
      this.buf = buf;
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    this.pos = start;
    this.end = end;
    this.error = null;
    this.errorAt = 0;
    this.where = '';
  }

  get failed(): boolean {
    return this.error !== null;
  }

  remaining(): number {
    return this.end - this.pos;
  }

  /** Record the first failure and stop reading (every later read fails at once). */
  fail(code: DecodeErrorCode): void {
    if (this.error === null) {
      this.error = code;
      this.errorAt = this.pos;
    }
    this.pos = this.end;
  }

  takeError(): DecodeError | null {
    return this.error === null ? null : { code: this.error, offset: this.errorAt, where: this.where };
  }

  private need(n: number): boolean {
    if (this.end - this.pos >= n) return true;
    this.fail('truncated');
    return false;
  }

  u8(): number {
    if (!this.need(1)) return 0;
    return this.buf[this.pos++]!;
  }
  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }
  u16(): number {
    if (!this.need(2)) return 0;
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    if (!this.need(2)) return 0;
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    if (!this.need(4)) return 0;
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** A float32 (any value, NaN and infinities included: see `finiteF32`). */
  f32(): number {
    if (!this.need(4)) return 0;
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    if (!this.need(8)) return 0;
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  finiteF32(): number {
    const v = this.f32();
    if (!Number.isFinite(v)) {
      this.fail('nonFinite');
      return 0;
    }
    return v;
  }
  finiteF64(): number {
    const v = this.f64();
    if (!Number.isFinite(v)) {
      this.fail('nonFinite');
      return 0;
    }
    return v;
  }
  /** A tick: an integer float64 within the safe integer range. */
  tick(): number {
    const v = this.f64();
    if (!Number.isSafeInteger(v)) {
      if (this.error === null) this.fail('badTick');
      return 0;
    }
    return v;
  }

  /** Unsigned varint, at most 8 bytes and 2^53 - 1. */
  varUint(): number {
    const b = this.buf;
    let p = this.pos;
    const end = this.end;
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      if (p >= end) {
        this.pos = p;
        this.fail('truncated');
        return 0;
      }
      const byte = b[p++]!;
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        this.pos = p;
        if (result > Number.MAX_SAFE_INTEGER) {
          this.fail('badVarint');
          return 0;
        }
        return result;
      }
      scale *= 128;
    }
    this.pos = p;
    this.fail('badVarint');
    return 0;
  }

  /** Signed varint (sign in the low bit). */
  varInt(): number {
    const u = this.varUint();
    if (u > MAX_VARINT_SIGNED * 2) {
      this.fail('badVarint');
      return 0;
    }
    const half = Math.floor(u / 2);
    return u % 2 === 1 ? -half - 1 : half;
  }

  /** A varUint that must not exceed `max`. */
  varUintMax(max: number): number {
    const v = this.varUint();
    if (v > max) {
      this.fail('badValue');
      return 0;
    }
    return v;
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) this.fail('badEnum');
    return v === 1;
  }

  /** A count of elements that take at least `minBytes` each, at most `max`. */
  count(minBytes: number, max: number): number {
    const n = this.varUint();
    if (this.error !== null) return 0;
    if (n > max || n * minBytes > this.end - this.pos) {
      this.fail('badCount');
      return 0;
    }
    return n;
  }

  /** A length-prefixed UTF-8 string of at most `maxBytes` bytes; invalid UTF-8 is refused. */
  str(maxBytes: number): string {
    const n = this.varUint();
    if (this.error !== null) return '';
    if (n > maxBytes || n > this.end - this.pos) {
      this.fail('badLength');
      return '';
    }
    const b = this.buf;
    let p = this.pos;
    const end = p + n;
    let s = '';
    while (p < end) {
      const c = b[p]!;
      if (c < 0x80) {
        // ASCII run.
        let q = p + 1;
        while (q < end && b[q]! < 0x80) q++;
        s += asciiChunk(b, p, q);
        p = q;
        continue;
      }
      let cp: number;
      if (c >= 0xc2 && c <= 0xdf) {
        if (p + 1 >= end) break;
        const c1 = b[p + 1]!;
        if ((c1 & 0xc0) !== 0x80) break;
        cp = ((c & 0x1f) << 6) | (c1 & 0x3f);
        p += 2;
      } else if (c >= 0xe0 && c <= 0xef) {
        if (p + 2 >= end) break;
        const c1 = b[p + 1]!;
        const c2 = b[p + 2]!;
        if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) break;
        cp = ((c & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
        if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) break;
        p += 3;
      } else if (c >= 0xf0 && c <= 0xf4) {
        if (p + 3 >= end) break;
        const c1 = b[p + 1]!;
        const c2 = b[p + 2]!;
        const c3 = b[p + 3]!;
        if ((c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) break;
        cp = ((c & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
        if (cp < 0x10000 || cp > 0x10ffff) break;
        p += 4;
      } else break;
      if (cp >= 0x10000) {
        const u = cp - 0x10000;
        s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      } else s += String.fromCharCode(cp);
    }
    if (p !== end) {
      this.pos = p;
      this.fail('badUtf8');
      return '';
    }
    this.pos = end;
    return s;
  }

  /** A length-prefixed byte string of at most `maxBytes`, copied out of the input. */
  blob(maxBytes: number): Uint8Array {
    const n = this.varUint();
    if (this.error !== null) return EMPTY;
    if (n > maxBytes || n > this.end - this.pos) {
      this.fail('badLength');
      return EMPTY;
    }
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Skip `n` bytes. */
  skip(n: number): void {
    if (this.need(n)) this.pos += n;
  }
}

const EMPTY = new Uint8Array(0);

function asciiChunk(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
}
