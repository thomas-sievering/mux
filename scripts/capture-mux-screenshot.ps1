$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path ".").Path
$proc = Start-Process powershell -ArgumentList @(
  '-NoExit',
  '-Command',
  "Set-Location '$repo'; bun run dist/index.js"
) -PassThru

Start-Sleep -Seconds 2

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$hwnd = [Win32]::GetForegroundWindow()
$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen((New-Object System.Drawing.Point($rect.Left, $rect.Top)), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size($width, $height)))

New-Item -ItemType Directory -Force -Path docs | Out-Null
$target = Join-Path $repo 'docs/mux-screenshot.png'
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Stop-Process -Id $proc.Id -Force
Write-Host "Saved $target"
