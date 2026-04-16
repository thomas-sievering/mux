$ErrorActionPreference = 'Stop'

Write-Host 'Building mux...'
bun run build

Write-Host 'Linking mux globally...'
bun link

Write-Host 'Done. You can now run: mux'
