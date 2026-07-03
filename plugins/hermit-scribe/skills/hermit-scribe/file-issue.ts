#!/usr/bin/env bun

import { createSign } from "node:crypto";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";

type Json = any;

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function makeJWT(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const input = `${header}.${payload}`;
  const sig = b64url(createSign("RSA-SHA256").update(input).sign(pem));
  return `${input}.${sig}`;
}

function ghRequest(method: string, path: string, auth: string, body?: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: auth,
          "User-Agent": "hermit-scribe/1",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json: Json;
          try { json = JSON.parse(raw); } catch { json = { message: raw }; }
          if (res.statusCode! >= 400) reject(new Error(`GH ${res.statusCode}: ${json.message || raw}`));
          else resolve(json);
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function loadEnv(): Json {
  const {
    HERMIT_GH_APP_ID,
    HERMIT_GH_APP_INSTALL_ID,
    HERMIT_GH_APP_KEY_FILE,
    HERMIT_GH_REPO = "gtapps/claude-code-hermit",
  } = process.env;

  for (const [name, val] of [
    ["HERMIT_GH_APP_ID", HERMIT_GH_APP_ID],
    ["HERMIT_GH_APP_INSTALL_ID", HERMIT_GH_APP_INSTALL_ID],
    ["HERMIT_GH_APP_KEY_FILE", HERMIT_GH_APP_KEY_FILE],
  ]) {
    if (!val) {
      process.stderr.write(`Missing env var: ${name}\n`);
      process.exit(1);
    }
  }

  const repoParts = HERMIT_GH_REPO.split("/");
  if (repoParts.length !== 2) {
    process.stderr.write(`HERMIT_GH_REPO must be "owner/repo", got: ${HERMIT_GH_REPO}\n`);
    process.exit(1);
  }

  const [owner, repo] = repoParts;
  return { HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE, owner, repo };
}

async function getInstallToken({ HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE }: Json): Promise<string> {
  let pem: string;
  try {
    pem = readFileSync(HERMIT_GH_APP_KEY_FILE, "utf8");
  } catch {
    process.stderr.write(
      `HERMIT_GH_APP_KEY_FILE='${HERMIT_GH_APP_KEY_FILE}' does not exist (cwd=${process.cwd()}) — check .env\n`
    );
    process.exit(1);
  }
  const jwt = makeJWT(HERMIT_GH_APP_ID, pem);
  const { token } = await ghRequest(
    "POST",
    `/app/installations/${HERMIT_GH_APP_INSTALL_ID}/access_tokens`,
    `Bearer ${jwt}`
  );
  return token;
}

async function checkMode() {
  const proposalId = process.argv[3];
  if (!proposalId) {
    process.stderr.write("Usage: bun file-issue.ts --check <proposal-id>\n");
    process.exit(1);
  }

  const env = loadEnv();
  const token = await getInstallToken(env);
  const { owner, repo } = env;

  let page = 1;
  while (true) {
    const issues = await ghRequest(
      "GET",
      `/repos/${owner}/${repo}/issues?labels=hermit-filed&state=open&per_page=100&page=${page}`,
      `Bearer ${token}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const match = issues.find((i) => i.body && i.body.includes(`proposal=${proposalId}`));
    if (match) {
      process.stdout.write(match.html_url + "\n");
      process.exit(0);
    }
    if (issues.length < 100) break;
    page++;
  }

  process.stderr.write(`no match for ${proposalId}\n`);
  process.exit(2);
}

async function commentMode() {
  const issueNumber = parseInt(process.argv[3], 10);
  const bodyFile = process.argv[4];
  if (!issueNumber || issueNumber <= 0 || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts --comment <issue-number> <body-file>\n");
    process.exit(1);
  }

  const env = loadEnv();
  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const body = readFileSync(bodyFile, "utf8");
  if (!body.trim()) {
    process.stderr.write(`Body file is empty: ${bodyFile}\n`);
    process.exit(1);
  }
  const comment = await ghRequest(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    `Bearer ${token}`,
    { body }
  );

  process.stdout.write(comment.html_url + "\n");
}

function buildLabels(extra: string[] = []): string[] {
  return [...new Set(["hermit-filed", ...extra])];
}

// --- classify: pure derivation helpers (proposal-backed issues only) ---

// Conventional-Commits type from proposal category.
function deriveType(category: string): string {
  switch (category) {
    case "bug":
      return "fix";
    case "infrastructure":
    case "investigation":
      return "chore";
    default:
      return "feat"; // improvement/capability/routine/constraint/unknown
  }
}

// Strip the fleet-wide `claude-code-` prefix from a slug.
function stripSlug(slug: string): string {
  return slug.replace(/^claude-code-/, "");
}

// Resolve a single scope token from raw (pre-translation) text, or null.
// slugSet is the keys of `_hermit_versions`. Returns the stripped scope.
function resolveScope(rawText: string, slugSet: string[]): string | null {
  const matched = new Set<string>();
  for (const slug of slugSet) {
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`(?<![\\w-])${esc}(?![\\w-])`);
    const pathRef = new RegExp(`plugins/${esc}/`);
    if (wholeWord.test(rawText) || pathRef.test(rawText)) matched.add(slug);
  }
  if (matched.size === 1) return stripSlug([...matched][0]);
  if (matched.size > 1) return null; // ambiguous: signal present but unresolved — stop
  const fleet = slugSet.filter((s) => /^claude-code-.+-hermit$/.test(s) && s !== "claude-code-hermit");
  if (fleet.length === 1) return stripSlug(fleet[0]);
  return null;
}

// Type label from category, plus the scope token as an extra label when present.
// `hermit-filed` is added later by buildLabels — not included here.
function deriveLabels(category: string, scope: string | null): string[] {
  const typeLabel =
    category === "bug"
      ? "bug"
      : category === "infrastructure" || category === "investigation"
        ? "chore"
        : "enhancement";
  return scope ? [typeLabel, scope] : [typeLabel];
}

function buildTitleLine(type: string, scope: string | null, title: string): string {
  return scope ? `${type}(${scope}): ${title}` : `${type}: ${title}`;
}

// Walk up from cwd to the nearest `.claude-code-hermit/config.json` and return
// the keys of `_hermit_versions` (the recognized slug set). Empty if unreadable.
function readSlugSet(): string[] {
  let dir = process.cwd();
  while (true) {
    try {
      const cfg = JSON.parse(readFileSync(path.join(dir, ".claude-code-hermit", "config.json"), "utf8"));
      const versions = cfg._hermit_versions;
      return versions && typeof versions === "object" ? Object.keys(versions) : [];
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

function classifyMode() {
  const category = process.argv[3];
  const titleFile = process.argv[4];
  const bodyFile = process.argv[5];
  if (!category || !titleFile || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts classify <category> <title-file> <body-file>\n");
    process.exit(1);
  }

  const { title, body } = readTitleAndBody(titleFile, bodyFile);

  const type = deriveType(category);
  const scope = resolveScope(`${title}\n${body}`, readSlugSet());
  const labels = deriveLabels(category, scope);
  const title_line = buildTitleLine(type, scope, title);

  process.stdout.write(JSON.stringify({ type, scope, labels, title_line }) + "\n");
}

function readTitleAndBody(titleFile: string, bodyFile: string): { title: string; body: string } {
  const title = readFileSync(titleFile, "utf8").trim();
  const body = readFileSync(bodyFile, "utf8");
  if (!title) {
    process.stderr.write(`Title file is empty: ${titleFile}\n`);
    process.exit(1);
  }
  return { title, body };
}

async function main() {
  if (process.argv[2] === "--check") {
    await checkMode();
    return;
  }

  if (process.argv[2] === "--comment") {
    await commentMode();
    return;
  }

  if (process.argv[2] === "classify") {
    classifyMode();
    return;
  }

  const titleFile = process.argv[2];
  const bodyFile = process.argv[3];
  const extraLabels = process.argv.slice(4);

  if (!titleFile || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts <title-file> <body-file> [label...]\n");
    process.exit(1);
  }

  const env = loadEnv();

  const { title, body: issueBody } = readTitleAndBody(titleFile, bodyFile);

  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const issue = await ghRequest(
    "POST",
    `/repos/${owner}/${repo}/issues`,
    `Bearer ${token}`,
    { title, body: issueBody, labels: buildLabels(extraLabels) }
  );

  process.stdout.write(issue.html_url + "\n");
}

export { buildLabels, deriveType, resolveScope, deriveLabels, buildTitleLine };

if (import.meta.main) {
  main().catch((err: any) => {
    process.stderr.write(err.message + "\n");
    process.exit(1);
  });
}
