---
name: docker-security
description: Opt-in advanced wizard for Docker security hardening beyond v1.0.26 baseline. Adds LAN containment with DNS policy (firewall + DNS sidecar), resource bounds with kernel hygiene sysctls, and a boot-time plugin install audit log. Each toggle is opt-in with honest cost/benefit framing, applied as a docker-compose overlay (does not modify the base compose file), verified against the live container, and fully reversible. Run after /docker-setup; requires bridge networking.
---

# Docker Security

Advanced hardening for already-deployed hermit containers. Each toggle is opt-in, presented with honest cost/benefit framing, and applied as a `docker-compose.security.yml` overlay that the `hermit-docker` wrapper auto-detects. Reversal: re-run and answer No to every prompt, or delete `docker-compose.security.yml` directly.

**Tone:** Honest about tradeoffs. Tell operators what each toggle does AND does not protect. Do not oversell.

**Important:** Run all checks and commands sequentially — do not use parallel tool calls.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/security/`.

## Trust model framing (read to operator at the start of step 2)

> Installing a plugin runs that plugin's hooks and skills with the same authority as hermit. The container hardening here reduces what a *compromised* plugin can do to the host kernel and your local network — it does not vet the plugin's intent, sandbox its file access within the project, or prevent it from acting on your behalf via the agent. A malicious or careless plugin still runs as you.
>
> **Honest limitation:** DNS policy below blocks domain-based exfil/C2 but cannot stop direct-IP egress to a hardcoded public address. A future release may add nftset-driven IP allowlisting.

## Plan

### 0. Refuse to run inside the hermit container

This skill is host-only — it writes a `docker-compose.security.yml` overlay on the host and recreates the container with stronger isolation.

Run: `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`

If the output is `container`, **stop immediately** — do not proceed to step 1. Print:

> This skill writes a `docker-compose.security.yml` overlay on the host and recreates the container with stronger isolation. Run it from your host shell in the project root. To inspect the live security posture *inside* the running container, run `/claude-code-hermit:hermit-doctor` — it includes a `docker-security` check.

### 1. Prerequisites

1. Read `.claude-code-hermit/config.json`. If missing: "Run `/claude-code-hermit:hatch` first." Stop.
2. Verify `docker-compose.hermit.yml` exists at the project root. If missing: "Run `/claude-code-hermit:docker-setup` first." Stop.
3. **Docker daemon check**: run `timeout 10s docker info >/dev/null 2>&1`. If it fails or times out: tell the operator "Docker daemon is not reachable or timed out. Start Docker before re-running `/docker-security`." Stop.
4. Read `docker.network_mode` from config (default: `"bridge"`). If `"host"`, set `HOST_NETWORK_MODE=true` and surface to operator: "Detected `network_mode: host` in your config. The LAN containment toggle (Prompt 1) will be skipped — it would replace host mode and break your HA / host-bound service access. Resource bounds (Prompt 2) will not apply network sysctls in host mode either; Docker rejects them and the container would fail to start."
5. **Detect hermit ports**: run `timeout 10s docker compose -f docker-compose.hermit.yml config --format json 2>/dev/null` and parse `.services.hermit.ports`. Store as in-memory `detected_hermit_ports` (array of long-form Compose port objects: `{target, published, host_ip, protocol, mode}`). If the command fails or returns no JSON, fall back to `grep -n '^\s*ports:' docker-compose.hermit.yml` and set `detected_hermit_ports_unparsed=true` if found. Either way, a non-empty result means ports are present.
6. Check whether the container is currently running: `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}' 2>/dev/null | grep -x hermit`. If absent: tell the operator "Container is not running. The wizard will still write the overlay; you'll see the live verification only after starting the container with `hermit-docker up`."
7. Read current `docker.security.*` from config.json. Also read `sandbox.*` from the target settings file (same `hatch_target` routing as hatch/docker-setup: `hatch_target == "local"` → `.claude/settings.local.json`; else → `.claude/settings.json`). Print a "current posture" summary. Example:

   ```
   Current security posture:
     LAN containment: off
     Resource bounds: off
     Audit log: off

   Baseline (always on, from v1.0.26):
     cap_drop: ALL, no-new-privileges, pids_limit: 2048

   Sandbox (bash tool isolation, from v1.1.2):
     profile: standard  (or: off / not configured)
     in-container: sandbox off (the container is the isolation boundary)
   ```

   Derive `profile` by checking `sandbox.enabled` in the settings file: `true` → `standard` (or the profile name if you can infer it from `filesystem.denyRead`), `false` → `off`, absent → `not configured`.

### 2. Trust model framing

Print the trust-model paragraph from the top of this file (the blockquote). Then continue.

### 3. Prompt 1 — LAN containment + DNS policy

If `HOST_NETWORK_MODE` is true, **do not present this prompt**. Tell the operator: "Skipping LAN containment — incompatible with `network_mode: host`. Run `/claude-code-hermit:docker-setup` to switch to bridge mode if you want this hardening." Continue to step 4.

Otherwise, ask with `AskUserQuestion` (header: `"LAN containment"`):

```
question: "Add LAN containment with DNS policy? (firewall sidecar + DNS allowlist)"
options:
  - label: "Yes — recommended (LAN block + DNS log-only)"
    description: "Blocks RFC1918 + cloud metadata. DNS in log-only mode: allows everything, logs blocked queries for tuning."
  - label: "Yes — strict (LAN block + DNS enforce)"
    description: "Same LAN block. DNS returns NXDOMAIN for any domain not on the allowlist."
  - label: "No"
    description: "Skip this toggle."
```

Map: `"Yes — recommended"` → `dns_mode: "log-only"`. `"Yes — strict"` → `dns_mode: "enforce"`. `"No"` → skip to step 4.

#### 3-pre. Port conflict handling (only if a "Yes" option was selected above)

If the operator selected a "Yes" option AND `detected_hermit_ports` is non-empty (or `detected_hermit_ports_unparsed=true`), surface a follow-up `AskUserQuestion` (header: `"Port publishing"`) immediately:

```
Your docker-compose.hermit.yml publishes ports on the hermit service:
  - "3000:3000"        ← list each port if parsed, or "(port block detected)" if unparsed
  ...

LAN containment requires hermit to share hermit-netguard's network namespace.
Docker forbids `ports:` on a container that joins another container's netns —
only netguard (the netns owner) can publish ports.
```

Options:
- `"Move ports to netguard (recommended)"` — render the same `ports:` block on `hermit-netguard` in the overlay. Persist to `docker.security.network.publish_ports`. After overlay is written (step 6), show a diff and prompt the operator to delete the `ports:` block from `docker-compose.hermit.yml` themselves — the wizard does not modify the base file.
- `"Skip LAN containment (keep ports on hermit)"` — clear the LAN containment selection (treat as if operator answered No above). Set `lan_containment_skipped_due_to_ports=true`. Continue to step 4.
- `"Cancel"` — print "Re-run /docker-security after deciding how to handle your port publishing. See docs/docker-security.md for guidance." Exit. Write nothing.

**If operator chose "Skip LAN containment"**: proceed to step 4 without any LAN containment config. Step 9 final-report notes: "LAN containment skipped — docker-compose.hermit.yml has a `ports:` block on hermit that is incompatible with `network_mode: service:hermit-netguard`."

#### 3a. Fleet-aware domain seeding

Scan installed fleet plugins. From the host:

```bash
claude plugin list --json 2>/dev/null
```

Apply the **project-or-local + enabled filter**:

- Keep `enabled == true` AND (`scope == "project"` OR `scope == "local"`) AND `projectPath` equals the current project root.
- Drop user-scope, managed-scope, disabled, and cross-project entries.

For each surviving entry whose plugin name (substring of `id` left of `@`) matches `*-hermit*` and is NOT `claude-code-hermit`:

1. Locate the plugin's installed root using the `installPath` field from the JSON.
2. Read `<plugin>/skills/hatch/SKILL.md` and look for a `## Docker network requirements` heading. Also check `<plugin>/DOCKER.md`. Stop at the next `##` heading.
3. Within that section, parse:
   - `### Domains (DNS allowlist)` — bullet entries are domain names. Validate against `^[a-z0-9][a-z0-9.-]+$`. Reject failing entries with a warning.
   - `### LAN allowlist suggestions` — bullet entries are either IPv4 CIDRs (validate with regex) OR the special token `ASK_OPERATOR_FOR_HA_IP` (or other `ASK_OPERATOR_FOR_*_IP` patterns). Reject failing CIDRs.
4. Track provenance: each entry remembers which plugin contributed it.

If the deduped fleet list is non-empty, present plain text first:

```
Fleet plugins request these network exceptions:
  api.strava.com           — claude-code-fitness-hermit (DNS)
  www.strava.com           — claude-code-fitness-hermit (DNS)
  ASK_OPERATOR_FOR_HA_IP   — claude-code-homeassistant-hermit (LAN, will prompt for IP)
```

Then ask once with `AskUserQuestion` (header: `"Fleet network entries"`):

- `"Include all"` (Recommended)
- `"Pick each"`
- `"Skip all"`

On `"Pick each"`: loop through each entry with a 2-option `AskUserQuestion` (`"Include"` / `"Skip"`).

For every confirmed `ASK_OPERATOR_FOR_HA_IP` (or similar): immediately follow up with `AskUserQuestion` (header: `"<plugin> IP"`) — Other field accepting an IPv4 address or CIDR. Validate. Re-prompt on invalid. Replace the token with the typed value.

Confirmed entries are added to in-memory `fleet_lan_allowlist` and `fleet_domains` for step 6.

If the fleet list is empty: skip silently.

#### 3b. Extra LAN carve-outs

`AskUserQuestion` (header: `"Extra LAN carve-outs"`):

- `"None"`
- `"Add IPs/ranges"` (Other field, comma-separated, IPv4 CIDR validated; re-prompt on invalid)

Persist to `lan_allowlist` (combined with `fleet_lan_allowlist`).

#### 3c. Extra domains

`AskUserQuestion` (header: `"Extra domains"`):

- `"None (use defaults + fleet)"`
- `"Add domains"` (Other field, comma-separated, domain regex validated; re-prompt on invalid)

Persist to `additional_domains` (combined with `fleet_domains`).

#### 3d. Persist Prompt 1 selections

```json
docker.security.network = {
  "enabled": true,
  "dns_mode": "log-only" | "enforce",
  "lan_allowlist": ["192.168.1.50", ...],
  "additional_domains": ["api.strava.com", ...]
}
```

### 4. Prompt 2 — Resource bounds + kernel hygiene

`AskUserQuestion` (header: `"Resource bounds"`):

```
question: "Set memory and CPU caps + network kernel hardening sysctls?"
options:
  - label: "Yes — defaults (mem 4g, cpus 2.0, sysctl bundle)"
    description: "Caps a runaway agent's resource cost; sysctls disable ICMP redirect / source-routing tricks."
  - label: "Yes — custom mem/cpu"
    description: "Pick your own memory and CPU limits."
  - label: "No"
    description: "Skip this toggle."
```

On `"Yes — custom mem/cpu"`: follow up with `AskUserQuestion` (header: `"Custom limits"`) — Other field accepting two values, comma-separated. Validate `mem` against `^[0-9]+(g|m)?$`, `cpus` against `^[0-9.]+$`. Re-prompt on invalid.

**Sysctl placement note**:
- If `HOST_NETWORK_MODE` is true: silently set `sysctls_enabled = false` regardless of choice and tell the operator: "Network sysctls cannot be applied with `network_mode: host` — Docker rejects them. Resource bounds (mem/cpus) will still apply if you said Yes."
- Otherwise: `sysctls_enabled = true`.

Persist:

```json
docker.security.resources = {
  "enabled": true,
  "mem_limit": "4g",
  "memswap_limit": "4g",
  "cpus": 2.0,
  "sysctls_enabled": true|false
}
```

### 5. Prompt 3 — Plugin install audit log

`AskUserQuestion` (header: `"Audit log"`):

```
question: "Record every boot-time plugin install to a JSONL audit log?"
options:
  - label: "Yes — recommended"
    description: "Appends one JSONL line per `claude plugin install` performed by the entrypoint to .claude-code-hermit/state/plugin-installs.jsonl. Honest scope: post-boot installs run via tmux are not captured. The log is empty until something actually installs — on subsequent boots when the marketplace + plugin set is unchanged, no install fires and no entry is written. That's normal, not a failure."
  - label: "No"
    description: "Skip this toggle."
```

Persist `docker.security.audit.plugin_installs` accordingly.

### 6. Render overlay

**Before rendering — preserve `publish_ports` across reruns:**
Read `docker.security.network.publish_ports` from the existing config.json (if present). Keep this as `persisted_publish_ports`. In the current wizard run:
- If the operator chose "Move ports to netguard": replace `persisted_publish_ports` with the newly detected ports from step 5 (prerequisites).
- If no base ports were detected AND the operator did not visit the port-conflict flow: keep `persisted_publish_ports` unchanged (the operator already deleted the base block; do not lose the netguard mapping).
- If the operator chose "Skip LAN containment (keep ports on hermit)": set `persisted_publish_ports = []` (LAN containment is off; ports stay on hermit in the base file).

**All-off branch — warn before deletion if `publish_ports` was set:**
Otherwise (all toggles off): before deleting the overlay, check if `persisted_publish_ports` is non-empty. If so, surface:

```
Heads up: turning all toggles off will remove the overlay, including these
ports that hermit-netguard currently publishes:
  - "3000:3000"
  ...

If you previously deleted the `ports:` block from docker-compose.hermit.yml,
you'll need to re-add it there before bringing the container back up — the
overlay won't be there to publish them.
```

Then `AskUserQuestion` (header: `"Confirm all-off"`):
- `"Yes — proceed (I'll restore base ports if needed)"`
- `"No — cancel"`

On Yes: continue to overlay deletion, clear `docker.security.*`, tell the operator "All toggles off — overlay removed and config cleared." Skip to step 9.
On No: exit wizard, write nothing.

If `persisted_publish_ports` is empty: proceed directly to deletion without the prompt.

**Subnet auto-detection (only if LAN containment is enabled):**

Run the following to enumerate occupied subnets across **all** Docker networks (not filtered to bridge — overlap is address-space-based):

```bash
timeout 10s docker network ls --format '{{.Name}}' 2>/dev/null | while read net; do
  timeout 5s docker network inspect "$net" \
    --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}|||{{json .Labels}}' 2>/dev/null
done
```

Parse each output line into a subnet string and a Labels JSON object. Skip lines without IPv4 subnets.

**Exclude** networks belonging to this project's own `hermit-net` from the collision list. Identify these by labels:
- `com.docker.compose.project == <our project name>` AND `com.docker.compose.network == "hermit-net"`

Derive `<our project name>` from `timeout 10s docker compose -f docker-compose.hermit.yml config --format json 2>/dev/null | bun -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).name ?? "")'` — fall back to `basename "$PROJECT_DIR"` if the command fails.

Check subnet overlap with a `bun -e` snippet (convert each /24 candidate and occupied CIDR to an integer range and compare). Walk candidate /24 subnets in order: `172.28.0.0/24`, `172.29.0.0/24`, `172.30.0.0/24`, `172.31.0.0/24`, `10.244.0.0/24`, `10.245.0.0/24`, `10.246.0.0/24`, `10.247.0.0/24`. Pick the first that doesn't overlap any occupied subnet. Treat parse failures as "subnet unknown, skip."

If all candidates collide, `AskUserQuestion` (header: `"Custom subnet"`) with Other field accepting an IPv4 /24 CIDR (reject if prefix != 24; re-prompt on invalid or still-colliding).

Compute `chosen_gateway = <base>.0.1`, `chosen_netguard_ip = <base>.0.2`. Persist to `docker.security.network`:

```json
{
  "enabled": true,
  "dns_mode": "log-only" | "enforce",
  "subnet": "172.28.0.0/24",
  "gateway": "172.28.0.1",
  "netguard_ip": "172.28.0.2",
  "lan_allowlist": [...],
  "additional_domains": [...],
  "publish_ports": [...]
}
```

If LAN containment is not enabled, omit `subnet`, `gateway`, `netguard_ip` from the `docker.security.network` object.

If at least one toggle is enabled, render the overlay. Otherwise (all-off): handled in the all-off branch above.

#### 6a. dnsmasq UID is hardcoded

Render `100` directly into `nftables.conf` as the dnsmasq UID — no probe step. Rationale and recovery path if Alpine ever changes it: see [docs/docker-security.md#design-rationale](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/docker-security.md#design-rationale).

After the netguard files are rendered (step 6c), the wizard runs an explicit `--no-cache` build of `hermit-netguard` to prevent stale Docker cache artifacts from surviving a hermit upgrade. Do not rely on `hermit-docker up` to trigger a rebuild.

#### 6b. Write the overlay

Render `docker-compose.security.yml` from `state-templates/docker/security/docker-compose.security.yml.template` by substituting the placeholder blocks. The template has placeholders:

- `{{NETWORKS_BLOCK}}` — empty unless Prompt 1 enabled. When enabled, substitute `chosen_subnet` and `chosen_gateway` from the subnet auto-detection step above:
  ```yaml
  networks:
    hermit-net:
      driver: bridge
      ipam:
        config:
          - subnet: <chosen_subnet>
            gateway: <chosen_gateway>
  ```
- `{{HERMIT_NETGUARD_SERVICE}}` — empty unless Prompt 1 enabled. When enabled, substitute `chosen_netguard_ip` and `dns_log_only`. Also render `{{NETGUARD_PORTS_BLOCK}}` (see below):
  ```yaml
    hermit-netguard:
      build:
        context: ./.claude-code-hermit/docker
        dockerfile: Dockerfile.hermit-netguard
      # NET_BIND_SERVICE: dnsmasq retains it post-bind-drop. SETUID+SETGID:
      # drops to UID/GID 100 (Alpine's `dnsmasq` user).
      cap_add: [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]
      cap_drop: [ALL]
      security_opt:
        - no-new-privileges:true
      pids_limit: 256
      networks:
        hermit-net:
          ipv4_address: <chosen_netguard_ip>
      volumes:
        - ./.claude-code-hermit/docker/nftables.conf:/etc/nftables.conf:ro
        - ./.claude-code-hermit/docker/dnsmasq.allowlist:/etc/dnsmasq.allowlist:ro
      environment:
        - DNS_LOG_ONLY=<dns_log_only>
      restart: unless-stopped
      {{NETGUARD_SYSCTLS}}
      {{NETGUARD_PORTS_BLOCK}}
      healthcheck:
        test: ["CMD-SHELL", "nft list ruleset | grep -q 'table inet firewall' && (! [ -f /etc/dnsmasq.allowlist ] || pgrep dnsmasq)"]
        interval: 10s
        timeout: 5s
        retries: 3
        start_period: 5s
  ```
  Where `<dns_log_only>` = `"1"` if `dns_mode == "log-only"` else `"0"`. `{{NETGUARD_SYSCTLS}}` is the sysctls block from below if Prompt 2 enabled AND Prompt 1 enabled (sysctls live on netguard, the netns owner).

  **`{{NETGUARD_PORTS_BLOCK}}`** — empty unless `persisted_publish_ports` is non-empty AND Prompt 1 is enabled. When non-empty, render as long-form YAML using the parsed port objects (`target`, `published`, `host_ip`, `protocol`, `mode`). Omit `host_ip` if `"0.0.0.0"` (Compose default). Omit `mode` if `"ingress"` (Compose default for non-swarm). Example for two ports:
  ```yaml
      ports:
        - target: 3000
          published: "3000"
          protocol: tcp
        - target: 8080
          published: "8080"
          protocol: tcp
  ```
  If the ports were detected via grep fallback (`detected_hermit_ports_unparsed=true`) and no parsed shape is available, leave `{{NETGUARD_PORTS_BLOCK}}` empty and tell the operator: "Could not parse port shapes from the compose config — manually add your `ports:` block to `hermit-netguard` in the rendered overlay and delete it from the base file."
- `{{HERMIT_NETWORK_MODE}}` — empty unless Prompt 1 enabled. When enabled:
  ```yaml
      network_mode: "service:hermit-netguard"
      depends_on:
        hermit-netguard:
          condition: service_healthy
  ```
- `{{HERMIT_RESOURCE_BOUNDS}}` — empty unless Prompt 2 enabled. When enabled:
  ```yaml
      mem_limit: 4g
      memswap_limit: 4g
      cpus: 2.0
  ```
  (Custom values substituted if operator provided them.)
- `{{HERMIT_SYSCTLS_ON_HERMIT}}` — sysctls block from below ONLY if Prompt 2 enabled, `sysctls_enabled` is true, AND Prompt 1 is OFF. (When Prompt 1 is on, sysctls go on netguard via `{{NETGUARD_SYSCTLS}}`.)
- `{{HERMIT_AUDIT_ENV}}` — empty unless Prompt 3 enabled. When enabled:
  ```yaml
      environment:
        - HERMIT_PLUGIN_INSTALL_AUDIT=1
  ```

The shared sysctls block (used in either `{{NETGUARD_SYSCTLS}}` or `{{HERMIT_SYSCTLS_ON_HERMIT}}`):

```yaml
      sysctls:
        - net.ipv4.conf.all.accept_redirects=0
        - net.ipv4.conf.all.send_redirects=0
        - net.ipv4.conf.all.accept_source_route=0
        - net.ipv4.conf.default.accept_redirects=0
```

#### 6c. Write Dockerfile + entrypoint + nftables + dnsmasq files (only if Prompt 1 enabled)

Copy from `state-templates/docker/security/` into `.claude-code-hermit/docker/`:

- `Dockerfile.hermit-netguard.template` → `Dockerfile.hermit-netguard`
- `netguard-entrypoint.sh.template` → `netguard-entrypoint.sh` (chmod +x)
- `nftables.conf.template` → `nftables.conf`, substituting:
  - `{{LAN_ALLOWLIST_RULES}}` → for each entry in `lan_allowlist`, render `        ip daddr <entry> accept` (8-space indent matching the chain body). Empty string if no entries.
  - `{{DNSMASQ_UID}}` → the literal string `100` (Alpine dnsmasq's static UID — see step 6a).
- `dnsmasq.allowlist.template` → `dnsmasq.allowlist`, substituting:
  - `{{FLEET_DOMAINS}}` → for each fleet domain, render `server=/<domain>/1.1.1.1` with a comment line above grouping by source plugin. Empty string if no entries.
  - `{{ADDITIONAL_DOMAINS}}` → for each operator-added domain, render `server=/<domain>/1.1.1.1`. Empty string if no entries.

After all files are copied, force a fresh netguard image build:

```bash
timeout 180s docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml build --no-cache hermit-netguard
```

If the build exits non-zero, run `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml logs hermit-netguard --tail=30`, surface the output, and suggest a targeted fix:
- **`apk add` fails** → DNS not reachable at build time; check host network and Docker DNS config (`/etc/docker/daemon.json`)
- **Syntax error in nftables.conf or dnsmasq.allowlist** → read the error line; it usually names the file and line number
- **Port already in use** → a published port in the overlay conflicts; `ss -tlnp | grep <port>` finds the owner
Then stop. Do not proceed to step 6d.

#### 6d. Show diff + confirm

Print a one-screen summary of files written (paths + line counts). Ask `AskUserQuestion` (header: `"Apply"`) — `"Yes — restart container now"` / `"No — I'll restart manually later"`.

On `"No — I'll restart manually later"`: skip to step 9 with the note "Overlay written. Run `hermit-docker down` then `hermit-docker up` when ready to apply. Re-run `/docker-security` at any time to verify."

### 7. Restart + smoke test

**Hard gate — re-check base ports before starting:**
Before running `hermit-docker up`, re-run the step 5 port detection: `timeout 10s docker compose -f docker-compose.hermit.yml config --format json 2>/dev/null | bun -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log((((d.services ?? {}).hermit ?? {}).ports ?? []).length)'`. If the result is non-zero (or the command output from the grep fallback is non-empty) AND `docker.security.network.enabled === true` (LAN containment is on):

Ask with `AskUserQuestion` (header: `"Ports conflict"`):
- `"Auto-fix — I'll remove the \`ports:\` block (backup first)"` (Recommended)
- `"I'll edit it myself — pause here"`

**On "Auto-fix":** Back up the base compose file first: `cp docker-compose.hermit.yml docker-compose.hermit.yml.bak`. Then read `docker-compose.hermit.yml`, locate the `ports:` key under the `hermit:` service, and remove it and all its child lines (keep every other key). Write the file back. Print: "Removed `ports:` block from docker-compose.hermit.yml (backup: docker-compose.hermit.yml.bak). Ports are now published by hermit-netguard via the overlay." Continue to the restart sequence below ("If operator chose to restart now...").

**On "I'll edit it myself":** Print:
```
Cannot start container — docker-compose.hermit.yml still publishes ports on hermit.
Those ports are now published by hermit-netguard via the overlay.
Delete the `ports:` block from docker-compose.hermit.yml, then run:
  .claude-code-hermit/bin/hermit-docker up
```
Stop here. Tell the operator: "Overlay and config have been written — just delete the base `ports:` block first, then run `.claude-code-hermit/bin/hermit-docker up`."

If operator chose to restart now AND container was running before this skill (and the hard gate passed):

1. Run `.claude-code-hermit/bin/hermit-docker down`.
2. Run `.claude-code-hermit/bin/hermit-docker up` (the wrapper now picks up the overlay automatically). The first up will trigger `docker compose build hermit-netguard` if Prompt 1 was enabled — wait for completion (can be 30-60s on first build).
3. Poll `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml ps --status running --format '{{.Service}}'` every 2s for up to 30s; expect `hermit` (and `hermit-netguard` if Prompt 1 enabled). If either is missing after 30s: run `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml logs <missing-service> --tail=30` (substitute `hermit` or `hermit-netguard` per the missing service; omit the service name if both are down), surface output, and suggest:
   - **hermit-netguard won't start** → nftables or dnsmasq config error; read the log for the line number
   - **hermit won't start** → check if the base `ports:` conflict was fully resolved (re-run the hard gate port check above)
   - **Both down** → Docker daemon issue; `docker info` to confirm daemon is healthy
   Then stop.
### 8. Verify

Run the verification block via `docker exec hermit sh -c '...'`. The hermit base image has `bun`, `jq`, `curl`, and glibc (`getent`) — no `python3`, `nc`, or `nslookup`. Use bun and getent.

```bash
docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml \
  exec -T hermit sh -s <<'VERIFY_EOF'
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
VERIFY_EOF
```

Surface the output to the operator. Suggest: "Run `/claude-code-hermit:hermit-doctor` to also verify the docker-security check shows green."

### 9. Final report

Print a brief summary:

```
docker-security applied — current posture:
  LAN containment:   on  (DNS log-only)  | LAN carve-outs: 192.168.1.50
  Resource bounds:   on  (mem 4g, cpus 2.0)
  Audit log:         on

Reverse: re-run /docker-security and answer No to every prompt, OR
         delete docker-compose.security.yml and re-run hermit-docker up.

Tune DNS allowlist: edit .claude-code-hermit/docker/dnsmasq.allowlist,
         then `hermit-docker down && hermit-docker up`
         (restart hermit-netguard alone leaves hermit with stale resolver state).
```

## Notes

**Reversal, limitations, DNS allowlist tuning, and design rationale**: see [docs/docker-security.md](https://github.com/gtapps/claude-code-hermit/blob/main/plugins/claude-code-hermit/docs/docker-security.md).
