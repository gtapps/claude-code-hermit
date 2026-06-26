// Home Assistant WebSocket client — the transport REST cannot reach (helpers,
// areas, entity/device registries). Companion to the REST client in ha-api.ts.
//
// Design: single-shot connection per CLI invocation (connect → auth → run a few
// commands → close). No long-lived connection, reconnect, or keepalive — the CLI
// runs short bulk operations and exits. Bun ships a global WebSocket, so this
// adds zero runtime dependencies.
//
// Protocol (https://developers.home-assistant.io/docs/api/websocket/):
//   1. Server sends {"type":"auth_required"}.
//   2. Client sends {"type":"auth","access_token":<token>}.
//   3. Server replies {"type":"auth_ok"} or {"type":"auth_invalid","message"}.
//   4. Commands carry an incrementing integer `id`; results come back as
//      {"id","type":"result","success",("result"|"error")}.
//
// Error semantics mirror ha-api.ts: failures throw HomeAssistantError carrying
// HA's {"message"} verbatim, so callers get the same surface as the REST path.

import type { AppConfig } from './config';
import { HomeAssistantError, selectHomeAssistantUrl } from './ha-api';

/**
 * Injectable transport seam (mirrors ha-api.ts's FetchLike). The default wraps
 * Bun's global WebSocket; tests inject a fake that scripts server messages.
 * The factory resolves once the socket is OPEN.
 */
export interface WsTransport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type WsTransportFactory = (url: string) => Promise<WsTransport>;

/** http(s) base URL → ws(s) WebSocket endpoint. */
export function httpToWs(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')}/api/websocket`;
}

/** Default transport: wrap Bun's global WebSocket, resolving once OPEN. */
function openWebSocket(url: string): Promise<WsTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () =>
      resolve({
        send: (data) => ws.send(data),
        onMessage: (cb) =>
          ws.addEventListener('message', (ev: MessageEvent) =>
            cb(typeof ev.data === 'string' ? ev.data : String(ev.data)),
          ),
        onClose: (cb) => ws.addEventListener('close', () => cb()),
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('error', () =>
      reject(new HomeAssistantError('Failed to open Home Assistant WebSocket.')),
    );
  });
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HomeAssistantWsClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private authResolve: (() => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;

  private constructor(
    private readonly config: AppConfig,
    private readonly transport: WsTransport,
  ) {}

  /**
   * Resolve the base URL (reusing the REST client's local/remote selection),
   * open the socket, and complete the auth handshake. Throws
   * HomeAssistantError if the URL/token is missing or auth fails.
   */
  static async create(
    config: AppConfig,
    transportFactory: WsTransportFactory = openWebSocket,
  ): Promise<HomeAssistantWsClient> {
    const [baseUrl] = await selectHomeAssistantUrl(config);
    const transport = await transportFactory(httpToWs(baseUrl));
    const client = new HomeAssistantWsClient(config, transport);
    transport.onMessage((raw) => client.handleMessage(raw));
    transport.onClose(() => client.handleClose());
    await client.authenticate();
    return client;
  }

  /** Send a command and resolve its `result` (or throw HA's error message). */
  command(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) {
      return Promise.reject(new HomeAssistantError('Home Assistant WebSocket is closed.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HomeAssistantError(`WebSocket command '${type}' timed out.`));
      }, this.config.timeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
    this.rejectAllPending(new HomeAssistantError('Home Assistant WebSocket closed.'));
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HomeAssistantError('Home Assistant WebSocket auth timed out.')),
        this.config.timeoutSeconds * 1000,
      );
      this.authResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.authReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON frames
    }
    switch (msg?.type) {
      case 'auth_required':
        this.transport.send(JSON.stringify({ type: 'auth', access_token: this.config.haToken }));
        return;
      case 'auth_ok':
        this.authResolve?.();
        this.authResolve = null;
        this.authReject = null;
        return;
      case 'auth_invalid':
        this.authReject?.(
          new HomeAssistantError(
            typeof msg.message === 'string' ? msg.message : 'Home Assistant rejected the token.',
          ),
        );
        this.authResolve = null;
        this.authReject = null;
        return;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) {
          p.resolve(msg.result);
        } else {
          const message =
            msg.error && typeof msg.error.message === 'string'
              ? msg.error.message
              : 'Home Assistant WebSocket command failed.';
          p.reject(new HomeAssistantError(message));
        }
        return;
      }
      default:
        return; // events/pings: not used by the single-shot command flow
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.authReject?.(new HomeAssistantError('Home Assistant WebSocket closed before auth.'));
    this.rejectAllPending(new HomeAssistantError('Home Assistant WebSocket closed.'));
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
