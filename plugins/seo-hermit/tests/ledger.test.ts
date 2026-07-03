import { describe, expect, test } from "bun:test";
import {
  diffLedger,
  emptyLedger,
  type InspectResult,
  type Ledger,
  type LinkResult,
  type SearchTotals,
  type Snapshot,
} from "../scripts/site-api";

const ISO = "2026-07-06T08:00:00.000Z";

function snapshot(over: Partial<Snapshot>): Snapshot {
  return {
    date: "2026-07-06",
    week_end: "2026-06-28",
    search_current: null,
    search_prior: null,
    links: [],
    cwv: [],
    index: [],
    sitemap_count: 0,
    ...over,
  };
}

function totals(clicks: number, impressions: number): { totals: SearchTotals } {
  return { totals: { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 5 } };
}

function link(url: string, status: number): LinkResult {
  return { url, status, ok: status >= 200 && status < 400, final_url: url };
}

function indexEntry(url: string, verdict: string): InspectResult {
  return { url, verdict, coverage_state: "", last_crawl_time: null, robots_txt_state: "" };
}

// Seed a non-empty ledger so diffs are not treated as the baseline first run.
function seededLedger(): Ledger {
  const l = emptyLedger("sc-domain:example.com");
  l.index["https://example.com/seed"] = {
    verdict: "PASS",
    coverage_state: "Submitted and indexed",
    last_inspected: "2026-06-01",
  };
  return l;
}

describe("first run", () => {
  test("establishes a baseline: not quiet, notes it, no false regressions", () => {
    const l = emptyLedger("sc-domain:example.com");
    const c = diffLedger(l, snapshot({ search_current: totals(100, 1000) }), ISO);
    expect(c.quiet).toBe(false);
    expect(c.notes).toContain("baseline established");
    expect(c.regressions).toHaveLength(0);
    expect(l.search.history).toHaveLength(1);
  });
});

describe("search WoW", () => {
  test("flags a regression at the -20% boundary", () => {
    const l = seededLedger();
    l.search.history.push({ week_end: "2026-06-21", clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    const c = diffLedger(l, snapshot({ search_current: totals(80, 1000) }), ISO);
    expect(c.regressions.some((r) => r.includes("clicks"))).toBe(true);
    expect(c.quiet).toBe(false);
  });

  test("flags an improvement at the +20% boundary", () => {
    const l = seededLedger();
    l.search.history.push({ week_end: "2026-06-21", clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    const c = diffLedger(l, snapshot({ search_current: totals(120, 1000) }), ISO);
    expect(c.improvements.some((r) => r.includes("clicks"))).toBe(true);
  });

  test("stays quiet inside the ±20% band", () => {
    const l = seededLedger();
    l.search.history.push({ week_end: "2026-06-21", clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    const c = diffLedger(l, snapshot({ search_current: totals(110, 1050), index: [indexEntry("https://example.com/seed", "PASS")], sitemap_count: 5 }), ISO);
    expect(c.regressions).toHaveLength(0);
    expect(c.improvements).toHaveLength(0);
  });
});

describe("broken-link lifecycle", () => {
  test("new → persists with last_seen bump → resolved and removed", () => {
    const l = seededLedger();

    let c = diffLedger(l, snapshot({ date: "2026-07-06", links: [link("https://example.com/dead", 404), link("https://example.com/ok", 200)] }), ISO);
    expect(c.new_broken.some((x) => x.includes("dead"))).toBe(true);
    expect(l.links.broken["https://example.com/dead"].first_seen).toBe("2026-07-06");

    c = diffLedger(l, snapshot({ date: "2026-07-13", links: [link("https://example.com/dead", 404)] }), ISO);
    expect(c.new_broken).toHaveLength(0);
    expect(l.links.broken["https://example.com/dead"].last_seen).toBe("2026-07-13");

    c = diffLedger(l, snapshot({ date: "2026-07-20", links: [link("https://example.com/dead", 200)] }), ISO);
    expect(c.resolved).toContain("https://example.com/dead");
    expect(l.links.broken["https://example.com/dead"]).toBeUndefined();
  });
});

describe("CWV verdict transition", () => {
  test("good → poor is a regression", () => {
    const l = seededLedger();
    diffLedger(l, snapshot({ date: "d1", cwv: [{ url: "https://example.com/", strategy: "mobile", lcp_ms: 2000, inp_ms: 100, cls: 0.05, perf_score: 0.9 }] }), ISO);
    const c = diffLedger(l, snapshot({ date: "d2", cwv: [{ url: "https://example.com/", strategy: "mobile", lcp_ms: 5000, inp_ms: 100, cls: 0.05, perf_score: 0.4 }] }), ISO);
    expect(c.regressions.some((r) => r.includes("CWV"))).toBe(true);
  });
});

describe("index verdict flip", () => {
  test("PASS → FAIL is a regression", () => {
    const l = seededLedger();
    l.search.history.push({ week_end: "w0", clicks: 1, impressions: 1, ctr: 1, position: 1 });
    diffLedger(l, snapshot({ index: [indexEntry("https://example.com/u", "PASS")], sitemap_count: 5 }), ISO);
    const c = diffLedger(l, snapshot({ index: [indexEntry("https://example.com/u", "FAIL")], sitemap_count: 5 }), ISO);
    expect(c.regressions.some((r) => r.includes("index"))).toBe(true);
  });
});

describe("trimming and cursor", () => {
  test("search history trims to 12 weeks", () => {
    const l = seededLedger();
    for (let i = 0; i < 15; i++) {
      diffLedger(l, snapshot({ week_end: `w${i}`, search_current: totals(i + 1, 100) }), ISO);
    }
    expect(l.search.history).toHaveLength(12);
  });

  test("inspect_cursor advances and wraps around the sitemap size", () => {
    const l = seededLedger();
    l.inspect_cursor = 8;
    diffLedger(
      l,
      snapshot({
        index: [
          indexEntry("https://example.com/a", "PASS"),
          indexEntry("https://example.com/b", "PASS"),
          indexEntry("https://example.com/c", "PASS"),
          indexEntry("https://example.com/d", "PASS"),
        ],
        sitemap_count: 10,
      }),
      ISO,
    );
    expect(l.inspect_cursor).toBe(2);
  });
});

describe("quiet week", () => {
  test("no changes → quiet true", () => {
    const l = emptyLedger("sc-domain:example.com");
    l.index["https://example.com/u"] = { verdict: "PASS", coverage_state: "", last_inspected: "d0" };
    const c = diffLedger(
      l,
      snapshot({
        date: "d1",
        links: [link("https://example.com/ok", 200)],
        index: [indexEntry("https://example.com/u", "PASS")],
        sitemap_count: 5,
      }),
      ISO,
    );
    expect(c.quiet).toBe(true);
    expect(c.regressions).toHaveLength(0);
    expect(c.new_broken).toHaveLength(0);
  });
});
