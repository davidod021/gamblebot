#!/usr/bin/env bash
# test-dual-agent.sh
#
# Starts two GambleBot instances in parallel:
#   Agent A — peer server on port 3001, consults Agent B at port 3002
#   Agent B — peer server on port 3002, consults Agent A at port 3001
#
# Both run in continuous mode (--mode continuous), dry-run (--dry-run),
# and auto-cycle every minute (--interval 1) so the loop fires quickly.
# They register each other as A2A peers, so each agent can call consult_peer
# to delegate research to the other instance.
#
# Usage:
#   bash scripts/test-dual-agent.sh
#
# Press Ctrl+C to stop both agents.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Building ==="
(cd "$ROOT" && npm run build)

mkdir -p "$ROOT/logs"

LOG_A="$ROOT/logs/agent-a.log"
LOG_B="$ROOT/logs/agent-b.log"

# Truncate logs from previous runs
: > "$LOG_A"
: > "$LOG_B"

cleanup() {
  echo ""
  echo "=== Stopping both agents ==="
  kill "$PID_A" "$PID_B" 2>/dev/null || true
  wait "$PID_A" "$PID_B" 2>/dev/null || true
  echo "Logs saved to:"
  echo "  $LOG_A"
  echo "  $LOG_B"
}
trap cleanup INT TERM

echo "=== Starting Alice's Agent (peer server :3001, consulting peer at :3002) ==="
(
  cd "$ROOT"
  A2A_PEER_PORT=3001 A2A_PEER_URL=http://localhost:3002 \
    npm start -- --mode continuous --interval 1 --dry-run --name "Alice's Agent" \
    >> "$LOG_A" 2>&1
) &
PID_A=$!
echo "Alice's Agent PID: $PID_A  →  tail -f $LOG_A"

# Wait for Alice's peer server to be up before Bob tries to connect
echo "Waiting 4 s for Alice's Agent peer server to start..."
sleep 4

echo ""
echo "=== Starting Bob's Agent (peer server :3002, consulting peer at :3001) ==="
(
  cd "$ROOT"
  A2A_PEER_PORT=3002 A2A_PEER_URL=http://localhost:3001 \
    npm start -- --mode continuous --interval 1 --dry-run --no-listener --name "Bob's Agent" \
    >> "$LOG_B" 2>&1
) &
PID_B=$!
echo "Bob's Agent PID: $PID_B  →  tail -f $LOG_B"

echo ""
echo "Both agents running. Ctrl+C to stop."
echo "Follow logs with:"
echo "  tail -f $LOG_A"
echo "  tail -f $LOG_B"
echo ""

wait "$PID_A" "$PID_B"
