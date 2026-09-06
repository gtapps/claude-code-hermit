// Posts one message into another Claude Code session's inbox socket.
// Zero npm dependencies, Node stdlib only.
// Usage: bun peer-post.ts <socket-path> <text>
//
// Exit 0 and print "sent" when the payload reached the socket; exit 1 and print
// "dead" when nothing was listening or the connect timed out. "sent" is not
// "delivered" — see scripts/lib/peer-post.ts for why the receiving session can
// still drop the message invisibly.
//
// CLAUDE_CODE_MESSAGING_TOKEN is passed through as the auth line when set,
// which is how a script posting to its OWN session identifies itself.

import { postToSession } from './lib/peer-post';

const socketPath = process.argv[2];
const text = process.argv[3];

if (!socketPath) {
  console.error('Usage: bun peer-post.ts <socket-path> <text>');
  process.exit(1);
}

if (!text) {
  console.error('[hermit] peer-post: empty message — nothing to send.');
  process.exit(1);
}

const verdict = await postToSession(socketPath, text, {
  token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
});

console.log(verdict);
process.exit(verdict === 'sent' ? 0 : 1);
