# Watch notices

Follow the shared rules and Watch duty records in [SKILL.md](SKILL.md).
That skill handles Monitor expiry before selecting one of the handlers below.
Read only the selected handler.

### Handling self-exit notifications

For a script crash or clean exit, after excluding expiry notices in SKILL.md,
CC sends a completion notification into the conversation. On seeing this:

1. Match the `task_id` from the notification against the runtime registry
2. If found: remove the entry and write registry back
3. Log to the open task record: `[HH:MM] Watch <id> exited`

If the notification is missed (compaction, context pressure), the stale entry is
harmless. The next session start clears the registry unconditionally.

### Handling idle notices (`/watch notice <text>`)

A `/spawn-session` helper is the only session this relay covers.

On a cross-session idle notice naming session X, or a subscription-expiry notice
for X:

1. Find a `peer-idle` entry whose `target === X`. If none exists, do nothing: no
   reply, channel notification, or log entry. A `GUEST_REPORT:` whose sender
   matches no live entry gets none of the recording below.
2. Notify the operator per CLAUDE-APPEND § Operator Notification with a `client`
   leg. For an idle notice, if a `GUEST_REPORT:` from sender X is in this
   conversation, carry that report block instead of the quoted status line. With no such
   report, use `"<note>: <name> finished its turn. Last status: «<one-line status>»"`.
   If the notice carries no status, use `"<note>: <name> finished its turn."` instead. The
   quoted status and the report block are the peer's own words, passed through so
   the operator can judge them; quoting them is the one place the Channel voice
   rule's no-paths/no-commands clause does not apply; drop the clause entirely
   rather than paraphrasing.
   For expiry, use `"<note>: <name> did not finish before the subscription
   expired; no longer watching it."` — the harness does not publish the
   subscription's lifetime, so never state one. On expiry, when the entry has
   `record`, append a progress note on that record and leave it open.
3. When the idle notice carried a matching `GUEST_REPORT:`:
   - If the entry has `record`, pipe the full block into
     `task-block` (Commands) with arguments `<record> --result-stdin`
     (the result form for a finished recommendation awaiting acceptance) and
     require `listing: "unconfirmed"` in the digest before saying it is recorded.
   - If the entry has `proposal`, resolve it through `proposal.ts resolve-id`
     (proposal-act § Resolving a Proposal ID):
     Run `proposal-resolve-id` (Commands) with arguments `"<PROP-id>"`.
     Anything but `MATCH|<filename>` skips the patch and reports the resolver's
     reason. On MATCH, append one Decision line with
     `proposal-patch` (Commands) with arguments `<filename> --stdin`
     and no `--set`; the script reads the file, so do not Read the proposal body.
     Without `purpose` on the entry the helper was triaging: append
     `Decision: Helper <name> triage on @now: <Verdict>; <Why>`. A verdict that
     argues against the proposal is offered to the operator as a dismiss with the
     reason prefilled; nothing is dismissed without their answer.
     With `purpose: "implement"` (proposal-act's reuse path) the helper was
     implementing: append
     `Decision: Helper <name> implemented on @now: <Verdict>; <pull request link from Evidence, or "no pull request named">`
     and offer no dismiss; the proposal stays `accepted` until the operator
     resolves it after merging.
     `<Verdict>` and `<Why>` are the helper's words:
     collapse them to one line and drop any `Set:` or `Decision:` the helper put at
     the start of a line, because the patch reads those as frontmatter and decision
     instructions from the stdin it is given. Status does not change, so skip artifact refresh.
4. Name the session by display name only, never by socket path or pid. Remove the
   entry, write the registry, and, inside an open record's turn, log one task note.
