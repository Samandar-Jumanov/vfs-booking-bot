import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import crypto from 'crypto';
import { verifyAccessToken } from '@utils/jwt';
import { env } from '@config/env';
import { WS_EVENTS } from './ws.events';
import {
  handleExtensionEvent,
  markExtensionConnected,
  markExtensionDisconnected,
} from '@modules/extension/extension.state';

let io: SocketServer;
const extensionConnections = new Map<string, ExtensionSocket>();
// Commands dispatched while an extension is momentarily disconnected (MV3
// service workers idle-kill ~every 30s, dropping the WS). Queued here and
// flushed the instant the extension reconnects, so login/booking dispatches
// are never silently dropped into a dead socket.
const pendingExtensionMessages = new Map<string, unknown[]>();
const MAX_PENDING_PER_USER = 25;

interface ExtensionSocket {
  customerId: string;
  write: (payload: unknown) => void;
  close: () => void;
  isWritable: () => boolean;
}

export function initWebSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: {
      origin: env.FRONTEND_URL,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // JWT authentication on handshake
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = verifyAccessToken(token);
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.user?.sub;
    socket.join(`user:${userId}`);

    // Handle manual captcha solution from operator
    socket.on(WS_EVENTS.CAPTCHA_SOLVED, (data: { sessionId: string; token: string }) => {
      // Re-emit to the specific session handler
      io.emit(`CAPTCHA_SOLVED:${data.sessionId}`, data.token);
    });

    socket.on('disconnect', () => {
      // cleanup if needed
    });
  });

  initExtensionWebSocket(server);

  return io;
}

export function getIo(): SocketServer {
  if (!io) throw new Error('WebSocket server not initialized');
  return io;
}

export function emitToAll(event: string, data: unknown): void {
  getIo().emit(event, data);
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  getIo().to(`user:${userId}`).emit(event, data);
}

/** True only if there's a live, writable extension socket for this customerId. */
export function isExtensionLive(customerId: string): boolean {
  const connection = extensionConnections.get(customerId);
  return Boolean(connection && connection.isWritable());
}

/** Customer ids with a currently-registered extension socket (for diagnostics). */
export function listExtensionConnections(): string[] {
  return Array.from(extensionConnections.keys());
}

export function sendToExtension(customerId: string, payload: unknown): boolean {
  const type = (payload as { type?: string } | null)?.type ?? 'unknown';
  const connection = extensionConnections.get(customerId);
  if (connection && connection.isWritable()) {
    try {
      connection.write(payload);
      console.log(`[sendToExtension] LIVE write type=${type} → ${customerId}`);
      return true;
    } catch {
      // Socket died mid-write — drop it and fall through to queueing.
      extensionConnections.delete(customerId);
    }
  }
  // No live socket right now. Queue the command and deliver it the moment the
  // extension reconnects (within the ~30s SW wake cadence). Returning true =
  // "accepted for delivery" so the caller proceeds and awaits the result.
  console.warn(
    `[sendToExtension] NO LIVE SOCKET for ${customerId} (type=${type}); queued. ` +
      `connected keys=[${Array.from(extensionConnections.keys()).join(', ')}]`,
  );
  const queue = pendingExtensionMessages.get(customerId) ?? [];
  queue.push(payload);
  while (queue.length > MAX_PENDING_PER_USER) queue.shift();
  pendingExtensionMessages.set(customerId, queue);
  return true;
}

function initExtensionWebSocket(server: HttpServer): void {
  server.on('upgrade', (req, socket) => {
    if (!req.url?.startsWith('/extension')) return;
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url, `http://${host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
      if (payload.type !== 'extension') throw new Error('wrong token type');
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    const customerId = payload.sub;
    console.log(`[extension WS] CONNECTED customerId=${customerId} email=${payload.email ?? '?'}`);
    markExtensionConnected(customerId, payload.email);
    const extensionSocket: ExtensionSocket = {
      customerId,
      write: (message: unknown) => socket.write(encodeFrame(JSON.stringify(message))),
      close: () => socket.destroy(),
      isWritable: () => socket.writable && !socket.destroyed,
    };
    extensionConnections.set(customerId, extensionSocket);

    // Push BrightData proxy creds from .env so the extension can auto-answer
    // the proxy auth challenge (fresh UZ IP per launch) — .env stays the
    // single source of truth; the operator never types proxy creds.
    if (env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      try {
        extensionSocket.write({
          type: 'BG_PROXY_CREDS',
          usernameBase: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD,
        });
      } catch {
        /* ignore */
      }
    }

    // Flush any commands queued while this extension was disconnected.
    const queued = pendingExtensionMessages.get(customerId);
    if (queued && queued.length) {
      pendingExtensionMessages.delete(customerId);
      for (const message of queued) {
        try {
          extensionSocket.write(message);
        } catch {
          /* ignore individual write failures */
        }
      }
    }

    socket.on('data', (buffer) => {
      const message = decodeFrame(buffer);
      if (!message) return;
      try {
        void handleExtensionEvent(customerId, JSON.parse(message)).catch(() => undefined);
      } catch {
        extensionSocket.write({ type: 'ERROR', reason: 'Invalid JSON message' });
      }
    });
    // Identity-checked cleanup: only forget this connection if the map still
    // points at THIS socket. Prevents an old socket's delayed close from
    // wiping out a newer reconnected socket — the race that was silently
    // dropping login/booking dispatches.
    const cleanup = () => {
      if (extensionConnections.get(customerId) === extensionSocket) {
        extensionConnections.delete(customerId);
        markExtensionDisconnected(customerId);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

function encodeFrame(message: string): Buffer {
  const payload = Buffer.from(message);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): string | null {
  if (buffer.length < 6) return null;
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) return null;
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const masked = (buffer[1] & 0x80) === 0x80;
  if (!masked) return buffer.subarray(offset, offset + length).toString('utf8');
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = buffer.subarray(offset, offset + length);
  const decoded = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    decoded[i] = payload[i] ^ mask[i % 4];
  }
  return decoded.toString('utf8');
}
