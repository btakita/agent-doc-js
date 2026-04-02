#!/usr/bin/env bash
# Setup agent-doc-js credentials from ~/.claude/.credentials.json
# Usage: bash <(curl -s https://agent-doc-js.pages.dev/setup.sh)
#    or: ./setup.sh

set -euo pipefail

CREDS_FILE="${HOME}/.claude/.credentials.json"
SITE_URL="${AGENT_DOC_URL:-https://agent-doc-js.pages.dev}"
PROXY_URL="${AGENT_DOC_PROXY:-https://agent-doc-proxy.brian-takita.workers.dev}"

if [ ! -f "$CREDS_FILE" ]; then
  echo "Error: $CREDS_FILE not found"
  echo "Run Claude Code first to generate credentials."
  exit 1
fi

# Extract token
TOKEN=$(python3 -c "
import json
with open('$CREDS_FILE') as f:
    print(json.load(f)['claudeAiOauth']['accessToken'])
" 2>/dev/null || jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE")

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Error: Could not extract access token from $CREDS_FILE"
  exit 1
fi

# Encode as URL hash params
MODEL="${AGENT_DOC_MODEL:-claude-haiku-4-5-20251001}"

# Optional: Ragie API key from pass or env
RAGIE_KEY="${RAGIE_API_KEY:-}"
if [ -z "$RAGIE_KEY" ]; then
  RAGIE_KEY=$(pass btak/RAGIE_API_KEY 2>/dev/null || true)
fi

HASH="apiKey=${TOKEN}&proxyUrl=${PROXY_URL}&model=${MODEL}"
if [ -n "$RAGIE_KEY" ]; then
  HASH="${HASH}&ragieKey=${RAGIE_KEY}"
fi

echo ""
echo "Open this URL in your browser to auto-configure agent-doc:"
echo ""
echo "  ${SITE_URL}#${HASH}"
echo ""
echo "The credentials will be stored in your browser's localStorage."
echo "They are never sent to the agent-doc server."
echo ""

# Try to open in browser
if command -v xdg-open &>/dev/null; then
  xdg-open "${SITE_URL}#${HASH}" 2>/dev/null &
elif command -v open &>/dev/null; then
  open "${SITE_URL}#${HASH}"
fi
