#!/usr/bin/env bash
# Build Kandelbrot and deploy the static bundle to kandelbrot.petebartsch.com.
# Uses the `dreamhost` SSH alias (tronicadmin@petebartsch.com, ~/.ssh/id_ed25519).
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ Building…"
npm run build

echo "▸ Deploying dist/ → kandelbrot.petebartsch.com …"
rsync -avz --delete \
  --exclude='.dh-diag' --exclude='favicon.*' \
  dist/ dreamhost:kandelbrot.petebartsch.com/

echo "✓ Live → https://kandelbrot.petebartsch.com/"
