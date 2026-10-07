#!/bin/sh
# Builds dist/claude-chat-outline.zip for a GitHub release: only the files the
# extension needs, inside a claude-chat-outline/ folder, so "unzip, then Load
# unpacked on that folder" works.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist/claude-chat-outline
cp -R manifest.json src icons LICENSE README.md dist/claude-chat-outline/
(cd dist && zip -qr -X claude-chat-outline.zip claude-chat-outline)
rm -rf dist/claude-chat-outline
echo "dist/claude-chat-outline.zip (version $(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json))"
