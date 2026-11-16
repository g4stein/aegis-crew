#!/bin/sh
# Registers the AEGIS CREW schedules from .kiro/crew.yaml with Kiro Crew.
# Requires the `kirocrew` CLI (https://kiro.dev/docs/crew/installation.md).
# Safe to re-run: each job is owned by a --managed-by key and replaced on install.
set -eu

if ! command -v kirocrew >/dev/null 2>&1; then
  echo "kirocrew CLI not found. Install Kiro Crew first: https://kiro.dev/docs/crew/installation.md" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in .kiro/agents/aegis-archivist.md .kiro/agents/aegis-verifier.md .kiro/agents/aegis-sentinel.md; do
  [ -f "$f" ] || { echo "Missing agent definition: $f" >&2; exit 1; }
done

install_job() {
  key="$1"; shift
  kirocrew cron remove --managed-by "$key" >/dev/null 2>&1 || true
  kirocrew cron add "$@" --managed-by "$key"
}

install_job "aegis-crew:archivist-intake" \
  "aegis-archivist-intake" \
  "In $REPO_ROOT, act as the aegis-archivist agent (.kiro/agents/aegis-archivist.md). Check aegis-forge/input/ for .sol files with no matching .kiro/specs/<contract>-modernization/ folder and ingest them. If none, reply NO NEW INPUT and stop." \
  --every 120

install_job "aegis-crew:sentinel-heartbeat" \
  "aegis-sentinel-heartbeat" \
  "In $REPO_ROOT, act as the aegis-sentinel agent (.kiro/agents/aegis-sentinel.md). Run one Sentinel heartbeat check." \
  --every 60

echo "Installed. Copy the agent definitions to ~/.kiro/agents/ if your Crew build does not read workspace agents:"
echo "  cp .kiro/agents/aegis-*.md ~/.kiro/agents/"
kirocrew cron list
