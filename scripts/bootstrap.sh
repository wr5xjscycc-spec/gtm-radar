#!/usr/bin/env bash
set -euo pipefail
# GTM Radar — one-command bootstrap for a FRESH machine. No Convex account/login needed
# (anonymous local deployment). See docs/GO-LIVE-WORKFLOW.md for the full story.
# Prereqs: Node 20.x, Python 3.12, git.

cd "$(dirname "$0")/.."

echo "[1/4] Node workspace deps…"
npm install

echo "[2/4] Python analysis deps (heavy: pymc/pytensor build — allow a few minutes)…"
python3 -m venv analysis/.venv
analysis/.venv/bin/pip install -q -r analysis/requirements.txt

echo "[3/4] Provision ANONYMOUS LOCAL Convex backend + generate convex/_generated/ …"
npx convex dev --once --configure new --dev-deployment local --project gtm-radar
echo "VITE_CONVEX_URL=http://127.0.0.1:3210" > platform/.env.local

echo "[4/4] Tests (key-free, mocked)…"
npm test
analysis/.venv/bin/pytest analysis -q

cat <<'NEXT'

✅ Bootstrap complete.

To run the demo:           bash scripts/run-demo.sh
For the LIVE vendor path, first set keys (gitignored / server-side only):
  cp .env.example .env      # add OPENAI_API_KEY=...
  npx convex env set OPENAI_API_KEY "$(grep ^OPENAI_API_KEY= .env | cut -d= -f2-)"
  npx convex env set ANALYSIS_SERVICE_URL http://127.0.0.1:8077
  npx orangeslice login     # (optional) for live page scraping
NEXT
