#!/usr/bin/env bash
set -euo pipefail
# GTM Radar — start the local stack and PROVE the real closed loop. Run scripts/bootstrap.sh first.
# The real-stats loop (scripts/verify-loop.ts) needs NO vendor keys. The live gut-punch needs OPENAI_API_KEY.

cd "$(dirname "$0")/.."
CONVEX_URL="http://127.0.0.1:3210"

echo "[1/4] Convex local backend (keep alive)…"
if ! curl -s -o /dev/null "$CONVEX_URL/version"; then
  ( npx convex dev --tail-logs disable >/tmp/gtmradar-convex.log 2>&1 & )
  for i in $(seq 1 20); do curl -s -o /dev/null "$CONVEX_URL/version" && break; sleep 2; done
fi

echo "[2/4] Analysis service (real PyMC/DiD stats) on :8077…"
if ! curl -s -o /dev/null http://127.0.0.1:8077/health; then
  ( cd analysis && .venv/bin/uvicorn src.service:app --host 127.0.0.1 --port 8077 >/tmp/gtmradar-uvicorn.log 2>&1 & )
  sleep 4
fi
npx convex env set ANALYSIS_SERVICE_URL http://127.0.0.1:8077 >/dev/null 2>&1 || true

echo "[3/4] PROOF — real closed loop end-to-end (no vendor keys)…"
CONVEX_URL="$CONVEX_URL" npx tsx scripts/verify-loop.ts

echo "[4/4] Done. Open the board:  npm run dev -w platform   →  http://localhost:5173"
cat <<'NEXT'
  • Onboard a company in the UI — with OPENAI_API_KEY set, it fires a LIVE measurement and the gut-punch fills with real citations.
  • Or seed the thin slice:  CONVEX_URL=http://127.0.0.1:3210 npx tsx scripts/seed-thin-slice.ts
NEXT
