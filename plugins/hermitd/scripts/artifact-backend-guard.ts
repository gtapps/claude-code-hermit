// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PreToolUse hook (matcher "Artifact") — binds the artifacts.backend routing
// rule that docs/artifacts.md states but an operator chat request never loads.
// On a non-claude backend, a native Artifact publish would land the page on
// claude.ai; this hook denies that call with a reason that names the backend
// and its MCP tools. Every other action stays allowed: publish is the one that
// mints a page on the wrong host, and the rest only reach artifacts that
// already exist there. The tool and the artifact-design skills stay available
// (enableArtifact:false would drop them).
//
// No HERMIT_MANAGED / always_on gate: an attended maintenance session
// publishing to claude.ai on a self-hosted-backend install is the same leak.
//
// Fail-open: missing/malformed config, non-Artifact tool name, unreadable
// stdin, or any other error resolves to exit 0 (allow).

import { hermitDir } from './lib/cc-compat';
import { foreignArtifactBackend, readSettledConfig } from './lib/config-read';
import { runHook } from './lib/hook-input';

function main(payload: any): void {
  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName !== 'Artifact') return; // allow (defensive; matcher already scopes)

  const input = payload.tool_input && typeof payload.tool_input === 'object'
    ? payload.tool_input
    : {};
  const action = input.action;
  if (action !== undefined && action !== 'publish') return;

  const backend = foreignArtifactBackend(readSettledConfig(hermitDir()));
  if (backend === null) return;

  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const fileClause = filePath ? ` ${filePath} is the content to publish.` : '';
  process.stderr.write(
    `This hermit's artifacts.backend is "${backend}". Do not retry Artifact. ` +
    `Publish with that server's own MCP tools (mcp__${backend}__*) following its instructions.` +
    `${fileClause}\n`,
  );
  process.exit(2);
}

runHook(main);
