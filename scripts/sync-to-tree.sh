#!/usr/bin/env bash
# Sync the plugin build into the dsh package tree so it resolves the host's
# @deepseek-ai/* from the parent node_modules (identity dedupe), then link the
# profile anchor for client-modules. Never run `npm install` in the target:
# npm follows node_modules symlinks and prunes the host tree.
set -euo pipefail

SRC="${1:-/home/ubuntu/test/dsh-node-agent}"
DST="${2:-/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-node-agent}"
PROFILE_ANCHOR="${3:-/data/dsh-home/profiles/web/node_modules/dsh-node-agent}"

echo "== sync $SRC -> $DST (excluding node_modules/@deepseek-ai) =="
mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules/@deepseek-ai' \
    --exclude 'spike' \
    "$SRC/" "$DST/"
else
  rm -rf "$DST"/{src,lib,spike,node_modules} 2>/dev/null || true
  cp -a "$SRC/src" "$SRC/lib" "$SRC/package.json" "$SRC/tsconfig.json" "$SRC/tsconfig.client.json" "$SRC/cordis.yml" "$SRC/README.md" "$SRC/build-client.mjs" "$SRC/scripts" "$DST/" 2>/dev/null || true
  # Copy the FULL dependency tree except the @deepseek-ai anchor symlink:
  # @microsoft/signalr needs its own runtime deps (tough-cookie, ws, ...).
  mkdir -p "$DST/node_modules"
  for entry in "$SRC/node_modules"/*; do
    name=$(basename "$entry")
    [ "$name" = "@deepseek-ai" ] && continue
    cp -a "$entry" "$DST/node_modules/"
  done
fi

echo "== link profile anchor for client-modules =="
mkdir -p "$(dirname "$PROFILE_ANCHOR")"
ln -sfn "$DST" "$PROFILE_ANCHOR"

echo "== verify resolution =="
node -e "
const { createRequire } = require('node:module');
const loader = createRequire('$DST/lib/index.js');
console.log('host loader anchor:', loader.resolve('dsh-node-agent/package.json'));
const client = createRequire('/data/dsh-home/profiles/web/cordis.yml');
console.log('client-modules anchor:', client.resolve('dsh-node-agent/package.json'));
const pkg = loader.resolve('@deepseek-ai/dsh-session/package.json');
console.log('peer identity (dsh-session):', pkg);
"
echo "== done =="
