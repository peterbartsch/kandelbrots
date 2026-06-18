#!/usr/bin/env bash
# Build Kandelbrot and deploy via a single SSH tarball stream.
# Dreamhost's link makes rsync's per-file round-trips painfully slow, so instead
# we pipe one gzipped tarball over a single SSH session and extract it remotely.
# Uses the `dreamhost` SSH alias (tronicadmin@petebartsch.com, ~/.ssh/id_ed25519).
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="dreamhost"
DEST="kandelbrot.com"
export COPYFILE_DISABLE=1 # keep macOS from stuffing ._ AppleDouble files into the tar

echo "▸ Building…"
npm run build

echo "▸ Streaming dist/ → $DEST (SSH tarball)…"
# Wipe only the hashed-asset dir (Vite renames bundles every build, so old ones
# would otherwise pile up), then extract the fresh build in one shot. index.html
# is overwritten; Dreamhost's own root files (favicon, .well-known, …) are left be.
tar --no-xattrs -czf - -C dist . | ssh "$REMOTE" "mkdir -p ~/$DEST && rm -rf ~/$DEST/assets && tar xzf - -C ~/$DEST"

echo "✓ Live → https://$DEST/"
