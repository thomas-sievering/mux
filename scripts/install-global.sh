#!/usr/bin/env sh
set -eu

echo "Building mux..."
bun run build

echo "Registering/linking mux with Bun..."
bun link

BIN_DIR="$(bun pm bin | tr -d '\r')"
echo "Bun global bin: $BIN_DIR"

if command -v mux >/dev/null 2>&1; then
  echo "Done. mux is available at: $(command -v mux)"
  echo "Try: mux"
  exit 0
fi

echo "mux is not on PATH in this shell yet."
echo "Try one of these:"
echo "  1. Open a new terminal and run: mux"
echo "  2. Add this directory to PATH: $BIN_DIR"
echo "  3. Then run: mux"
