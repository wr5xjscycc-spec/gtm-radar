#!/usr/bin/env bash
set -euo pipefail
# One-time local setup for any lane.
echo "Installing TypeScript workspace deps (platform / measurement / sourcing)…"
npm install
echo "Installing Python analysis deps…"
pip install -r analysis/requirements.txt
echo "Running tests…"
npm test
pytest analysis
echo "Done. Copy .env.example -> .env and read prompts/INITIAL_PROMPT.md for your lane."
