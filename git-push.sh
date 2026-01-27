#!/bin/bash
# Auto-commit and push script

# Get the commit message from argument or use default
COMMIT_MSG=${1:-"Update: $(date +'%Y-%m-%d %H:%M:%S')"}

# Add all changes
git add .

# Commit with message
git commit -m "$COMMIT_MSG"

# Push to origin
git push origin master

echo "✅ Changes committed and pushed successfully!"
