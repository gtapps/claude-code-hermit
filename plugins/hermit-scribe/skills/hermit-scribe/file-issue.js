#!/usr/bin/env node
"use strict";

const { createSign } = require("crypto");
const https = require("https");
const { readFileSync } = require("fs");

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function makeJWT(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const input = `${header}.${payload}`;
  const sig = b64url(createSign("RSA-SHA256").update(input).sign(pem));
  return `${input}.${sig}`;
}

function ghRequest(method, path, auth, body) {
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
          let json;
          try { json = JSON.parse(raw); } catch { json = { message: raw }; }
          if (res.statusCode >= 400) reject(new Error(`GH ${res.statusCode}: ${json.message || raw}`));
          else resolve(json);
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function loadEnv() {
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

async function getInstallToken({ HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE }) {
  let pem;
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
    process.stderr.write("Usage: node file-issue.js --check <proposal-id>\n");
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
    process.stderr.write("Usage: node file-issue.js --comment <issue-number> <body-file>\n");
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

async function main() {
  if (process.argv[2] === "--check") {
    await checkMode();
    return;
  }

  if (process.argv[2] === "--comment") {
    await commentMode();
    return;
  }

  const [, , titleFile, bodyFile] = process.argv;
  if (!titleFile || !bodyFile) {
    process.stderr.write("Usage: node file-issue.js <title-file> <body-file>\n");
    process.exit(1);
  }

  const env = loadEnv();

  const title = readFileSync(titleFile, "utf8").trim();
  const issueBody = readFileSync(bodyFile, "utf8");
  if (!title) {
    process.stderr.write(`Title file is empty: ${titleFile}\n`);
    process.exit(1);
  }

  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const issue = await ghRequest(
    "POST",
    `/repos/${owner}/${repo}/issues`,
    `Bearer ${token}`,
    { title, body: issueBody, labels: ["hermit-filed"] }
  );

  process.stdout.write(issue.html_url + "\n");
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
