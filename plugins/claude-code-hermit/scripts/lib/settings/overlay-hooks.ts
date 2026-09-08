import path from 'node:path';

export function overlayHooks(pluginRoot: string) {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: [path.resolve(pluginRoot, 'scripts', 'pause-gate.ts')],
          timeout: 3,
        }],
        description: 'Deny every tool call while state/pause.json is set, except a channel reply tool and PushNotification',
      },
      {
        matcher: 'AskUserQuestion',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: [path.resolve(pluginRoot, 'scripts', 'ask-gate.ts')],
          timeout: 3,
        }],
        description: 'Deny AskUserQuestion on always-on channel-primary sessions with a redirect to the channel reply tool + micro-proposal bridge (binds the callers the static contract test cannot see)',
      },
    ],
    PermissionDenied: [
      {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: [path.resolve(pluginRoot, 'scripts', 'permission-denied-notify.ts')],
          timeout: 12,
        }],
        description: 'Record a deduped maintainer-tier denial diagnostic on the managed unattended session: tool name and reason to the maintainer chat, else Findings; no client message',
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: [path.resolve(pluginRoot, 'scripts', 'component-privacy.ts')],
          timeout: 5,
        }],
        description: 'Keep a hermit-created skill/agent private to this install (git-common-dir info/exclude) when hatch_target is local and the write came from the managed always-on session',
      },
    ],
  };
}
