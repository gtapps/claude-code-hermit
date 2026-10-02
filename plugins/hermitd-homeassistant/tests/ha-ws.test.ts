// Tests for src/ha-ws.ts — the WebSocket client. No real sockets: a fake
// WsTransport scripts the server side via an onSend reactor + manual emit/close.

import { expect, test } from 'bun:test';

import { AppConfig } from '../src/config';
import { HomeAssistantError } from '../src/ha-api';
import { HomeAssistantWsClient, httpToWs, type WsTransport } from '../src/ha-ws';

function config(timeoutSeconds = 5): AppConfig {
  return new AppConfig('/tmp', 'http://ha.local:8123', null, null, 'tok', timeoutSeconds, 0);
}

interface ServerApi {
  emit(obj: unknown): void;
  emitRaw(raw: string): void;
  triggerClose(): void;
  sent: any[];
}

/**
 * Fake transport. `onSend(msg, api)` reacts to each client frame. The server
 * initiates the handshake by emitting `auth_required` on a macrotask, so it
 * lands after create() registers its message listener (matching real HA, which
 * sends auth_required right after the socket opens).
 */
function fakeFactory(onSend: (msg: any, api: ServerApi) => void) {
  const sent: any[] = [];
  let messageCb: (data: string) => void = () => {};
  let closeCb: () => void = () => {};
  const api: ServerApi = {
    emit: (obj) => messageCb(JSON.stringify(obj)),
    emitRaw: (raw) => messageCb(raw),
    triggerClose: () => closeCb(),
    sent,
  };
  const transport: WsTransport = {
    send: (data) => {
      const msg = JSON.parse(data);
      sent.push(msg);
      onSend(msg, api);
    },
    onMessage: (cb) => {
      messageCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: () => {},
  };
  return {
    factory: async () => {
      setTimeout(() => api.emit({ type: 'auth_required', ha_version: 'test' }), 0);
      return transport;
    },
    api,
  };
}

// happy-path server: ack auth, echo commands as successful results.
const echoServer = (msg: any, api: ServerApi) => {
  if (msg.type === 'auth') {
    api.emit({ type: 'auth_ok', ha_version: 'test' });
  } else {
    api.emit({ id: msg.id, type: 'result', success: true, result: { echoed: msg.type } });
  }
};

test('httpToWs maps scheme and appends endpoint', () => {
  expect(httpToWs('http://ha.local:8123')).toBe('ws://ha.local:8123/api/websocket');
  expect(httpToWs('https://x.ui.nabu.casa/')).toBe('wss://x.ui.nabu.casa/api/websocket');
});

test('create completes auth handshake and sends token', async () => {
  const { factory, api } = fakeFactory(echoServer);
  const client = await HomeAssistantWsClient.create(config(), factory);
  expect(api.sent).toContainEqual({ type: 'auth', access_token: 'tok' });
  client.close();
});

test('command resolves with result payload', async () => {
  const { factory } = fakeFactory(echoServer);
  const client = await HomeAssistantWsClient.create(config(), factory);
  const result = await client.command('config/area_registry/list');
  expect(result).toEqual({ echoed: 'config/area_registry/list' });
  client.close();
});

test('command sends id-correlated frame with payload merged', async () => {
  const { factory, api } = fakeFactory(echoServer);
  const client = await HomeAssistantWsClient.create(config(), factory);
  await client.command('config/area_registry/create', { name: 'Office' });
  const cmd = api.sent.find((m) => m.type === 'config/area_registry/create');
  expect(cmd).toMatchObject({ type: 'config/area_registry/create', name: 'Office' });
  expect(typeof cmd.id).toBe('number');
  client.close();
});

test('auth_invalid rejects create with HA message', async () => {
  const { factory } = fakeFactory((msg, api) => {
    if (msg.type === 'auth') api.emit({ type: 'auth_invalid', message: 'Invalid token.' });
  });
  await expect(HomeAssistantWsClient.create(config(), factory)).rejects.toThrow('Invalid token.');
});

test('command failure surfaces HA error message verbatim', async () => {
  const { factory } = fakeFactory((msg, api) => {
    if (msg.type === 'auth') api.emit({ type: 'auth_ok' });
    else api.emit({ id: msg.id, type: 'result', success: false, error: { code: 'not_found', message: 'Area not found.' } });
  });
  const client = await HomeAssistantWsClient.create(config(), factory);
  await expect(client.command('config/area_registry/delete', { area_id: 'x' })).rejects.toThrow(
    'Area not found.',
  );
  client.close();
});

test('interleaved results route to the correct command by id', async () => {
  // Server defers both results, then answers in reverse order.
  const queue: Array<{ id: number; type: string }> = [];
  const { factory, api } = fakeFactory((msg) => {
    if (msg.type === 'auth') api.emit({ type: 'auth_ok' });
    else queue.push({ id: msg.id, type: msg.type });
  });
  const client = await HomeAssistantWsClient.create(config(), factory);
  const pA = client.command('cmd_a');
  const pB = client.command('cmd_b');
  // answer B first, then A
  const b = queue.find((q) => q.type === 'cmd_b')!;
  const a = queue.find((q) => q.type === 'cmd_a')!;
  api.emit({ id: b.id, type: 'result', success: true, result: 'B' });
  api.emit({ id: a.id, type: 'result', success: true, result: 'A' });
  expect(await pA).toBe('A');
  expect(await pB).toBe('B');
  client.close();
});

test('command times out when no result arrives', async () => {
  const { factory } = fakeFactory((msg, api) => {
    if (msg.type === 'auth') api.emit({ type: 'auth_ok' });
    // never answers commands
  });
  const client = await HomeAssistantWsClient.create(config(0.05), factory);
  await expect(client.command('cmd_never')).rejects.toThrow('timed out');
  client.close();
});

test('early close rejects pending commands', async () => {
  const { factory, api } = fakeFactory((msg) => {
    if (msg.type === 'auth') api.emit({ type: 'auth_ok' });
    // hold commands open
  });
  const client = await HomeAssistantWsClient.create(config(), factory);
  const pending = client.command('cmd_held');
  api.triggerClose();
  await expect(pending).rejects.toThrow('closed');
});

test('non-JSON frames are ignored, not fatal', async () => {
  const { factory, api } = fakeFactory(echoServer);
  const client = await HomeAssistantWsClient.create(config(), factory);
  api.emitRaw('not json at all');
  const result = await client.command('cmd_after_garbage');
  expect(result).toEqual({ echoed: 'cmd_after_garbage' });
  client.close();
});
