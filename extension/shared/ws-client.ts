import type { BackendMessage, ExtensionEvent } from './types';

export interface WsClientOptions {
  backendUrl: string;
  token: string;
  onMessage: (message: BackendMessage) => void;
  onStatus: (status: 'connected' | 'connecting' | 'disconnected' | 'error', error?: string) => void;
}

export class ExtensionWsClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private retry = 0;

  constructor(private readonly options: WsClientOptions) {}

  connect(): void {
    this.options.onStatus('connecting');
    let url: string;
    try {
      url = this.buildUrl();
    } catch (err) {
      console.error('[VFS-WS] buildUrl failed:', (err as Error).message, 'backendUrl=', this.options.backendUrl);
      this.options.onStatus('error', 'Invalid backend URL: ' + (err as Error).message);
      return;
    }
    if (!this.options.backendUrl || typeof this.options.backendUrl !== 'string') {
      console.error('[VFS-WS] backendUrl is empty/invalid; aborting connect');
      this.options.onStatus('error', 'backendUrl missing');
      return;
    }
    console.log('[VFS-WS] connect →', url.replace(/token=[^&]+/, 'token=<redacted>'));
    try {
      this.socket = new WebSocket(url);
    } catch (err) {
      console.error('[VFS-WS] new WebSocket threw:', (err as Error).message, 'url=', url.replace(/token=[^&]+/, 'token=<redacted>'));
      this.options.onStatus('error', 'WebSocket constructor failed: ' + (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.socket.addEventListener('open', () => {
      console.log('[VFS-WS] OPEN');
      this.retry = 0;
      this.options.onStatus('connected');
    });
    this.socket.addEventListener('message', (event) => {
      const parsed = this.safeParse(event.data);
      if (parsed) this.options.onMessage(parsed as BackendMessage);
    });
    this.socket.addEventListener('close', (e) => {
      console.warn('[VFS-WS] CLOSE code=', e.code, 'reason=', e.reason || '(none)');
      this.scheduleReconnect();
    });
    this.socket.addEventListener('error', (e) => {
      console.error('[VFS-WS] ERROR', e);
      this.options.onStatus('error', 'WebSocket error');
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) self.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.options.onStatus('disconnected');
  }

  send(event: ExtensionEvent): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(event));
  }

  private scheduleReconnect(): void {
    this.options.onStatus('disconnected');
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry);
    this.retry += 1;
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private buildUrl(): string {
    const base = new URL(this.options.backendUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = '/extension';
    base.searchParams.set('token', this.options.token);
    return base.toString();
  }

  private safeParse(value: unknown): unknown {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  }
}
