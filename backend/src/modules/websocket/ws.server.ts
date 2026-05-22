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

interface ExtensionSocket {
  customerId: string;
  write: (payload: unknown) => void;
  close: () => void;
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

export function sendToExtension(customerId: string, payload: unknown): boolean {
  const connection = extensionConnections.get(customerId);
  if (!connection) return false;
  connection.write(payload);
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
    markExtensionConnected(customerId, payload.email);
    const extensionSocket: ExtensionSocket = {
      customerId,
      write: (message: unknown) => socket.write(encodeFrame(JSON.stringify(message))),
      close: () => socket.destroy(),
    };
    extensionConnections.set(customerId, extensionSocket);

    socket.on('data', (buffer) => {
      const message = decodeFrame(buffer);
      if (!message) return;
      try {
        void handleExtensionEvent(customerId, JSON.parse(message)).catch(() => undefined);
      } catch {
        extensionSocket.write({ type: 'ERROR', reason: 'Invalid JSON message' });
      }
    });
    socket.on('close', () => {
      extensionConnections.delete(customerId);
      markExtensionDisconnected(customerId);
    });
    socket.on('error', () => {
      extensionConnections.delete(customerId);
      markExtensionDisconnected(customerId);
    });
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
