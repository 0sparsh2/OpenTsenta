#!/usr/bin/env bash
# Share Ferry from this Mac with claude.ai (or your phone) over a free Cloudflare quick tunnel.
#   ./scripts/share.sh            Ctrl+C stops Ferry and the tunnel.
# Starts the tunnel, points PUBLIC_URL at its new address, keeps Ferry private (password sign-in, no new
# accounts), keeps the Mac awake while it runs, and prints the URL to give claude.ai.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
ENV_FILE="$ROOT/.env"
LOG="$ROOT/data/tunnel.log"
mkdir -p "$ROOT/data"
touch "$ENV_FILE"

command -v cloudflared >/dev/null || { echo "cloudflared isn't installed. Run: brew install cloudflared"; exit 1; }
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "Something is already using port $PORT (Ferry running somewhere else?). Stop it, then run this again."
  exit 1
fi

# key=value in .env, replacing an existing line.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i '' "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '\n%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}

# A public address must never sign people in by email alone or let strangers make accounts.
set_env AUTH_MODE password
set_env ALLOW_SIGNUPS false

TUNNEL_PID=""
URL=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$URL" ] && printf '\nStopped sharing. %s no longer works.\n' "$URL"
  return 0
}
trap cleanup EXIT

echo "Starting the tunnel…"
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!

for _ in $(seq 1 45); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && grep -q "Registered tunnel connection" "$LOG" && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "The tunnel stopped. See $LOG"; exit 1; }
  sleep 1
done
[ -n "$URL" ] || { echo "No tunnel address after 45s. See $LOG"; exit 1; }

set_env PUBLIC_URL "$URL"

cat <<EOF

  Ferry is shared at  $URL
  Dashboard           $URL   (or http://localhost:$PORT on this Mac)
  claude.ai connector $URL/api/v1/mcp

  The address is new each time: in claude.ai → Settings → Connectors, update Ferry's URL if it changed.
  Sign in there with your Ferry email and password. Keep this window open; Ctrl+C stops sharing.
  A brand-new address can take a minute to start working everywhere.

EOF

# caffeinate keeps the Mac from sleeping while Ferry runs (closing the lid on battery still sleeps it).
cd "$ROOT/apps/server"
caffeinate -is npx tsx src/index.ts
