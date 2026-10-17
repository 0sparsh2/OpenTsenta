#!/usr/bin/env bash
# Share Ferry from this Mac at a permanent address with Tailscale Funnel: https://<this-mac>.<your-tailnet>.ts.net
#   ./scripts/share-tailscale.sh          Ctrl+C stops Ferry (the Funnel address stays reserved for next time).
# Needs the Tailscale app, signed in (brew install --cask tailscale-app). Unlike a quick tunnel, the address never
# changes, so claude.ai and other MCP clients keep working across restarts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
ENV_FILE="$ROOT/.env"
touch "$ENV_FILE"

# The CLI is on PATH with the Homebrew formula; the app ships it inside the bundle.
TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TS" ] || { echo "Tailscale isn't installed. Run: brew install --cask tailscale-app, open it and log in."; exit 1; }

STATUS="$("$TS" status --json 2>/dev/null || true)"
STATE="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || true)"
[ "$STATE" = "Running" ] || { echo "Tailscale isn't connected ($STATE). Open the Tailscale app and log in, then run this again."; exit 1; }
HOST="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
URL="https://$HOST"

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
set_env PUBLIC_URL "$URL"

# Funnel: public HTTPS on 443 → this Mac's port. --bg keeps it configured across restarts. The first time,
# Tailscale prints a link to allow Funnel (and HTTPS certificates) for your tailnet; it waits while you approve.
funnel_on() { "$TS" funnel status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any((d.get("AllowFunnel") or {}).values()) else 1)' 2>/dev/null; }
if ! funnel_on; then
  LOG="$ROOT/data/funnel.log"
  mkdir -p "$ROOT/data"
  "$TS" funnel --bg "$PORT" > "$LOG" 2>&1 &
  FPID=$!
  SHOWN=""
  for _ in $(seq 1 300); do
    kill -0 "$FPID" 2>/dev/null || break
    if [ -z "$SHOWN" ] && grep -q "https://login.tailscale.com" "$LOG"; then
      cat "$LOG"
      echo "Open the link above and allow Funnel for this device; waiting (up to 5 minutes)…"
      SHOWN=1
    fi
    sleep 1
  done
  kill "$FPID" 2>/dev/null || true
  if ! funnel_on; then
    cat "$LOG"
    echo
    echo "Funnel isn't on yet. Allow it at the link above (Tailscale admin → Funnel / HTTPS), then run this again."
    exit 1
  fi
fi

cat <<EOF

  Ferry is shared at  $URL   (permanent; or http://localhost:$PORT on this Mac)
  MCP connector       $URL/api/v1/mcp

  Sign in there with your Ferry email and password. Keep this window open; Ctrl+C stops Ferry.
  To take the address off the internet entirely: $TS funnel --https=443 off

EOF

# caffeinate keeps the Mac from sleeping while Ferry runs (closing the lid on battery still sleeps it).
cd "$ROOT/apps/server"
exec caffeinate -is npx tsx src/index.ts
