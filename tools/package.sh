#!/bin/sh
# Builds release/claude-chat-outline.zip for a GitHub release: the built
# extension (dist/) inside a claude-chat-outline/ folder, so "unzip, then
# Load unpacked on that folder" works. Run `npm run package`, which builds first.
set -eu
cd "$(dirname "$0")/.."
test -f dist/manifest.json || { echo "dist/ is missing: run npm run build" >&2; exit 1; }
rm -rf release
mkdir -p release/claude-chat-outline
cp -R dist/. release/claude-chat-outline/
cp LICENSE README.md release/claude-chat-outline/
(cd release && zip -qr -X claude-chat-outline.zip claude-chat-outline)
rm -rf release/claude-chat-outline
echo "release/claude-chat-outline.zip (version $(sed -n 's/.*"version": "\(.*\)".*/\1/p' dist/manifest.json))"
