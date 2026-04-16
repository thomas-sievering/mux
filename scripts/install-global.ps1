$ErrorActionPreference = 'Stop'

Write-Host 'Building mux...'
bun run build

Write-Host 'Registering/linking mux with Bun...'
bun link

$binDir = (bun pm bin).Trim()
Write-Host "Bun global bin: $binDir"

$cmd = Get-Command mux -ErrorAction SilentlyContinue
if ($cmd) {
  Write-Host "Done. mux is available at: $($cmd.Source)"
  Write-Host 'Try: mux'
  exit 0
}

Write-Warning 'mux is not on PATH in this shell yet.'
Write-Host 'Try one of these:'
Write-Host '  1. Open a new terminal and run: mux'
Write-Host "  2. Add this directory to PATH: $binDir"
Write-Host '  3. Then run: mux'
