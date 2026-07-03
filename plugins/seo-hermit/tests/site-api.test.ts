import { afterAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJwt,
  cwvVerdict,
  fetchSitemap,
  gscSearchAnalytics,
  HttpError,
  linkCheck,
  loadDotEnv,
  mintAccessToken,
  parseSitemapLocs,
  probeUrl,
  resolveEnv,
  runCheck,
  shapePsi,
  shapeSearchAnalytics,
  type Env,
} from "../scripts/site-api";

type FetchImpl = typeof fetch;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "seo-hermit-"));
  tmpDirs.push(d);
  return d;
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function makeServiceAccountFile(privatePem: string): string {
  const dir = makeTmpDir();
  const path = join(dir, `sa-${randomUUID()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      client_email: "svc@test.iam.gserviceaccount.com",
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Fetch stub routed by URL. token_uri → access token; searchAnalytics → configurable.
function routedFetch(opts: { token?: Response; search?: Response; psi?: Response }): FetchImpl {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return opts.token ?? jsonResponse({ access_token: "tok-123" });
    }
    if (url.includes("searchAnalytics")) {
      return opts.search ?? jsonResponse({ rows: [] });
    }
    if (url.includes("pagespeedonline")) {
      return opts.psi ?? jsonResponse({ lighthouseResult: {} });
    }
    return jsonResponse({}, 404);
  }) as unknown as FetchImpl;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SEO_HERMIT_SITE_URL: "sc-domain:example.com",
    SEO_HERMIT_SITEMAP_URL: "https://example.com/sitemap.xml",
    SEO_HERMIT_GSC_CREDENTIALS: "",
    SEO_HERMIT_PSI_KEY: "",
    ...overrides,
  };
}

describe("JWT-bearer auth", () => {
  test("buildJwt signs a verifiable RS256 assertion with correct claims", () => {
    const { publicKey, privatePem } = makeKeypair();
    const sa = {
      client_email: "svc@test.iam.gserviceaccount.com",
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const jwt = buildJwt(sa, 1_000);
    const [header, claims, signature] = jwt.split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);

    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decoded.iss).toBe(sa.client_email);
    expect(decoded.aud).toBe(sa.token_uri);
    expect(decoded.scope).toContain("webmasters");
    expect(decoded.exp - decoded.iat).toBe(3600);
    expect(decoded.iat).toBe(1_000);
  });

  test("mintAccessToken returns the access token on success", async () => {
    const { privatePem } = makeKeypair();
    const sa = {
      client_email: "svc@test.iam.gserviceaccount.com",
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const token = await mintAccessToken(sa, 1_000, routedFetch({}));
    expect(token).toBe("tok-123");
  });

  test("mintAccessToken throws HttpError(401) on rejected credentials", async () => {
    const { privatePem } = makeKeypair();
    const sa = {
      client_email: "svc@test.iam.gserviceaccount.com",
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const fetchImpl = routedFetch({ token: jsonResponse({ error: "invalid_grant" }, 401) });
    await expect(mintAccessToken(sa, 1_000, fetchImpl)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("runCheck state machine", () => {
  const now = Date.UTC(2026, 6, 3);

  test("missing when required env vars are unset", async () => {
    const result = await runCheck(baseEnv(), now, routedFetch({}));
    expect(result.gsc).toBe("missing");
  });

  test("missing when the service-account file does not exist", async () => {
    const env = baseEnv({ SEO_HERMIT_GSC_CREDENTIALS: "/no/such/file.json" });
    const result = await runCheck(env, now, routedFetch({}));
    expect(result.gsc).toBe("missing");
  });

  test("ok when token mint and searchAnalytics probe both succeed", async () => {
    const { privatePem } = makeKeypair();
    const env = baseEnv({ SEO_HERMIT_GSC_CREDENTIALS: makeServiceAccountFile(privatePem) });
    const result = await runCheck(env, now, routedFetch({}));
    expect(result.gsc).toBe("ok");
    expect(result.psi).toBeUndefined();
  });

  test("invalid when searchAnalytics returns 403", async () => {
    const { privatePem } = makeKeypair();
    const env = baseEnv({ SEO_HERMIT_GSC_CREDENTIALS: makeServiceAccountFile(privatePem) });
    const fetchImpl = routedFetch({ search: jsonResponse({ error: "forbidden" }, 403) });
    const result = await runCheck(env, now, fetchImpl);
    expect(result.gsc).toBe("invalid");
  });

  test("unreachable when the network rejects", async () => {
    const { privatePem } = makeKeypair();
    const env = baseEnv({ SEO_HERMIT_GSC_CREDENTIALS: makeServiceAccountFile(privatePem) });
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchImpl;
    const result = await runCheck(env, now, fetchImpl);
    expect(result.gsc).toBe("unreachable");
  });

  test("adds a psi line only when the PSI key is set", async () => {
    const { privatePem } = makeKeypair();
    const env = baseEnv({
      SEO_HERMIT_GSC_CREDENTIALS: makeServiceAccountFile(privatePem),
      SEO_HERMIT_PSI_KEY: "psi-key",
    });
    const result = await runCheck(env, now, routedFetch({}));
    expect(result.gsc).toBe("ok");
    expect(result.psi).toBe("ok");
  });
});

describe("shapeSearchAnalytics", () => {
  test("aggregates rows into totals with impression-weighted position", () => {
    const raw = JSON.parse(
      readFixture("gsc-searchanalytics-ok.json"),
    );
    const shaped = shapeSearchAnalytics(raw);
    expect(shaped.rows).toHaveLength(2);
    expect(shaped.totals.clicks).toBe(80);
    expect(shaped.totals.impressions).toBe(2000);
    expect(shaped.totals.ctr).toBeCloseTo(0.04, 5);
    expect(shaped.totals.position).toBeCloseTo(10.62, 2);
  });

  test("empty rows yield zeroed totals without dividing by zero", () => {
    const shaped = shapeSearchAnalytics({ rows: [] });
    expect(shaped.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });
});

describe("gscSearchAnalytics", () => {
  test("throws HttpError with the status on non-2xx", async () => {
    const fetchImpl = routedFetch({ search: jsonResponse({ error: "nope" }, 500) });
    await expect(
      gscSearchAnalytics("tok", "sc-domain:example.com", { startDate: "a", endDate: "b" }, fetchImpl),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("env loading", () => {
  test("loadDotEnv parses KEY=VALUE and strips surrounding quotes", () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, ".env"),
      ['SEO_HERMIT_SITE_URL="https://example.com/"', "SEO_HERMIT_PSI_KEY=raw-value", "# comment", ""].join("\n"),
    );
    const parsed = loadDotEnv(dir);
    expect(parsed.SEO_HERMIT_SITE_URL).toBe("https://example.com/");
    expect(parsed.SEO_HERMIT_PSI_KEY).toBe("raw-value");
  });

  test("resolveEnv lets process.env override the .env file", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, ".env"), "SEO_HERMIT_SITE_URL=from-file");
    process.env.SEO_HERMIT_SITE_URL = "from-env";
    try {
      expect(resolveEnv(dir).SEO_HERMIT_SITE_URL).toBe("from-env");
    } finally {
      delete process.env.SEO_HERMIT_SITE_URL;
    }
  });
});

describe("probeUrl", () => {
  test("uses the site URL when it is an http URL", () => {
    expect(probeUrl(baseEnv({ SEO_HERMIT_SITE_URL: "https://example.com/" }))).toBe("https://example.com/");
  });

  test("falls back to the sitemap origin for sc-domain properties", () => {
    expect(probeUrl(baseEnv())).toBe("https://example.com/");
  });
});

function readFixture(name: string): string {
  return require("node:fs").readFileSync(join(import.meta.dir, "fixtures", name), "utf-8");
}

const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
</sitemapindex>`;
const SITEMAP1 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

describe("sitemap parsing", () => {
  test("parseSitemapLocs extracts <loc> entries", () => {
    expect(parseSitemapLocs(SITEMAP1)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  test("fetchSitemap recurses one level into a sitemap index", async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/sitemap-index.xml")) return new Response(SITEMAP_INDEX, { status: 200 });
      if (url.endsWith("/sitemap1.xml")) return new Response(SITEMAP1, { status: 200 });
      return new Response("", { status: 404 });
    }) as unknown as FetchImpl;
    const urls = await fetchSitemap("https://example.com/sitemap-index.xml", 100, fetchImpl);
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  test("fetchSitemap honours the limit", async () => {
    const fetchImpl = (async () => new Response(SITEMAP1, { status: 200 })) as unknown as FetchImpl;
    const urls = await fetchSitemap("https://example.com/sitemap.xml", 1, fetchImpl);
    expect(urls).toHaveLength(1);
  });
});

describe("link check", () => {
  const linkFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/dead")) return new Response("", { status: 404 });
    if (url.endsWith("/head405")) return new Response("", { status: method === "HEAD" ? 405 : 200 });
    if (url.endsWith("/boom")) throw new Error("network down");
    return new Response("", { status: 200 });
  }) as unknown as FetchImpl;

  test("classifies ok, broken, HEAD→GET fallback, and network failure", async () => {
    const results = await linkCheck(
      ["https://x/ok", "https://x/dead", "https://x/head405", "https://x/boom"],
      200,
      4,
      linkFetch,
    );
    const byUrl = Object.fromEntries(results.map((r) => [r.url, r]));
    expect(byUrl["https://x/ok"].ok).toBe(true);
    expect(byUrl["https://x/dead"].status).toBe(404);
    expect(byUrl["https://x/dead"].ok).toBe(false);
    expect(byUrl["https://x/head405"].ok).toBe(true); // GET fallback returned 200
    expect(byUrl["https://x/boom"].ok).toBe(false);
    expect(byUrl["https://x/boom"].status).toBe(0);
  });

  test("respects the budget cap", async () => {
    const results = await linkCheck(["https://x/1", "https://x/2", "https://x/3"], 2, 4, linkFetch);
    expect(results).toHaveLength(2);
  });
});

describe("PageSpeed Insights shaping", () => {
  test("shapePsi trims to CrUX field metrics and lab score", () => {
    const raw = JSON.parse(readFixture("psi-ok.json"));
    const shaped = shapePsi("https://example.com/", "mobile", raw);
    expect(shaped.lcp_ms).toBe(2100);
    expect(shaped.inp_ms).toBe(180);
    expect(shaped.cls).toBeCloseTo(0.05, 5);
    expect(shaped.perf_score).toBe(0.92);
  });

  test("shapePsi tolerates missing metrics", () => {
    const shaped = shapePsi("https://example.com/", "mobile", {});
    expect(shaped.lcp_ms).toBeNull();
    expect(shaped.perf_score).toBeNull();
  });
});

describe("cwvVerdict", () => {
  test("all-good metrics → good", () => {
    expect(cwvVerdict({ lcp_ms: 2000, inp_ms: 100, cls: 0.05 })).toBe("good");
  });

  test("worst metric wins → poor", () => {
    expect(cwvVerdict({ lcp_ms: 2000, inp_ms: 100, cls: 0.4 })).toBe("poor");
  });

  test("mid metric → needs-improvement", () => {
    expect(cwvVerdict({ lcp_ms: 3000, inp_ms: 100, cls: 0.05 })).toBe("needs-improvement");
  });

  test("no metrics present → good (nothing to flag)", () => {
    expect(cwvVerdict({ lcp_ms: null, inp_ms: null, cls: null })).toBe("good");
  });
});
