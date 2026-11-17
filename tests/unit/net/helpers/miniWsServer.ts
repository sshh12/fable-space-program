/**
 * A small RFC 6455 WebSocket server for the transport tests (node:http + node:crypto): the upgrade handshake,
 * masked client frames (binary, text, ping, close; fragments joined), unmasked server frames. It exists so the
 * browser-side transport can be tested against a real socket in Node and in Chrome without the `ws` package
 * (request wire-protocol-1). Not a production server: one message at a time per connection, no extensions.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface MiniWsConnection {
  sendBinary(bytes: Uint8Array): void;
  sendText(s: string): void;
  close(code: number, reason?: string): void;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number) => void) | null;
}

export interface MiniWsServer {
  port: number;
  connections: MiniWsConnection[];
  onConnection: ((c: MiniWsConnection) => void) | null;
  stop(): Promise<void>;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLen(n)]);
  return Buffer.concat([head, Buffer.from(payload)]);
}

function bigLen(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

function connection(socket: Socket): MiniWsConnection {
  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragOpcode = 0;
  const c: MiniWsConnection = {
    onBinary: null,
    onClose: null,
    sendBinary: (bytes) => socket.write(frame(2, bytes)),
    sendText: (s) => socket.write(frame(1, new TextEncoder().encode(s))),
    close(code, reason = '') {
      const r = new TextEncoder().encode(reason);
      const p = new Uint8Array(2 + r.length);
      p[0] = code >> 8;
      p[1] = code & 0xff;
      p.set(r, 2);
      socket.write(frame(8, p));
      socket.end();
    },
  };
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0;
      const opcode = buf[0]! & 0x0f;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i % 4]!;
      buf = buf.subarray(off + 4 + len);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        socket.write(frame(8, payload.subarray(0, 2)));
        socket.end();
        c.onClose?.(code);
        return;
      }
      if (opcode === 9) {
        socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        if (opcode !== 0) fragOpcode = opcode;
        fragments.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(fragments);
        fragments = [];
        if (fragOpcode === 2) c.onBinary?.(new Uint8Array(whole.buffer, whole.byteOffset, whole.length));
      }
    }
  });
  socket.on('close', () => c.onClose?.(1006));
  socket.on('error', () => undefined);
  return c;
}

/** Start a server on a free port of 127.0.0.1. */
export function startMiniWsServer(): Promise<MiniWsServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    const sockets = new Set<Socket>();
    const api: MiniWsServer = {
      port: 0,
      connections: [],
      onConnection: null,
      stop: () =>
        new Promise<void>((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
    };
    server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.setNoDelay(true);
      const c = connection(socket);
      api.connections.push(c);
      api.onConnection?.(c);
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      api.port = typeof a === 'object' && a ? a.port : 0;
      resolve(api);
    });
  });
}
