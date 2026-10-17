#!/usr/bin/env bash
# Run against an already booted, dedicated Android emulator. No Google login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT/scripts/check-android.py" "$@"
