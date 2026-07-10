#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$ROOT/services/ai-agent-py"
VENV="$AGENT_DIR/.venv"

if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$AGENT_DIR/requirements.txt" -r "$AGENT_DIR/requirements-dev.txt"
fi

PYTHONPATH="$AGENT_DIR" "$VENV/bin/pytest" "$AGENT_DIR/tests/" -q "$@"
