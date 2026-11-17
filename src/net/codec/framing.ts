/**
 * Batch framing (ARCHITECTURE 13.1): one transport message is a FRAME holding a batch,
 *
 *     varint count, then per message { u8 type code, varint length, payload }
 *
 * little-endian throughout. A frame decodes all or nothing (`decodeFrame`), or message by message into
 * reusable frames for the high-rate types (`FrameReader`, no allocation in steady state). Decoding never
 * throws: the result names a typed error, the message index and the byte offset.
 *
 * Who may send what is checked on decode: a server refuses a server message from a client
 * ('wrongDirection'), and a client the reverse. Role links (`'role'`) may carry any message.
 */
import type { WireMessage, WireMessageType } from '@/core/contracts/net';
import { WIRE_CONSTANTS } from '@/core/contracts/net';
import { ByteReader, ByteWriter, WireEncodeError, varUintSize, type DecodeError, type StringTableIn } from './bytes';
import { HandleTableIn } from './handles';
import { specByCode, specOf, type MessageSpec } from './messages';

/** The side a frame came from ('document': an HTTP body of the publisher). */
export type FrameSource = 'client' | 'server' | 'role' | 'document';

function accepts(source: FrameSource, spec: MessageSpec): boolean {
  if (source === 'document') return spec.sender === 'document';
  if (source === 'role') return spec.sender !== 'document';
  if (spec.sender === 'both') return true;
  return spec.sender === source;
}

/** Write one message record (code, length, payload) into `w`. On an encode error `w` is left as it was. */
export function writeMessage(w: ByteWriter, m: WireMessage): void {
  const spec = specOf(m.type);
  const start = w.pos;
  try {
    w.u8(spec.code);
    const at = w.openSection();
    (spec.codec as { write(w: ByteWriter, v: WireMessage): void }).write(w, m);
    w.closeSection(at);
  } catch (e) {
    w.pos = start;
    if (e instanceof WireEncodeError) throw new WireEncodeError(`${m.type}: ${e.message}`);
    throw e;
  }
}

/** Builds frames into one reusable buffer. */
export class FrameWriter {
  readonly w: ByteWriter;
  private count = 0;

  constructor(initialBytes = 4096) {
    this.w = new ByteWriter(initialBytes);
    this.begin();
  }

  /** Start a new frame (the previous frame's bytes become invalid). */
  begin(): void {
    this.w.reset();
    this.w.u8(0);
    this.count = 0;
  }

  /** The number of messages in the frame so far. */
  get size(): number {
    return this.count;
  }

  /** Bytes of the frame so far. */
  get bytesSoFar(): number {
    return this.w.pos + varUintSize(this.count) - 1;
  }

  add(m: WireMessage): void {
    writeMessage(this.w, m);
    this.count++;
  }

  /** Add a message record encoded earlier (`encodeMessage`). */
  addEncoded(record: Uint8Array): void {
    this.w.raw(record);
    this.count++;
  }

  /** The finished frame (a view of the internal buffer, valid until the next `begin`). */
  finish(): Uint8Array {
    const extra = varUintSize(this.count) - 1;
    const w = this.w;
    if (extra > 0) {
      w.ensure(extra);
      w.buf.copyWithin(1 + extra, 1, w.pos);
      w.pos += extra;
    }
    const end = w.pos;
    w.pos = 0;
    w.varUint(this.count);
    w.pos = end;
    return w.bytes();
  }
}

const recordWriter = new ByteWriter(1024);

/** One message record as its own bytes (copied), for queues that assemble frames later. `table` gives handles. */
export function encodeMessage(m: WireMessage, table: ByteWriter['table'] = null): Uint8Array {
  recordWriter.reset();
  recordWriter.table = table;
  writeMessage(recordWriter, m);
  return recordWriter.bytes().slice();
}

/** A frame of the given messages (copied out). */
export function encodeFrame(messages: readonly WireMessage[], table: ByteWriter['table'] = null): Uint8Array {
  const fw = new FrameWriter();
  fw.w.table = table;
  for (const m of messages) fw.add(m);
  return fw.finish().slice();
}

/** A frame of message records encoded earlier. */
export function assembleFrame(records: readonly Uint8Array[]): Uint8Array {
  let n = varUintSize(records.length);
  for (const r of records) n += r.length;
  const out = new ByteWriter(n);
  out.varUint(records.length);
  for (const r of records) out.raw(r);
  return out.bytes();
}

export type FrameResult = { ok: true; messages: WireMessage[] } | { ok: false; error: DecodeError & { index: number }; messages: WireMessage[] };

export interface DecodeOptions {
  /** Where the frame came from (direction check). */
  source: FrameSource;
  /** The receiver's handle table: `handles` messages are applied to it as they are decoded. */
  handles?: HandleTableIn | null;
  /** Size limit, bytes (default: `maxClientFrameBytes` from a client, `maxFrameBytes` otherwise). */
  maxBytes?: number;
  /** Most input samples the frame may carry in all ('badCount' beyond; decoding stops there, so the cap bounds the allocation). */
  maxInputSamples?: number;
}

const frameReader = new ByteReader();

/** Most messages a client frame may hold (a client sends a handful per send tick). */
export const MAX_CLIENT_FRAME_MESSAGES = 256;

/** Read the frame header: the message count, bounded by the bytes (each message takes at least 2). */
function readCount(r: ByteReader, source: FrameSource = 'server'): number {
  return r.count(2, source === 'client' ? MAX_CLIENT_FRAME_MESSAGES : 1_000_000);
}

/**
 * Decode a whole frame. All or nothing: on a failure `ok` is false, the error says where, and `messages`
 * holds what decoded before it (for diagnostics; a receiver acts on none of them).
 */
export function decodeFrame(bytes: Uint8Array, opts: DecodeOptions): FrameResult {
  const limit = opts.maxBytes ?? (opts.source === 'client' ? WIRE_CONSTANTS.maxClientFrameBytes : WIRE_CONSTANTS.maxFrameBytes);
  const messages: WireMessage[] = [];
  if (bytes.length > limit) return { ok: false, error: { code: 'tooLarge', offset: 0, where: 'frame', index: -1 }, messages };
  const r = frameReader;
  r.reset(bytes);
  r.table = opts.handles ?? null;
  r.where = 'frame';
  const n = readCount(r, opts.source);
  const maxSamples = opts.maxInputSamples ?? Infinity;
  let samples = 0;
  for (let i = 0; i < n; i++) {
    const m = readOne(r, opts.source, opts.handles ?? null);
    if (m === null) return { ok: false, error: { ...(r.takeError() ?? { code: 'truncated', offset: r.pos, where: 'frame' }), index: i }, messages };
    if (m === SKIPPED) continue;
    if (m.type === 'input' && (samples += m.samples.length) > maxSamples) return { ok: false, error: { code: 'badCount', offset: r.pos, where: 'input', index: i }, messages };
    messages.push(m);
  }
  if (r.failed) return { ok: false, error: { ...r.takeError()!, index: -1 }, messages };
  if (r.pos !== r.end) {
    r.fail('trailing');
    return { ok: false, error: { ...r.takeError()!, index: n }, messages };
  }
  return { ok: true, messages };
}

/** What `readOne` returns for a record of a type this build does not know, skipped by its length. */
const SKIPPED = { type: 'skipped' } as unknown as WireMessage;

/**
 * Version skew: a client may meet a NEWER server during a rollout. A record of a type this build does not
 * know is skipped by its length when it comes from a server (every record is length-prefixed, and nothing
 * the client needs depends on a type it cannot know); a server refuses one from a client ('badType'), whose
 * build it checked at the Hello.
 */
function skippable(source: FrameSource): boolean {
  return source === 'server';
}

function readOne(r: ByteReader, source: FrameSource, handles: HandleTableIn | null, into?: (spec: MessageSpec, sub: ByteReader) => WireMessage | null): WireMessage | null {
  const at = r.pos;
  const code = r.u8();
  if (r.failed) return null;
  const spec = specByCode(code);
  if (!spec) {
    if (skippable(source)) {
      const len = r.varUint();
      if (r.failed) return null;
      if (len > r.remaining()) {
        r.fail('badLength');
        return null;
      }
      r.pos += len;
      return SKIPPED;
    }
    r.pos = at;
    r.fail('badType');
    return null;
  }
  r.where = spec.type;
  if (!accepts(source, spec)) {
    r.pos = at;
    r.fail('wrongDirection');
    return null;
  }
  const len = r.varUint();
  if (r.failed) return null;
  if (len > r.remaining()) {
    r.fail('badLength');
    return null;
  }
  const end = r.pos + len;
  const outerEnd = r.end;
  r.end = end;
  const m = into ? into(spec, r) : spec.codec.read(r);
  if (!r.failed && r.pos !== end) r.fail('trailing');
  r.end = outerEnd;
  if (r.failed) {
    r.end = r.pos;
    return null;
  }
  if (m && m.type === 'handles' && handles) {
    const err = handles.apply(m);
    if (err) {
      r.fail(err);
      r.end = r.pos;
      return null;
    }
  }
  return m;
}

/** Decode one census document (an HTTP body: a frame holding exactly one census message). */
export function decodeDocument(bytes: Uint8Array): { ok: true; document: Extract<WireMessage, { type: 'censusSnapshot' | 'censusDelta' }> } | { ok: false; error: DecodeError } {
  const r = new ByteReader(bytes);
  const n = readCount(r);
  if (r.failed || n !== 1) return { ok: false, error: r.takeError() ?? { code: 'badCount', offset: 0, where: 'document' } };
  const m = readOne(r, 'document', null);
  if (m === null) return { ok: false, error: r.takeError()! };
  if (m.type !== 'censusSnapshot' && m.type !== 'censusDelta') return { ok: false, error: { code: 'badType', offset: 0, where: m.type } };
  if (r.pos !== r.end) return { ok: false, error: { code: 'trailing', offset: r.pos, where: 'document' } };
  return { ok: true, document: m };
}

/** Encode a census document as an HTTP body. */
export function encodeDocument(doc: Extract<WireMessage, { type: 'censusSnapshot' | 'censusDelta' }>): Uint8Array {
  return encodeFrame([doc]);
}

/**
 * Decodes frames message by message, the high-rate types into reusable frames (one per type, owned by the
 * reader: a message handed to `visit` is valid only during the call). Messages are visited in order; a
 * failure stops the frame at the failing message, and the messages before it have been visited.
 */
export class FrameReader {
  private readonly r = new ByteReader();
  private readonly frames = new Map<WireMessageType, WireMessage>();
  readonly handles: HandleTableIn | null;

  constructor(
    private readonly source: FrameSource,
    handles: HandleTableIn | null = null,
    private readonly maxBytes = source === 'client' ? WIRE_CONSTANTS.maxClientFrameBytes : WIRE_CONSTANTS.maxFrameBytes,
  ) {
    this.handles = handles;
  }

  read(bytes: Uint8Array, visit: (m: WireMessage) => void): DecodeError | null {
    if (bytes.length > this.maxBytes) return { code: 'tooLarge', offset: 0, where: 'frame' };
    const r = this.r;
    r.reset(bytes);
    r.table = this.handles as StringTableIn | null;
    r.where = 'frame';
    const n = readCount(r, this.source);
    const into = this.into;
    for (let i = 0; i < n; i++) {
      const m = readOne(r, this.source, this.handles, into);
      if (m === null) return r.takeError();
      if (m !== SKIPPED) visit(m);
    }
    if (r.failed) return r.takeError();
    if (r.pos !== r.end) return { code: 'trailing', offset: r.pos, where: 'frame' };
    return null;
  }

  private readonly into = (spec: MessageSpec, sub: ByteReader): WireMessage | null => {
    if (!spec.hot) return spec.codec.read(sub);
    let f = this.frames.get(spec.type);
    if (!f) {
      f = spec.hot.frame();
      this.frames.set(spec.type, f);
    }
    spec.hot.readInto(sub, f as never);
    return f;
  };
}
