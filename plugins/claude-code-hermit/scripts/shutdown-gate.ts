// UserPromptSubmit hook — deterministic shutdown gate.
//
// While a shutdown is pending (runtime.json has shutdown_requested_at set and
// shutdown_completed_at null), a <channel> message from an allowed sender gets a
// deterministic "shutting down" reply and is blocked from reaching the model, so
// the hermit stops accepting new work the instant a stop is in flight (the
// incident: the model kept taking channel tasks after acknowledging shutdown).
//
// Send-then-block, mirroring channel-status-responder: only emit
// {"decision":"block"} after a confirmed successful send, so a failed send never
// silently swallows the operator's message — it falls through with a narrow relay
// instruction instead. Non-channel prompts (operator terminal input, the internal
// /session-close command hermit-stop injects) are never a channel envelope and
// pass through untouched.

import { hermitDir } from './lib/cc-compat';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { loadConfig, isAllowedSender } from './lib/channel-auth';
import { readRuntimeJson } from './lib/runtime';
import { sendToChannel } from './lib/channel-send';
import { SHUTDOWN, resolveLocale } from './lib/messages';

type Json = any;

async function main(raw: string): Promise<void> {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
  if (!prompt) return;

  const envelope = parseChannelEnvelope(prompt);
  if (!envelope) return; // not a channel message — operator/internal input passes

  const dir = hermitDir();

  // Only gate a shutdown that is genuinely pending — check this before loading
  // config, since "no shutdown in flight" is the common case on every channel
  // message and this avoids a wasted config.json read for it.
  const runtime = readRuntimeJson();
  const pending = !!runtime && !!runtime.shutdown_requested_at && !runtime.shutdown_completed_at;
  if (!pending) return;

  const config = loadConfig(dir);
  if (!config) return;

  // Same allowed_users gating as the status responder — a sender the channel
  // wouldn't act on anyway needs no reply or block.
  if (!isAllowedSender(config, envelope.source, envelope.userId)) return;

  const locale = resolveLocale(config?.language);
  const reply = SHUTDOWN[locale].inProgress();
  const result = await sendToChannel(dir, reply, {
    target: { id: envelope.sourceKey, chat_id: envelope.chatId },
    timeoutMs: 6000,
  });
  if (result.ok) {
    console.log(JSON.stringify({ decision: 'block', reason: 'shutdown pending — deterministic reply sent' }));
    return;
  }

  // Deterministic delivery failed — don't block into silence. Inject a narrow
  // instruction so the model relays the shutdown state and starts no new work.
  process.stdout.write(
    `[shutdown] A shutdown is in progress for this hermit. Reply to the operator (on the chat this ` +
    `message arrived on) that you're shutting down and will be back after the restart, then stop — ` +
    `start no new work.\n`,
  );
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    main(buf)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
