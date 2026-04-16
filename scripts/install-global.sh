#!/usr/bin/env sh
set -eu

echo "Building mux..."
bun run build

echo "Linking mux globally..."
bun link

echo "Done. You can now run: mux"
