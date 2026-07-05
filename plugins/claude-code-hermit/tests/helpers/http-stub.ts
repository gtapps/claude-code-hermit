// Minimal local HTTP stub for tests that exercise a real network POST
// (channel-send.ts's sendToChannel) without hitting a real platform API.
// Captures every request body/path/headers and returns a configurable status.

export interface StubRequest {
  path: string;
  body: any;
  headers: Record<string, string>;
}

export interface Stub {
  url: string;
  requests: StubRequest[];
  setStatus(code: number): void;
  stop(): void;
}

export function startHttpStub(): Stub {
  let status = 200;
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      let body: any = null;
      try { body = await req.json(); } catch {}
      requests.push({ path: new URL(req.url).pathname, body, headers: Object.fromEntries(req.headers) });
      return new Response(JSON.stringify({ ok: status < 400, description: status >= 400 ? 'stub error' : undefined }), { status });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setStatus(code: number) { status = code; },
    stop() { server.stop(true); },
  };
}
