// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {Object} DailyEntry
 * @property {string} timestamp ISO-8601 day, e.g. "2026-05-05T00:00:00Z"
 * @property {number} count Total clone or view count for that day
 * @property {number} uniques Unique-actor count for that day
 *
 * @typedef {Object} History
 * @property {number} baseline Pre-tracking total added to sum(daily.count)
 * @property {number} baseline_uniques Pre-tracking uniques added to sum(daily.uniques)
 * @property {string} baseline_date YYYY-MM-DD note for when baseline was last set
 * @property {DailyEntry[]} daily Sorted ascending by timestamp
 * @property {number} [total] Recomputed every run as baseline + sum(daily.count)
 * @property {number} [total_uniques] Recomputed every run
 *
 * @typedef {Object} MetricSpec
 * @property {string} apiPath GitHub Traffic API path segment under /repos/{repo}/
 * @property {string} arrayKey Field on the API payload that holds the daily array
 * @property {string} historyFile
 * @property {string} badgeFile
 * @property {string} defaultLabel
 * @property {string} defaultColor
 * @property {string} labelEnv Env var name that overrides defaultLabel
 * @property {string} colorEnv Env var name that overrides defaultColor
 */

/** @type {Record<string, MetricSpec>} */
const METRICS = {
  clones: {
    apiPath: "traffic/clones",
    arrayKey: "clones",
    historyFile: "clones-history.json",
    badgeFile: "clones.json",
    defaultLabel: "Clones",
    defaultColor: "blue",
    labelEnv: "CLONES_LABEL",
    colorEnv: "CLONES_COLOR",
  },
  views: {
    apiPath: "traffic/views",
    arrayKey: "views",
    historyFile: "views-history.json",
    badgeFile: "views.json",
    defaultLabel: "Views",
    defaultColor: "green",
    labelEnv: "VIEWS_LABEL",
    colorEnv: "VIEWS_COLOR",
  },
};

/**
 * @param {string | undefined} v
 * @param {string} name
 * @returns {string}
 */
function requireEnv(v, name) {
  if (!v) {
    console.error(`${name} env var is required`);
    process.exit(1);
  }
  return v;
}

/** @param {number} n */
export const formatMessage = (n) =>
  n >= 1000 ? `${Math.floor(n / 1000)}k+` : String(n);

/**
 * @param {DailyEntry[]} existing
 * @param {DailyEntry[]} apiSeries
 * @returns {DailyEntry[]}
 */
export function mergeDaily(existing, apiSeries) {
  /** @type {Record<string, DailyEntry>} */
  const byTs = {};
  for (const d of existing) byTs[d.timestamp] = d;
  for (const { timestamp, count, uniques } of apiSeries) {
    byTs[timestamp] = { timestamp, count, uniques };
  }
  return Object.values(byTs).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const token = requireEnv(process.env.GH_TOKEN, "GH_TOKEN");
  const repo = requireEnv(process.env.REPO, "REPO");
  const badgesDir = requireEnv(process.env.BADGES_DIR, "BADGES_DIR");
  const enabled = [
    ...new Set(
      (process.env.METRICS ?? "clones,views")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];

  for (const name of enabled) {
    if (!METRICS[name]) {
      console.error(`Unknown metric: ${name} (valid: ${Object.keys(METRICS).join(", ")})`);
      process.exit(1);
    }
  }

  mkdirSync(badgesDir, { recursive: true });

  const updateMetric = async (name) => {
    const m = METRICS[name];
    const historyPath = join(badgesDir, m.historyFile);
    const badgePath = join(badgesDir, m.badgeFile);

    /** @type {History} */
    let history;
    try {
      history = JSON.parse(readFileSync(historyPath, "utf8"));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
      history = {
        baseline: 0,
        baseline_uniques: 0,
        baseline_date: new Date().toISOString().slice(0, 10),
        daily: [],
      };
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/${m.apiPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      console.error(`API error (${name}) ${res.status}: ${await res.text()}`);
      process.exit(1);
    }

    const payload = await res.json();
    const series = payload[m.arrayKey] ?? [];

    history.daily = mergeDaily(history.daily, series);

    let sumCount = 0, sumUniques = 0;
    for (const d of history.daily) { sumCount += d.count; sumUniques += d.uniques; }
    history.total = history.baseline + sumCount;
    history.total_uniques = history.baseline_uniques + sumUniques;

    const label = process.env[m.labelEnv] ?? m.defaultLabel;
    const color = process.env[m.colorEnv] ?? m.defaultColor;

    writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
    writeFileSync(
      badgePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          label,
          message: formatMessage(history.total),
          color,
        },
        null,
        2
      ) + "\n"
    );

    console.log(
      `${name}: ${history.total} total (${history.total_uniques} uniques), ${history.daily.length} tracked days`
    );
  };

  await Promise.all(enabled.map(updateMetric));
}
