#!/usr/bin/env bash
# PRISM installer (macOS / Linux / Git Bash)
# Usage:  curl -fsSL https://raw.githubusercontent.com/anupm-sinha/PRISM/main/install.sh | bash
set -euo pipefail

repo='https://raw.githubusercontent.com/anupm-sinha/PRISM/main'
dest="$HOME/.claude/prism"
mkdir -p "$dest"

echo "✳ Downloading PRISM into $dest ..."
curl -fsSL "$repo/prism.mjs" -o "$dest/prism.mjs"

if [ ! -f "$dest/prism.config.jsonc" ]; then
  curl -fsSL "$repo/prism.config.jsonc" -o "$dest/prism.config.jsonc"
fi

# Wire it into Claude Code's settings.json (creates a backup).
node "$dest/prism.mjs" --install

echo ''
echo '✳ PRISM installed. Restart Claude Code to see your new status line.'
echo "  Nerd Font user? Set  \"glyphs\": \"nerd\"  in $dest/prism.config.jsonc"
