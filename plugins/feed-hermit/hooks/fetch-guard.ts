#!/usr/bin/env bun
/**
 * PreToolUse hook: validate WebFetch URLs against the feed-sources.md domain allowlist.
 * Blocks fetches to domains not in feed-sources.md (plus a small hardcoded infra list).
 * Exit 0 = allow. Exit 2 = block. Fails open on missing feed-sources.md / malformed input.
 */

const SOURCES_FILE = "feed-sources.md";

const INFRA_ALLOWLIST = [
  "raw.githubusercontent.com",
  "api.github.com",
  "registry.npmjs.org",
  "pypi.org",
  "codeload.github.com",
];

export function parseAllowlist(sourcesMd: string): string[] {
  const hosts = new Set<string>();
  const urlRegex = /https?:\/\/(?:www\.)?([^/\s|)]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(sourcesMd)) !== null) {
    hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}

export function isAllowed(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

async function readStdin(): Promise<string> {
  return Bun.stdin.text();
}

function extractUrl(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const toolInput = (data as Record<string, unknown>).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const url = (toolInput as Record<string, unknown>).url;
  return typeof url === "string" ? url : undefined;
}

async function main(): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // malformed input — don't block
  }

  const url = extractUrl(data);
  if (!url) process.exit(0);

  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    console.error(`WebFetch blocked: could not parse URL "${url}"`);
    process.exit(2);
  }

  let sources: string;
  try {
    sources = await Bun.file(SOURCES_FILE).text();
  } catch {
    process.exit(0); // can't read the allowlist file — fail open
  }

  const allowlist = [...parseAllowlist(sources), ...INFRA_ALLOWLIST];

  if (isAllowed(hostname, allowlist)) {
    process.exit(0);
  }
  console.error(
    `WebFetch blocked: "${hostname}" is not in the ${SOURCES_FILE} allowlist. ` +
      `Add the source to ${SOURCES_FILE} to permit fetches from this domain.`,
  );
  process.exit(2);
}

if (import.meta.main) {
  void main();
}
