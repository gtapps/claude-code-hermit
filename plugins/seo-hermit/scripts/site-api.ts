#!/usr/bin/env bun
// seo-hermit site API client. Zero runtime deps — Bun + fetch + node:crypto only.
// Credentials are read from the environment / .env, never from argv, and never printed.
//
// Subcommands (PR1): check, search-analytics.
// Output contract: `check` prints a bare status token per line; every other subcommand
// prints exactly one JSON document `{ok:true,data:…}` or `{ok:false,error:…}` to stdout.

import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const REQUIRED_VARS = ["SEO_HERMIT_SITE_URL", "SEO_HERMIT_SITEMAP_URL", "SEO_HERMIT_GSC_CREDENTIALS"] as const;

type FetchImpl = typeof fetch;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface Env {
  SEO_HERMIT_SITE_URL: string;
  SEO_HERMIT_SITEMAP_URL: string;
  SEO_HERMIT_GSC_CREDENTIALS: string;
  SEO_HERMIT_PSI_KEY: string;
}

// HTTP errors carry the status so callers can distinguish auth (401/403) from other failures.
// A thrown non-HttpError (fetch rejection) means the endpoint was unreachable.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// ---- env / .env ----

export function loadDotEnv(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const path = resolve(root, ".env");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// process.env wins over .env so container/CI injection overrides the file.
export function resolveEnv(root: string): Env {
  const fromFile = loadDotEnv(root);
  const pick = (k: keyof Env): string => process.env[k] ?? fromFile[k] ?? "";
  return {
    SEO_HERMIT_SITE_URL: pick("SEO_HERMIT_SITE_URL"),
    SEO_HERMIT_SITEMAP_URL: pick("SEO_HERMIT_SITEMAP_URL"),
    SEO_HERMIT_GSC_CREDENTIALS: pick("SEO_HERMIT_GSC_CREDENTIALS"),
    SEO_HERMIT_PSI_KEY: pick("SEO_HERMIT_PSI_KEY"),
  };
}

function loadServiceAccount(path: string): ServiceAccount | null {
  if (!path || !existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key || !sa.token_uri) return null;
  return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
}

// CLI commands that need GSC auth call this to load-or-exit in one step.
function requireServiceAccount(env: Env): ServiceAccount {
  const sa = loadServiceAccount(env.SEO_HERMIT_GSC_CREDENTIALS);
  if (!sa) {
    emit(false, "GSC credentials missing or unreadable");
    process.exit(1);
  }
  return sa;
}

// ---- JWT-bearer auth ----

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function buildJwt(sa: ServiceAccount, nowSec: number, scope: string = GSC_SCOPE): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

export async function mintAccessToken(
  sa: ServiceAccount,
  nowSec: number,
  fetchImpl: FetchImpl,
  scope: string = GSC_SCOPE,
): Promise<string> {
  const jwt = buildJwt(sa, nowSec, scope);
  const res = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) throw new HttpError(res.status, `token mint failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token response missing access_token");
  return json.access_token;
}

// ---- Search Console ----

export interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function gscSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<{ rows?: SearchRow[] }> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `searchAnalytics query failed (${res.status})`);
  return (await res.json()) as { rows?: SearchRow[] };
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

// Aggregate rows into totals: summed clicks/impressions, derived CTR, impression-weighted position.
export function shapeSearchAnalytics(raw: { rows?: SearchRow[] }): {
  rows: SearchRow[];
  totals: SearchTotals;
} {
  const rows = raw.rows ?? [];
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weightedPosition += r.position * r.impressions;
  }
  return {
    rows,
    totals: {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weightedPosition / impressions : 0,
    },
  };
}

// ---- PageSpeed Insights ----

function psiEndpoint(url: string, key: string, strategy: string): string {
  return (
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}&strategy=${encodeURIComponent(strategy)}`
  );
}

export async function psiProbe(
  url: string,
  key: string,
  strategy: string,
  fetchImpl: FetchImpl,
): Promise<"ok" | "invalid" | "unreachable"> {
  try {
    const res = await fetchImpl(psiEndpoint(url, key, strategy));
    if (res.ok) return "ok";
    return res.status === 400 || res.status === 403 ? "invalid" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// A PSI-probe URL must be a real http(s) URL. `sc-domain:` properties aren't, so fall back to
// the sitemap's origin.
export function probeUrl(env: Env): string {
  if (/^https?:\/\//.test(env.SEO_HERMIT_SITE_URL)) return env.SEO_HERMIT_SITE_URL;
  try {
    return new URL(env.SEO_HERMIT_SITEMAP_URL).origin + "/";
  } catch {
    return env.SEO_HERMIT_SITE_URL;
  }
}

// ---- check ----

export interface CheckResult {
  gsc: "missing" | "invalid" | "unreachable" | "ok";
  psi?: "ok" | "invalid" | "unreachable";
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runCheck(env: Env, nowMs: number, fetchImpl: FetchImpl): Promise<CheckResult> {
  for (const v of REQUIRED_VARS) {
    if (!env[v]) return { gsc: "missing" };
  }
  const sa = loadServiceAccount(env.SEO_HERMIT_GSC_CREDENTIALS);
  if (!sa) return { gsc: "missing" };

  const result: CheckResult = { gsc: "ok" };
  try {
    const token = await mintAccessToken(sa, Math.floor(nowMs / 1000), fetchImpl);
    await gscSearchAnalytics(
      token,
      env.SEO_HERMIT_SITE_URL,
      { startDate: ymd(nowMs - 7 * 86_400_000), endDate: ymd(nowMs), rowLimit: 1 },
      fetchImpl,
    );
  } catch (err) {
    result.gsc = err instanceof HttpError && (err.status === 401 || err.status === 403) ? "invalid" : "unreachable";
  }

  if (env.SEO_HERMIT_PSI_KEY) {
    result.psi = await psiProbe(probeUrl(env), env.SEO_HERMIT_PSI_KEY, "mobile", fetchImpl);
  }
  return result;
}

// ---- sitemap ----

// Extract <loc> URLs from a sitemap or sitemap-index document (regex — no XML dep).
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export async function fetchSitemap(
  sitemapUrl: string,
  limit: number,
  fetchImpl: FetchImpl,
): Promise<string[]> {
  const res = await fetchImpl(sitemapUrl);
  if (!res.ok) throw new HttpError(res.status, `sitemap fetch failed (${res.status})`);
  const xml = await res.text();
  const locs = parseSitemapLocs(xml);
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  if (isIndex) {
    // Recurse one level into child sitemaps.
    for (const child of locs) {
      if (urls.length >= limit) break;
      try {
        const childRes = await fetchImpl(child);
        if (!childRes.ok) continue;
        urls.push(...parseSitemapLocs(await childRes.text()));
      } catch {
        // skip unreachable child sitemap
      }
    }
  } else {
    urls.push(...locs);
  }
  return urls.slice(0, limit);
}

// ---- link check ----

export interface LinkResult {
  url: string;
  status: number;
  ok: boolean;
  final_url: string;
}

async function checkOneLink(url: string, fetchImpl: FetchImpl): Promise<LinkResult> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetchImpl(url, { method, redirect: "follow", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let res = await attempt("HEAD");
    if (res.status === 405 || res.status === 501) res = await attempt("GET");
    return { url, status: res.status, ok: res.ok, final_url: res.url || url };
  } catch {
    return { url, status: 0, ok: false, final_url: url };
  }
}

export async function linkCheck(
  urls: string[],
  budget: number,
  concurrency: number,
  fetchImpl: FetchImpl,
): Promise<LinkResult[]> {
  const queue = urls.slice(0, budget);
  const results: LinkResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const i = cursor++;
      results[i] = await checkOneLink(queue[i], fetchImpl);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return results;
}

// ---- PageSpeed Insights (field + lab metrics) ----

export interface CwvResult {
  url: string;
  strategy: string;
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  perf_score: number | null;
}

interface PsiApiResponse {
  loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
  lighthouseResult?: { categories?: { performance?: { score?: number } } };
}

export function shapePsi(url: string, strategy: string, raw: PsiApiResponse): CwvResult {
  const metrics = raw.loadingExperience?.metrics ?? {};
  const cruxMs = (key: string): number | null => {
    const p = metrics[key]?.percentile;
    return typeof p === "number" ? p : null;
  };
  const clsRaw = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const score = raw.lighthouseResult?.categories?.performance?.score;
  return {
    url,
    strategy,
    lcp_ms: cruxMs("LARGEST_CONTENTFUL_PAINT_MS"),
    inp_ms: cruxMs("INTERACTION_TO_NEXT_PAINT"),
    cls: typeof clsRaw === "number" ? clsRaw / 100 : null,
    perf_score: typeof score === "number" ? score : null,
  };
}

export async function psiFetch(
  url: string,
  key: string,
  strategy: string,
  fetchImpl: FetchImpl,
): Promise<CwvResult> {
  const res = await fetchImpl(psiEndpoint(url, key, strategy));
  if (!res.ok) throw new HttpError(res.status, `PSI failed (${res.status})`);
  return shapePsi(url, strategy, (await res.json()) as PsiApiResponse);
}

// Core Web Vitals verdict per Google thresholds; overall = worst metric present.
export function cwvVerdict(r: Pick<CwvResult, "lcp_ms" | "inp_ms" | "cls">): "good" | "needs-improvement" | "poor" {
  const rank = { good: 0, "needs-improvement": 1, poor: 2 } as const;
  const scores: (keyof typeof rank)[] = [];
  if (r.lcp_ms != null) scores.push(r.lcp_ms <= 2500 ? "good" : r.lcp_ms > 4000 ? "poor" : "needs-improvement");
  if (r.inp_ms != null) scores.push(r.inp_ms <= 200 ? "good" : r.inp_ms > 500 ? "poor" : "needs-improvement");
  if (r.cls != null) scores.push(r.cls <= 0.1 ? "good" : r.cls > 0.25 ? "poor" : "needs-improvement");
  if (scores.length === 0) return "good";
  return scores.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "good");
}

// ---- URL Inspection (budgeted index status) ----

export interface InspectResult {
  url: string;
  verdict: string;
  coverage_state: string;
  last_crawl_time: string | null;
  robots_txt_state: string;
}

export async function inspectUrls(
  accessToken: string,
  siteUrl: string,
  urls: string[],
  budget: number,
  fetchImpl: FetchImpl,
): Promise<InspectResult[]> {
  const out: InspectResult[] = [];
  for (const url of urls.slice(0, budget)) {
    const res = await fetchImpl("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl }),
    });
    if (!res.ok) throw new HttpError(res.status, `urlInspection failed (${res.status})`);
    const json = (await res.json()) as {
      inspectionResult?: { indexStatusResult?: Record<string, string> };
    };
    const idx = json.inspectionResult?.indexStatusResult ?? {};
    out.push({
      url,
      verdict: idx.verdict ?? "VERDICT_UNSPECIFIED",
      coverage_state: idx.coverageState ?? "",
      last_crawl_time: idx.lastCrawlTime ?? null,
      robots_txt_state: idx.robotsTxtState ?? "",
    });
  }
  return out;
}

// ---- ledger diff engine ----

export interface Ledger {
  version: 1;
  site_url: string;
  updated_at: string;
  inspect_cursor: number;
  search: { history: SearchLedgerEntry[] };
  links: { broken: Record<string, BrokenLink>; last_checked: { date: string; count: number } | null };
  cwv: Record<string, { history: CwvLedgerEntry[] }>;
  index: Record<string, { verdict: string; coverage_state: string; last_inspected: string }>;
}

interface SearchLedgerEntry {
  week_end: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
interface BrokenLink {
  status: number;
  first_seen: string;
  last_seen: string;
}
interface CwvLedgerEntry {
  date: string;
  strategy: string;
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  perf_score: number | null;
  verdict: string;
}

export interface Snapshot {
  date: string;
  week_end: string;
  search_current: { totals: SearchTotals } | null;
  search_prior: { totals: SearchTotals } | null;
  links: LinkResult[];
  cwv: CwvResult[];
  index: InspectResult[];
  sitemap_count: number;
}

export interface LedgerChanges {
  quiet: boolean;
  regressions: string[];
  improvements: string[];
  new_broken: string[];
  resolved: string[];
  notes: string[];
}

export function emptyLedger(siteUrl: string): Ledger {
  return {
    version: 1,
    site_url: siteUrl,
    updated_at: "",
    inspect_cursor: 0,
    search: { history: [] },
    links: { broken: {}, last_checked: null },
    cwv: {},
    index: {},
  };
}

const SEARCH_TRIM = 12;
const CWV_TRIM = 8;
const WOW_THRESHOLD = 0.2;

// Diff a snapshot against the ledger, mutating the ledger in place and returning the changes.
export function diffLedger(ledger: Ledger, snap: Snapshot, nowIso: string): LedgerChanges {
  const changes: LedgerChanges = {
    quiet: true,
    regressions: [],
    improvements: [],
    new_broken: [],
    resolved: [],
    notes: [],
  };
  const firstRun = ledger.search.history.length === 0 && Object.keys(ledger.index).length === 0;

  // --- search WoW ---
  if (snap.search_current) {
    const cur = snap.search_current.totals;
    const prior = snap.search_prior?.totals ?? ledger.search.history.at(-1) ?? null;
    if (prior && !firstRun) {
      for (const metric of ["clicks", "impressions"] as const) {
        const p = prior[metric];
        const c = cur[metric];
        if (p > 0) {
          const delta = (c - p) / p;
          if (delta <= -WOW_THRESHOLD) changes.regressions.push(`search ${metric} ${pct(delta)} (${p}→${c})`);
          else if (delta >= WOW_THRESHOLD) changes.improvements.push(`search ${metric} ${pct(delta)} (${p}→${c})`);
        }
      }
    }
    ledger.search.history.push({
      week_end: snap.week_end,
      clicks: cur.clicks,
      impressions: cur.impressions,
      ctr: cur.ctr,
      position: cur.position,
    });
    ledger.search.history = ledger.search.history.slice(-SEARCH_TRIM);
  }

  // --- links ---
  const brokenNow = new Set<string>();
  for (const link of snap.links) {
    if (link.ok) continue;
    brokenNow.add(link.url);
    const existing = ledger.links.broken[link.url];
    if (existing) {
      existing.last_seen = snap.date;
      existing.status = link.status;
    } else {
      ledger.links.broken[link.url] = { status: link.status, first_seen: snap.date, last_seen: snap.date };
      changes.new_broken.push(`${link.url} (${link.status || "unreachable"})`);
    }
  }
  for (const url of Object.keys(ledger.links.broken)) {
    if (!brokenNow.has(url) && snap.links.length > 0) {
      changes.resolved.push(url);
      delete ledger.links.broken[url];
    }
  }
  if (snap.links.length > 0) ledger.links.last_checked = { date: snap.date, count: snap.links.length };

  // --- CWV verdict transitions ---
  for (const c of snap.cwv) {
    const verdict = cwvVerdict(c);
    const bucket = (ledger.cwv[c.url] ??= { history: [] });
    const prev = bucket.history.at(-1);
    if (prev && prev.verdict !== verdict && !firstRun) {
      changes[verdict === "good" ? "improvements" : "regressions"].push(
        `CWV ${c.url} ${prev.verdict}→${verdict}`,
      );
    }
    bucket.history.push({
      date: snap.date,
      strategy: c.strategy,
      lcp_ms: c.lcp_ms,
      inp_ms: c.inp_ms,
      cls: c.cls,
      perf_score: c.perf_score,
      verdict,
    });
    bucket.history = bucket.history.slice(-CWV_TRIM);
  }

  // --- index verdict flips ---
  for (const ins of snap.index) {
    const prev = ledger.index[ins.url];
    if (prev && prev.verdict !== ins.verdict && !firstRun) {
      changes[ins.verdict === "PASS" ? "improvements" : "regressions"].push(
        `index ${ins.url} ${prev.verdict}→${ins.verdict}`,
      );
    }
    ledger.index[ins.url] = {
      verdict: ins.verdict,
      coverage_state: ins.coverage_state,
      last_inspected: snap.date,
    };
  }

  // --- inspect cursor advance (rotate through the sitemap) ---
  if (snap.index.length > 0 && snap.sitemap_count > 0) {
    ledger.inspect_cursor = (ledger.inspect_cursor + snap.index.length) % snap.sitemap_count;
  }

  ledger.updated_at = nowIso;

  if (firstRun) {
    changes.quiet = false;
    changes.notes.push("baseline established");
  } else {
    changes.quiet =
      changes.regressions.length === 0 &&
      changes.improvements.length === 0 &&
      changes.new_broken.length === 0 &&
      changes.resolved.length === 0;
  }
  return changes;
}

function pct(delta: number): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${Math.round(delta * 100)}%`;
}

// ---- CLI ----

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function emit(ok: true, data: unknown): void;
function emit(ok: false, error: string): void;
function emit(ok: boolean, payload: unknown): void {
  console.log(JSON.stringify(ok ? { ok: true, data: payload } : { ok: false, error: payload }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const env = resolveEnv(root);
  const nowMs = Date.now();

  if (cmd === "check") {
    const result = await runCheck(env, nowMs, fetch);
    console.log(result.gsc);
    if (result.psi) console.log(`psi:${result.psi}`);
    process.exit(result.gsc === "ok" ? 0 : 1);
  }

  if (cmd === "search-analytics") {
    const start = flags.start;
    const end = flags.end;
    if (!start || !end) {
      emit(false, "search-analytics requires --start and --end (YYYY-MM-DD)");
      process.exit(1);
    }
    const sa = requireServiceAccount(env);
    const dimensions = (flags.dimensions ?? "page").split(",");
    const rowLimit = flags["row-limit"] ? Number(flags["row-limit"]) : 20;
    try {
      const token = await mintAccessToken(sa, Math.floor(nowMs / 1000), fetch);
      const raw = await gscSearchAnalytics(
        token,
        env.SEO_HERMIT_SITE_URL,
        { startDate: start, endDate: end, dimensions, rowLimit },
        fetch,
      );
      emit(true, shapeSearchAnalytics(raw));
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  if (cmd === "sitemap") {
    const limit = flags.limit ? Number(flags.limit) : 5000;
    try {
      emit(true, { urls: await fetchSitemap(env.SEO_HERMIT_SITEMAP_URL, limit, fetch) });
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  if (cmd === "link-check") {
    const budget = flags.budget ? Number(flags.budget) : 200;
    const concurrency = flags.concurrency ? Number(flags.concurrency) : 4;
    try {
      const urls = await fetchSitemap(env.SEO_HERMIT_SITEMAP_URL, budget, fetch);
      emit(true, { results: await linkCheck(urls, budget, concurrency, fetch) });
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  if (cmd === "psi") {
    const url = positional[0];
    if (!url) {
      emit(false, "psi requires a URL argument");
      process.exit(1);
    }
    if (!env.SEO_HERMIT_PSI_KEY) {
      emit(false, "SEO_HERMIT_PSI_KEY not set");
      process.exit(1);
    }
    try {
      emit(true, await psiFetch(url, env.SEO_HERMIT_PSI_KEY, flags.strategy ?? "mobile", fetch));
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  if (cmd === "inspect") {
    if (positional.length === 0) {
      emit(false, "inspect requires at least one URL");
      process.exit(1);
    }
    const sa = requireServiceAccount(env);
    const budget = flags.budget ? Number(flags.budget) : 20;
    try {
      const token = await mintAccessToken(sa, Math.floor(nowMs / 1000), fetch);
      emit(true, { results: await inspectUrls(token, env.SEO_HERMIT_SITE_URL, positional, budget, fetch) });
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  if (cmd === "ledger") {
    const snapshotPath = flags.snapshot;
    if (!snapshotPath) {
      emit(false, "ledger requires --snapshot <file>");
      process.exit(1);
    }
    const dir = flags.dir ?? ".claude-code-hermit";
    try {
      const snap = JSON.parse(readFileSync(resolve(root, snapshotPath), "utf-8")) as Snapshot;
      const ledgerPath = resolve(root, dir, "state", "site-health-ledger.json");
      const ledger: Ledger = existsSync(ledgerPath)
        ? (JSON.parse(readFileSync(ledgerPath, "utf-8")) as Ledger)
        : emptyLedger(env.SEO_HERMIT_SITE_URL);
      const changes = diffLedger(ledger, snap, new Date(nowMs).toISOString());
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
      emit(true, changes);
      process.exit(0);
    } catch (err) {
      emit(false, errMessage(err));
      process.exit(1);
    }
  }

  emit(false, `unknown command: ${cmd ?? "(none)"}`);
  process.exit(1);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  void main();
}
