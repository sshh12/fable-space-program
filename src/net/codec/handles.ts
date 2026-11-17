/**
 * Session-local handles for strings (ARCHITECTURE 13.1: "ids on the wire are session-local u32 handles; the
 * mapping to string ids is sent once"). The server side gives each new string the next handle and queues the
 * assignment for a `handles` message, which is sent (reliably) before the first message that uses it; the
 * client side applies `handles` messages in frame order and resolves handles. Handle 0 is never assigned.
 *
 * A census document has a table of its own with the same rules (`DocumentStrings`), written at its head.
 */
import type { HandlesMessage } from '@/core/contracts/net';
import type { DecodeErrorCode, StringTableIn, StringTableOut } from './bytes';

/** Largest number of handles one session or document may assign (bounds the client's table). */
export const MAX_HANDLES = 1 << 22;

/** Server side of a session's handle table. */
export class HandleTableOut implements StringTableOut {
  private readonly map = new Map<string, number>();
  private pending: { handle: number; id: string }[] = [];
  private nextHandle = 1;

  handleOf(s: string): number {
    let h = this.map.get(s);
    if (h === undefined) {
      if (this.nextHandle > MAX_HANDLES) throw new Error('HandleTableOut: handle space exhausted');
      h = this.nextHandle++;
      this.map.set(s, h);
      this.pending.push({ handle: h, id: s });
    }
    return h;
  }

  /** True when assignments are waiting for a `handles` message. */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** The `handles` message of every assignment since the last call (null when there is none). */
  takePending(): HandlesMessage | null {
    if (this.pending.length === 0) return null;
    const entries = this.pending;
    this.pending = [];
    return { type: 'handles', entries };
  }

  /** Number of strings that have a handle. */
  get size(): number {
    return this.map.size;
  }
}

/** Client side of a session's handle table. */
export class HandleTableIn implements StringTableIn {
  private readonly ids: string[] = [''];

  lookup(handle: number): string | undefined {
    return handle > 0 ? this.ids[handle] : undefined;
  }

  /** Apply a `handles` message: handles must continue the table without a gap. Returns the failure, if any. */
  apply(msg: HandlesMessage): DecodeErrorCode | null {
    for (const e of msg.entries) {
      if (e.handle !== this.ids.length || this.ids.length > MAX_HANDLES) return 'badValue';
      this.ids.push(e.id);
    }
    return null;
  }

  get size(): number {
    return this.ids.length - 1;
  }
}

/** The table of one census document (or of any self-contained payload): strings in handle order. */
export class DocumentStrings implements StringTableOut, StringTableIn {
  readonly list: string[] = [];
  private readonly map = new Map<string, number>();

  handleOf(s: string): number {
    let h = this.map.get(s);
    if (h === undefined) {
      this.list.push(s);
      h = this.list.length;
      this.map.set(s, h);
    }
    return h;
  }

  lookup(handle: number): string | undefined {
    return handle > 0 ? this.list[handle - 1] : undefined;
  }

  /** Replace the contents with a decoded list. */
  load(list: readonly string[]): void {
    this.list.length = 0;
    this.map.clear();
    for (const s of list) {
      this.list.push(s);
      this.map.set(s, this.list.length);
    }
  }
}
