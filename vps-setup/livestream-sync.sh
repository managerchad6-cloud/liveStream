#!/bin/bash
# LiveStream bidirectional sync service
# Watches for changes in both directions and syncs automatically

set -e

# Configuration
REPO_DIR="$HOME/liveStream"
SYNC_INTERVAL=5  # Check for remote changes every 5 seconds
GIT_USER="managerchad6-cloud"
GIT_REPO="liveStream"
REMOTE_BRANCH="master"

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARN:${NC} $1"
}

# Change to repo directory
cd "$REPO_DIR" || {
    error "Repository directory not found: $REPO_DIR"
    exit 1
}

# Ensure we're on the correct branch
git checkout "$REMOTE_BRANCH" 2>/dev/null || git checkout -b "$REMOTE_BRANCH"

# Function to pull remote changes
pull_remote() {
    log "Checking for remote changes..."
    
    # Fetch latest changes
    git fetch origin "$REMOTE_BRANCH" 2>&1 | grep -v "From https" || true
    
    # Check if we're behind
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$REMOTE_BRANCH" 2>/dev/null || echo "$LOCAL")
    
    if [ "$LOCAL" != "$REMOTE" ]; then
        # Check if we have local changes
        if ! git diff-index --quiet HEAD --; then
            warn "Local changes detected. Stashing before pull..."
            git stash push -m "Auto-stash before pull $(date +'%Y-%m-%d %H:%M:%S')"
            STASHED=true
        else
            STASHED=false
        fi
        
        log "Pulling remote changes..."
        if git pull origin "$REMOTE_BRANCH"; then
            log "✅ Successfully pulled remote changes"
            
            # Reapply stashed changes if any
            if [ "$STASHED" = true ]; then
                if git stash list | grep -q .; then
                    warn "Reapplying stashed changes..."
                    git stash pop || warn "Could not reapply stashed changes. Check with 'git stash list'"
                fi
            fi
        else
            error "Failed to pull remote changes"
        fi
    else
        log "Already up to date with remote"
    fi
}

# Function to push local changes
push_local() {
    # Check if there are uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        log "Detected uncommitted changes. Committing..."
        
        # Add all changes
        git add .
        
        # Commit with timestamp
        COMMIT_MSG="Auto-commit from VPS: $(date +'%Y-%m-%d %H:%M:%S')"
        if git commit -m "$COMMIT_MSG"; then
            log "✅ Committed local changes"
        else
            warn "No changes to commit or commit failed"
            return
        fi
    fi
    
    # Check if we're ahead of remote
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$REMOTE_BRANCH" 2>/dev/null || echo "$LOCAL")
    
    if [ "$LOCAL" != "$REMOTE" ]; then
        # Check if remote has changes we don't have
        git fetch origin "$REMOTE_BRANCH" >/dev/null 2>&1 || true
        REMOTE=$(git rev-parse "origin/$REMOTE_BRANCH" 2>/dev/null || echo "$LOCAL")
        
        if git merge-base --is-ancestor "$REMOTE" "$LOCAL" 2>/dev/null; then
            # We're ahead, safe to push
            log "Pushing local changes..."
            if git push origin "$REMOTE_BRANCH"; then
                log "✅ Successfully pushed local changes"
            else
                error "Failed to push local changes"
            fi
        else
            warn "Remote has new commits. Pulling first..."
            pull_remote
            # Try pushing again after pull
            if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/$REMOTE_BRANCH 2>/dev/null || echo HEAD)" ]; then
                log "Pushing after pull..."
                git push origin "$REMOTE_BRANCH" && log "✅ Pushed after pull"
            fi
        fi
    else
        log "No local changes to push"
    fi
}

# Function to watch for file changes using inotify
watch_files() {
    if command -v inotifywait &> /dev/null; then
        log "Starting file watcher..."
        inotifywait -m -r -e modify,create,delete,move --format '%w%f' "$REPO_DIR" 2>/dev/null | while read FILE; do
            # Ignore .git directory changes
            if [[ "$FILE" != *".git"* ]]; then
                log "File change detected: $FILE"
                # Wait a bit for file operations to complete
                sleep 2
                push_local
            fi
        done &
        WATCHER_PID=$!
        echo $WATCHER_PID > /tmp/livestream-watcher.pid
    else
        warn "inotifywait not available. Using polling mode for local changes."
    fi
}

# Cleanup function
cleanup() {
    log "Shutting down sync service..."
    if [ -f /tmp/livestream-watcher.pid ]; then
        WATCHER_PID=$(cat /tmp/livestream-watcher.pid)
        kill "$WATCHER_PID" 2>/dev/null || true
        rm /tmp/livestream-watcher.pid
    fi
    exit 0
}

# Trap signals
trap cleanup SIGTERM SIGINT

# Initial sync
log "🚀 Starting LiveStream bidirectional sync service"
log "Repository: $REPO_DIR"
log "Branch: $REMOTE_BRANCH"
log "Sync interval: ${SYNC_INTERVAL}s"

# Initial pull
pull_remote

# Start file watcher
watch_files

# Main loop - check for remote changes periodically
while true; do
    sleep "$SYNC_INTERVAL"
    
    # Pull remote changes
    pull_remote
    
    # Also check for local changes (in case inotify isn't working)
    if ! command -v inotifywait &> /dev/null; then
        push_local
    fi
done
