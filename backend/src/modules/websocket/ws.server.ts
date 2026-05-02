import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { verifyAccessToken } from '@utils/jwt';
import { env } from '@config/env';
import { WS_EVENTS } from './ws.events';

let io: SocketServer;

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

  return io;
}

export function getIo(): SocketServer {
  if (!io) throw new Error('WebSocket server not initialized');
  return io;
}

export function emitToAll(event: string, data: unknown): void {
  getIo().emit(event, data);
}
