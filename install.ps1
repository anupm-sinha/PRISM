# PRISM installer (Windows PowerShell)
# Usage:  irm https://raw.githubusercontent.com/anupm-sinha/PRISM/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'https://raw.githubusercontent.com/anupm-sinha/PRISM/main'
$dest = Join-Path $HOME '.claude/prism'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "✳ Downloading PRISM into $dest ..."
Invoke-WebRequest "$repo/prism.mjs" -OutFile (Join-Path $dest 'prism.mjs')

$cfg = Join-Path $dest 'prism.config.jsonc'
if (-not (Test-Path $cfg)) {
  Invoke-WebRequest "$repo/prism.config.jsonc" -OutFile $cfg
} else {
  # Upgrade: add any new config options, leaving your existing settings untouched.
  node (Join-Path $dest 'prism.mjs') --sync-config
}

# Wire it into Claude Code's settings.json (creates a backup).
node (Join-Path $dest 'prism.mjs') --install

Write-Host ''
Write-Host '✳ PRISM installed. Restart Claude Code to see your new status line.'
Write-Host '  Nerd Font user? Set  "glyphs": "nerd"  in:' $cfg
Write-Host '  Want the standard look back after customizing?  node "'$dest'\prism.mjs" --reset-config'
