#!/usr/bin/env bash
set -euo pipefail

PORT="${KB2_PORT:-7382}"
HOST="${KB2_HOST:-127.0.0.1}"
BASE="http://$HOST:$PORT"
VAULT_ID="${KB1_VAULT_ID:-}"
FLUSH_VAULT="${KB1_FLUSH_VAULT:-0}"
LINUX_SERVICE_NAME="${KB1_SERVICE_NAME:-kb2d.service}"
MACOS_LABEL="${KB1_LAUNCHD_LABEL:-dev.metatheory.kb1.kb2d}"

say() { printf '\n==> %s\n' "$*"; }

close_mcp_session() {
  local session_id="$1"
  if [ -z "$session_id" ]; then
    return 0
  fi

  local close_code
  close_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X DELETE \
    -H "mcp-session-id: $session_id" \
    "$BASE/mcp" || true)"
  echo "DELETE $BASE/mcp session -> HTTP $close_code"
  case "$close_code" in
    200|202|204) return 0 ;;
    *)
      echo "MCP session close failed for $BASE/mcp (HTTP $close_code)" >&2
      return 1
      ;;
  esac
}

fail_mcp_probe() {
  local message="$1"
  local session_id="$2"
  local probe_out="$3"
  local probe_headers="$4"

  echo "$message" >&2
  if [ -s "$probe_out" ]; then
    cat "$probe_out" >&2 || true
  fi
  close_mcp_session "$session_id" || true
  rm -f "$probe_out" "$probe_headers"
  exit 1
}

say "Service status"
case "$(uname -s)" in
  Linux)
    systemctl --user is-active "$LINUX_SERVICE_NAME" || true
    ;;
  Darwin)
    launchctl print "gui/$(id -u)/$MACOS_LABEL" 2>/dev/null || true
    ;;
  *)
    echo "Unsupported OS for service status: $(uname -s)"
    ;;
esac

say "Recent logs"
case "$(uname -s)" in
  Linux)
    journalctl --user -u "$LINUX_SERVICE_NAME" -n 40 --no-pager || true
    ;;
  Darwin)
    tail -n 40 "$HOME/Library/Logs/kb1-daemon.err.log" 2>/dev/null || true
    tail -n 20 "$HOME/Library/Logs/kb1-daemon.out.log" 2>/dev/null || true
    ;;
esac

say "Health"
curl -fsS "$BASE/api/health"
printf '\n'

say "Vaults"
VAULTS_JSON="$(curl -fsS "$BASE/api/vaults")"
printf '%s\n' "$VAULTS_JSON"

if [ -n "$VAULT_ID" ]; then
  say "Vault info: $VAULT_ID"
  curl -fsS "$BASE/api/vaults/$VAULT_ID/vault"
  printf '\n'

  if [ "$FLUSH_VAULT" = "1" ]; then
    say "Flush: $VAULT_ID"
    curl -fsS -X POST "$BASE/api/vaults/$VAULT_ID/ops/flush"
    printf '\n'
  else
    echo "Skipping flush; set KB1_FLUSH_VAULT=1 with KB1_VAULT_ID=$VAULT_ID to verify writes."
  fi
else
  echo "No vault id selected; set KB1_VAULT_ID=<id> to check a specific vault." >&2
fi

say "MCP endpoint initialize probe"
probe_out="$(mktemp)"
probe_headers="$(mktemp)"
mcp_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"kb1-daemon-healthcheck","version":"0.1.0"}}}'
code="$(curl -sS -D "$probe_headers" -o "$probe_out" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data-binary "$mcp_payload" \
  "$BASE/mcp" || true)"
content_type="$(grep -i '^content-type:' "$probe_headers" | head -n 1 || true)"
session_header="$(grep -i '^mcp-session-id:' "$probe_headers" | head -n 1 || true)"
session_id=""
if [ -n "$session_header" ]; then
  session_id="$(printf '%s' "$session_header" | cut -d: -f2- | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
fi
echo "POST $BASE/mcp initialize -> HTTP $code ${content_type:+($content_type)}"

if [ "$code" != "200" ] && [ "$code" != "202" ]; then
  fail_mcp_probe "MCP endpoint is missing or rejected initialize at $BASE/mcp (HTTP $code)" "$session_id" "$probe_out" "$probe_headers"
fi

if ! printf '%s' "$content_type" | grep -Eiq 'application/json|text/event-stream'; then
  fail_mcp_probe "MCP endpoint did not return JSON or SSE content at $BASE/mcp" "$session_id" "$probe_out" "$probe_headers"
fi

if ! command -v node >/dev/null 2>&1; then
  fail_mcp_probe "node is required to validate the MCP initialize response" "$session_id" "$probe_out" "$probe_headers"
fi

if ! node - "$probe_out" <<'JS'
const fs = require('node:fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractMessages(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const direct = parseJson(trimmed);
  if (direct !== undefined) return Array.isArray(direct) ? direct : [direct];

  const messages = [];
  for (const event of value.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) continue;
    const parsed = parseJson(data);
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    }
  }
  return messages;
}

const response = extractMessages(raw).find((message) => message && message.id === 1);
if (!response || response.error) process.exit(1);

const result = response.result;
if (!result || typeof result !== 'object') process.exit(1);
if (typeof result.protocolVersion !== 'string' || result.protocolVersion.length === 0) process.exit(1);
if (!result.serverInfo || typeof result.serverInfo !== 'object') process.exit(1);
if (typeof result.serverInfo.name !== 'string' || result.serverInfo.name.length === 0) process.exit(1);
JS
then
  fail_mcp_probe "MCP initialize did not return a valid successful initialize result at $BASE/mcp" "$session_id" "$probe_out" "$probe_headers"
fi

if ! close_mcp_session "$session_id"; then
  rm -f "$probe_out" "$probe_headers"
  exit 1
fi

rm -f "$probe_out" "$probe_headers"

if command -v tailscale >/dev/null 2>&1; then
  say "Tailscale status"
  tailscale status || true
  say "Tailscale Serve status"
  tailscale serve status || true
fi
