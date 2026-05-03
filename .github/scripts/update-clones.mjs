import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const badgesDir = process.env.BADGES_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), "../../.github/badges");
const historyPath = join(badgesDir, "clones-history.json");
const badgePath   = join(badgesDir, "clones.json");

const token = process.env.GH_TOKEN;
const repo  = process.env.REPO;
if (!token || !repo) {
  console.error("GH_TOKEN and REPO env vars are required");
  process.exit(1);
}

if (!existsSync(historyPath)) {
  console.error(`Badge history not found: ${historyPath}`);
  console.error(`Set BADGES_DIR to a local checkout of the badges branch, e.g.:`);
  console.error(`  git worktree add /tmp/badges badges`);
  console.error(`  BADGES_DIR=/tmp/badges/.github/badges node .github/scripts/update-clones.mjs`);
  process.exit(1);
}

const history = JSON.parse(readFileSync(historyPath, "utf8"));

const res = await fetch(
  `https://api.github.com/repos/${repo}/traffic/clones`,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }
);

if (!res.ok) {
  console.error(`API error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const { clones } = await res.json();

// Upsert by timestamp — API is authoritative; handles "today still incrementing"
const byTs = Object.fromEntries(history.daily.map((d) => [d.timestamp, d]));
for (const { timestamp, count, uniques } of clones ?? []) {
  byTs[timestamp] = { timestamp, count, uniques };
}
history.daily = Object.values(byTs).sort((a, b) =>
  a.timestamp < b.timestamp ? -1 : 1
);

const totalCount   = history.baseline         + history.daily.reduce((s, d) => s + d.count,   0);
const totalUniques = history.baseline_uniques + history.daily.reduce((s, d) => s + d.uniques, 0);

history.total         = totalCount;
history.total_uniques = totalUniques;

writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
writeFileSync(
  badgePath,
  JSON.stringify(
    {
      schemaVersion: 1,
      label: "Downloads",
      message: totalCount >= 1000 ? `${Math.floor(totalCount / 1000)}k+` : String(totalCount),
      color: "blue",
    },
    null,
    2
  ) + "\n"
);

console.log(`Updated: ${totalCount} clones (${totalUniques} uniques), ${history.daily.length} tracked days`);
