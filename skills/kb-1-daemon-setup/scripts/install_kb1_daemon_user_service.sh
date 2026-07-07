#!/usr/bin/env bash
set -euo pipefail

# Install/update the KB-1 daemon repo, build it, install a user-level service,
# verify local health, optionally configure local MCP clients, and leave network
# exposure local-only unless the caller explicitly opts into Tailscale Serve.
#
# Defaults:
#   KB1_REPO_URL=https://github.com/metatheoryinc/kb-1-daemon.git
#   KB1_REPO_DIR=$HOME/repos/kb-1-daemon
#   KB1_HOME=$HOME/.kb1              # legacy KB2_HOME is accepted as fallback
#   KB1_HOST=127.0.0.1               # legacy KB2_HOST is accepted as fallback
#   KB1_PORT=7382                    # legacy KB2_PORT is accepted as fallback
#   KB1_RUN_CHECKS=1
#   KB1_TAILSCALE_MODE=local-only        # local-only|auto|serve
#   KB1_CONFIRM_TAILSCALE_EXPOSURE=0     # must be 1 for auto/serve
#   KB1_CONFIRM_NON_LOOPBACK_BIND=0      # must be 1 for non-loopback KB1_HOST
#   KB1_TAILSCALE_HTTPS_PORT=443

REPO_URL="${KB1_REPO_URL:-https://github.com/metatheoryinc/kb-1-daemon.git}"
REPO_DIR="${KB1_REPO_DIR:-$HOME/repos/kb-1-daemon}"
KB1_HOME="${KB1_HOME:-${KB2_HOME:-$HOME/.kb1}}"
KB1_HOST="${KB1_HOST:-${KB2_HOST:-127.0.0.1}}"
KB1_PORT="${KB1_PORT:-${KB2_PORT:-7382}}"
RUN_CHECKS="${KB1_RUN_CHECKS:-1}"
CONFIRM_NON_LOOPBACK_BIND="${KB1_CONFIRM_NON_LOOPBACK_BIND:-0}"
TAILSCALE_MODE="${KB1_TAILSCALE_MODE:-local-only}"
if [ "${KB1_ENABLE_TAILSCALE_SERVE:-0}" = "1" ]; then
  TAILSCALE_MODE="serve"
fi
CONFIRM_TAILSCALE_EXPOSURE="${KB1_CONFIRM_TAILSCALE_EXPOSURE:-0}"
TAILSCALE_HTTPS_PORT="${KB1_TAILSCALE_HTTPS_PORT:-443}"
LINUX_SERVICE_NAME="${KB1_SERVICE_NAME:-kb2d.service}"
MACOS_LABEL="${KB1_LAUNCHD_LABEL:-dev.metatheory.kb1.kb2d}"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }

is_loopback_host() {
  case "$KB1_HOST" in
    localhost|::1|'[::1]') return 0 ;;
  esac

  if [[ "$KB1_HOST" =~ ^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    local octet
    for octet in "${BASH_REMATCH[@]:1}"; do
      if (( 10#$octet > 255 )); then
        return 1
      fi
    done
    return 0
  fi

  return 1
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

detect_platform() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'macos' ;;
    *)
      echo "Unsupported OS for service installation: $(uname -s). Use the manual foreground run path." >&2
      exit 1
      ;;
  esac
}

print_tailscale_install_steps() {
  cat <<EOF

Tailscale is not installed on this machine, so KB-1 remains local-only.
To make KB-1 reachable from a phone or laptop later:

1. Install Tailscale on this host from https://tailscale.com/download.
2. Sign in on this host.
3. Install Tailscale on the phone/laptop and sign into the same tailnet.
4. Re-run with KB1_TAILSCALE_MODE=auto KB1_CONFIRM_TAILSCALE_EXPOSURE=1 after approving exposure.

Local app/API:
   http://127.0.0.1:$KB1_PORT
EOF
}

print_tailscale_login_steps() {
  cat <<EOF

Tailscale is installed but is not connected/logged in, so KB-1 remains local-only.
Connect this host, then re-run with explicit approval if private tailnet access is desired:

   KB1_TAILSCALE_MODE=auto KB1_CONFIRM_TAILSCALE_EXPOSURE=1 bash scripts/install_kb1_daemon_user_service.sh

Local app/API:
   http://127.0.0.1:$KB1_PORT
EOF
}

maybe_tailnet_url() {
  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    local status_json
    status_json="$(mktemp)"
    tailscale status --json >"$status_json" 2>/dev/null || {
      rm -f "$status_json"
      return 0
    }
    python3 - "$status_json" <<'PY' || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    raise SystemExit(0)
self_node = data.get("Self") or {}
dns = (self_node.get("DNSName") or "").rstrip(".")
if dns:
    print(f"https://{dns}")
PY
    rm -f "$status_json"
  fi
}

configure_tailscale_serve() {
  case "$TAILSCALE_MODE" in
    auto|local-only|serve) ;;
    *)
      warn "Unknown KB1_TAILSCALE_MODE=$TAILSCALE_MODE; expected local-only, auto, or serve. Leaving Tailscale unchanged."
      TAILSCALE_MODE="local-only"
      ;;
  esac

  if [ "$TAILSCALE_MODE" = "local-only" ]; then
    say "Tailscale mode: local-only; not changing Tailscale"
    echo "Local app/API: http://127.0.0.1:$KB1_PORT"
    return 0
  fi

  if [ "$CONFIRM_TAILSCALE_EXPOSURE" != "1" ]; then
    warn "KB1_TAILSCALE_MODE=$TAILSCALE_MODE requested, but KB1_CONFIRM_TAILSCALE_EXPOSURE=1 was not set."
    warn "Leaving Tailscale unchanged because KB-1 has no application auth yet."
    echo "Local app/API: http://127.0.0.1:$KB1_PORT"
    return 0
  fi

  cat <<EOF

SECURITY WARNING:
KB-1 currently has no application authentication. Any device/user allowed by
tailnet ACLs to reach this Serve route can read and write through the daemon.
EOF

  say "Tailscale mode: $TAILSCALE_MODE"

  if ! command -v tailscale >/dev/null 2>&1; then
    print_tailscale_install_steps
    return 0
  fi

  if ! tailscale status >/dev/null 2>&1; then
    print_tailscale_login_steps
    return 0
  fi

  local target="http://127.0.0.1:$KB1_PORT"
  local status_file
  status_file="$(mktemp)"
  local status_rc=0
  tailscale serve status >"$status_file" 2>&1 || status_rc=$?

  if [ "$status_rc" -eq 0 ] && ! grep -Eqi 'no serve config|not serving|no services configured' "$status_file"; then
    if grep -Fq "$target" "$status_file"; then
      say "Tailscale Serve already points at KB-1"
      cat "$status_file" || true
    elif [ "$TAILSCALE_MODE" = "auto" ]; then
      warn "Tailscale Serve already has a config. Auto mode will not overwrite it."
      cat "$status_file" || true
      cat <<EOF

KB-1 remains local-only until you approve a Serve change that will not disrupt existing routes.
For example:

   KB1_TAILSCALE_MODE=serve KB1_CONFIRM_TAILSCALE_EXPOSURE=1 KB1_TAILSCALE_HTTPS_PORT=8443 bash scripts/install_kb1_daemon_user_service.sh
EOF
      rm -f "$status_file"
      return 0
    else
      say "Updating Tailscale Serve on HTTPS port $TAILSCALE_HTTPS_PORT"
      tailscale serve --bg --https="$TAILSCALE_HTTPS_PORT" "$target"
      tailscale serve status
    fi
  else
    say "No active Tailscale Serve config detected; exposing KB-1 to the tailnet on HTTPS port $TAILSCALE_HTTPS_PORT"
    if ! tailscale serve --bg --https="$TAILSCALE_HTTPS_PORT" "$target"; then
      warn "Tailscale Serve setup failed. You may need MagicDNS and HTTPS certificates enabled."
      echo "KB-1 is still available locally at http://127.0.0.1:$KB1_PORT"
      rm -f "$status_file"
      return 0
    fi
    tailscale serve status
  fi
  rm -f "$status_file"

  local base_url
  base_url="$(maybe_tailnet_url | head -n 1 || true)"
  if [ -n "$base_url" ]; then
    say "Tailnet KB-1 URLs"
    if [ "$TAILSCALE_HTTPS_PORT" = "443" ]; then
      echo "App/API: $base_url"
      echo "Health:  $base_url/api/health"
      echo "MCP:     $base_url/mcp"
    else
      echo "App/API: $base_url:$TAILSCALE_HTTPS_PORT"
      echo "Health:  $base_url:$TAILSCALE_HTTPS_PORT/api/health"
      echo "MCP:     $base_url:$TAILSCALE_HTTPS_PORT/mcp"
    fi
  else
    say "Tailnet access configured"
    echo "Open the Tailscale Serve status above and use the shown https://*.ts.net URL."
  fi
}

write_linux_service() {
  need systemctl
  local service_file="$HOME/.config/systemd/user/$LINUX_SERVICE_NAME"
  local node_bin="$1"
  local path_value
  path_value="$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

  say "Writing Linux user systemd service: $service_file"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$service_file" <<EOF
[Unit]
Description=KB-1 local knowledge daemon
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=HOME=$HOME
Environment=NODE_ENV=production
Environment=KB1_HOME=$KB1_HOME
Environment=KB1_HOST=$KB1_HOST
Environment=KB1_PORT=$KB1_PORT
Environment=PATH=$path_value
ExecStart=$node_bin $REPO_DIR/apps/daemon/dist/main.js
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

  say "Starting or restarting $LINUX_SERVICE_NAME"
  systemctl --user daemon-reload
  systemctl --user enable "$LINUX_SERVICE_NAME"
  systemctl --user restart "$LINUX_SERVICE_NAME"
}

write_macos_launch_agent() {
  need launchctl
  local node_bin="$1"
  local plist="$HOME/Library/LaunchAgents/$MACOS_LABEL.plist"
  local log_dir="$HOME/Library/Logs"
  local path_value
  path_value="$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  say "Writing macOS LaunchAgent: $plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"

  local label_xml repo_xml node_xml home_xml host_xml port_xml path_xml stdout_xml stderr_xml
  label_xml="$(xml_escape "$MACOS_LABEL")"
  repo_xml="$(xml_escape "$REPO_DIR")"
  node_xml="$(xml_escape "$node_bin")"
  home_xml="$(xml_escape "$KB1_HOME")"
  host_xml="$(xml_escape "$KB1_HOST")"
  port_xml="$(xml_escape "$KB1_PORT")"
  path_xml="$(xml_escape "$path_value")"
  stdout_xml="$(xml_escape "$log_dir/kb1-daemon.out.log")"
  stderr_xml="$(xml_escape "$log_dir/kb1-daemon.err.log")"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_xml</string>
  <key>WorkingDirectory</key>
  <string>$repo_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_xml</string>
    <string>$repo_xml/apps/daemon/dist/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>KB1_HOME</key>
    <string>$home_xml</string>
    <key>KB1_HOST</key>
    <string>$host_xml</string>
    <key>KB1_PORT</key>
    <string>$port_xml</string>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$stdout_xml</string>
  <key>StandardErrorPath</key>
  <string>$stderr_xml</string>
</dict>
</plist>
EOF

  say "Starting $MACOS_LABEL"
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$MACOS_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$MACOS_LABEL" >/dev/null 2>&1 || true
}

say "Checking prerequisites"
PLATFORM="$(detect_platform)"
need git
need curl
need node
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    say "Activating pnpm 11.5.3 with corepack"
    corepack enable || true
    corepack prepare pnpm@11.5.3 --activate
  else
    echo "pnpm is missing and corepack is unavailable. Install Node 22+ with Corepack or install pnpm@11.5.3." >&2
    exit 1
  fi
fi
need pnpm

say "Platform: $PLATFORM; Node: $(node --version); pnpm: $(pnpm --version)"

if ! is_loopback_host; then
  if [ "$CONFIRM_NON_LOOPBACK_BIND" != "1" ]; then
    cat >&2 <<EOF
Refusing to bind KB-1 to non-loopback host: $KB1_HOST

KB-1 currently has no application authentication. Keep KB1_HOST=127.0.0.1 and
use Tailscale Serve for private tailnet access. If you intentionally accept the
risk of binding the daemon directly to a network interface, rerun with:

   KB1_CONFIRM_NON_LOOPBACK_BIND=1 KB1_HOST=$KB1_HOST bash scripts/install_kb1_daemon_user_service.sh
EOF
    exit 1
  fi
  warn "Non-loopback KB1_HOST=$KB1_HOST explicitly confirmed. The daemon has no application auth."
fi

say "Cloning/updating repo at $REPO_DIR"
mkdir -p "$(dirname "$REPO_DIR")"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --prune
  git -C "$REPO_DIR" pull --ff-only
elif [ -e "$REPO_DIR" ]; then
  echo "$REPO_DIR exists but is not a git repo. Move it aside or set KB1_REPO_DIR." >&2
  exit 1
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"

say "Installing dependencies"
pnpm install --frozen-lockfile

if [ "$RUN_CHECKS" = "1" ]; then
  say "Running pnpm check"
  pnpm check
else
  say "Building daemon/web packages"
  pnpm build
fi

if [ ! -f "$REPO_DIR/apps/daemon/dist/main.js" ]; then
  echo "Build did not produce apps/daemon/dist/main.js" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node)}"
case "$PLATFORM" in
  linux) write_linux_service "$NODE_BIN" ;;
  macos) write_macos_launch_agent "$NODE_BIN" ;;
esac

say "Waiting for local health"
HEALTH_URL="http://$KB1_HOST:$KB1_PORT/api/health"
VAULTS_URL="http://$KB1_HOST:$KB1_PORT/api/vaults"
health_tmp="$(mktemp)"
health_err="$(mktemp)"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >"$health_tmp" 2>"$health_err"; then
    cat "$health_tmp"
    printf '\n'
    break
  fi
  if [ "$i" = "30" ]; then
    echo "Daemon did not become healthy at $HEALTH_URL" >&2
    cat "$health_err" >&2 || true
    if [ "$PLATFORM" = "linux" ]; then
      journalctl --user -u "$LINUX_SERVICE_NAME" -n 80 --no-pager >&2 || true
    else
      cat "$HOME/Library/Logs/kb1-daemon.err.log" >&2 || true
    fi
    rm -f "$health_tmp" "$health_err"
    exit 1
  fi
  sleep 1
done
rm -f "$health_tmp" "$health_err"

say "Vaults"
curl -fsS "$VAULTS_URL"
printf '\n'

configure_tailscale_serve

say "Done"
echo "Local app/API: http://127.0.0.1:$KB1_PORT"
echo "Local MCP:     http://127.0.0.1:$KB1_PORT/mcp"
if [ "$PLATFORM" = "linux" ]; then
  echo "Service:       $LINUX_SERVICE_NAME"
  echo "Logs:          journalctl --user -u $LINUX_SERVICE_NAME -f"
else
  echo "Service:       $MACOS_LABEL"
  echo "Logs:          tail -f $HOME/Library/Logs/kb1-daemon.err.log"
fi
