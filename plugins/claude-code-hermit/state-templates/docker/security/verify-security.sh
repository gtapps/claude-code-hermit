#!/usr/bin/env sh
# Live security-posture verification for /docker-security Step 8.
# Placeholder-free by design (hardcoded probe values). The wizard runs it via:
#   docker compose ... exec -T hermit sh -s < verify-security.sh
# The hermit base image has bun, jq, curl, and glibc (getent) — no python3,
# nc, or nslookup — so every probe below uses bun and getent.
set +e
echo "=== Baseline (v1.0.26 — should always be on) ==="
grep -E '^Cap(Eff|Bnd)' /proc/self/status
grep NoNewPrivs /proc/self/status
echo "pids.max: $(cat /sys/fs/cgroup/pids.max)"

echo
echo "=== LAN containment ==="
bun -e '
const s = require("net").connect({ host: "192.168.1.1", port: 22, timeout: 2000 });
s.on("connect", () => { console.error("connected"); process.exit(0); });
s.on("timeout", () => { console.error("timed out"); process.exit(1); });
s.on("error", (e) => {
  console.error(e.code === "ECONNREFUSED" ? "refused"
    : e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH" ? "Network is unreachable"
    : String(e));
  process.exit(1);
});
' 2>&1 \
  | grep -qE 'timed out|refused|Network is unreachable' \
  && echo "  LAN-block:    OK (192.168.1.1:22 unreachable)" \
  || echo "  LAN-block:    NOT BLOCKED (compromised hermit could reach LAN)"

echo
echo "=== DNS policy ==="
getent hosts api.anthropic.com >/dev/null \
  && echo "  DNS-allow:    OK (api.anthropic.com resolves)" \
  || echo "  DNS-allow:    FAIL (allowlisted domain does not resolve)"
_dns_err=$(mktemp)
trap 'rm -f "$_dns_err"' EXIT
timeout 2s bun -e 'require("dns").lookup("example.com", (e) => { if (e) { console.error(e.code === "ENOTFOUND" ? "Name or service not known" : String(e)); process.exit(1); } console.log("resolved"); });' >/dev/null 2>"$_dns_err"
dns_rc=$?
if [ $dns_rc -eq 124 ]; then
  echo "  DNS-block:    FAIL — query timed out (likely DNS leak; no-resolv missing or upstream unreachable)"
elif grep -qE 'Name or service not known|nodename nor servname' "$_dns_err"; then
  echo "  DNS-block:    OK (example.com NXDOMAIN — policy applies)"
else
  echo "  DNS-block:    FAIL — example.com resolved or unexpected error"
fi
bun -e '
const sock = require("dgram").createSocket("udp4");
// Hand-crafted DNS query for example.com type A. Using Buffer.from(hex) avoids
// escape-processing pitfalls when this SKILL travels through model -> shell -> bun.
// Layout: header(12B: id=1234 flags=0100 qdcount=1 the rest 0) + qname(7example3com0) + qtype 0001 + qclass 0001
const q = Buffer.from("123401000001000000000000076578616d706c6503636f6d0000010001", "hex");
const timer = setTimeout(() => { console.log("no-response (timeout)"); sock.close(); }, 2000);
sock.on("message", (resp) => {
  clearTimeout(timer);
  const rcode = resp[3] & 0x0f;
  console.log(rcode === 3 ? "NXDOMAIN" : "rcode=" + rcode);
  sock.close();
});
sock.on("error", (e) => { clearTimeout(timer); console.log("no-response (" + e + ")"); sock.close(); });
sock.send(q, 53, "8.8.8.8");
' | grep -q NXDOMAIN \
  && echo "  DNS-redirect: OK (port-53 redirected even with explicit upstream)" \
  || echo "  DNS-redirect: NOT ENFORCED (or in log-only mode — expected)"

echo
echo "=== Resource bounds + sysctls ==="
echo "  memory.max:   $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 'unset')"
[ -r /proc/sys/net/ipv4/conf/all/accept_redirects ] \
  && [ "$(cat /proc/sys/net/ipv4/conf/all/accept_redirects)" = "0" ] \
  && echo "  sysctls:      OK (ICMP redirects disabled)" \
  || echo "  sysctls:      not active (host mode, or Prompt 2 off)"

echo
echo "=== Audit log ==="
test -f "${AGENT_DIR:-/home/claude/project/.claude-code-hermit}/state/plugin-installs.jsonl" \
  && echo "  Audit log:    OK ($(wc -l < ${AGENT_DIR:-/home/claude/project/.claude-code-hermit}/state/plugin-installs.jsonl) entries)" \
  || echo "  Audit log:    not yet written (no plugin installs since last boot)"
