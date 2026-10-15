#!/bin/sh
# Installs the VVC devlog post-commit hook in every git repo directly under Dev/vvc.
# Usage (Git Bash): sh tools/devlog/install-commit-hooks.sh
SCRIPT="C:/Users/Money Getting Mfucka/Dev/vvc/LiveStream/tools/devlog/report.js"
VVC="$(cd "$(dirname "$0")/../../.." && pwd)"

for repo in "$VVC"/*/; do
  [ -d "$repo.git/hooks" ] || continue
  hook="$repo.git/hooks/post-commit"
  if [ -f "$hook" ] && ! grep -q "devlog" "$hook"; then
    echo "skip (existing custom hook): $repo"
    continue
  fi
  cat > "$hook" <<EOF
#!/bin/sh
# VVC devlog: post this commit to the Telegram group (backgrounded so commits stay instant)
node "$SCRIPT" commit >/dev/null 2>&1 &
EOF
  chmod +x "$hook"
  echo "installed: $repo"
done
