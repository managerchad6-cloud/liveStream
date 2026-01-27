#!/bin/bash
# Setup script for LiveStream on Ubuntu VPS
# Run this script in your home directory

set -e

echo "🚀 Setting up LiveStream on VPS..."

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "❌ Git is not installed. Installing..."
    sudo apt-get update
    sudo apt-get install -y git
fi

# Check if inotify-tools is installed (for file watching)
if ! command -v inotifywait &> /dev/null; then
    echo "📦 Installing inotify-tools..."
    sudo apt-get install -y inotify-tools
fi

# Create liveStream directory if it doesn't exist
if [ ! -d "liveStream" ]; then
    echo "📁 Creating liveStream directory..."
    mkdir -p liveStream
    cd liveStream
    
    # Clone the repository
    echo "📥 Cloning repository..."
    git clone https://github.com/managerchad6-cloud/liveStream.git .
    
    # Install Node.js dependencies if package.json exists
    if [ -f "package.json" ]; then
        echo "📦 Installing Node.js dependencies..."
        if ! command -v node &> /dev/null; then
            echo "📥 Installing Node.js..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
        fi
        npm install
    fi
else
    echo "📁 liveStream directory already exists. Pulling latest changes..."
    cd liveStream
    git pull origin master || git pull origin main
fi

# Copy sync script to liveStream directory
echo "📝 Setting up sync script..."
cd "$HOME"
if [ -f "liveStream/vps-setup/livestream-sync.sh" ]; then
    cp liveStream/vps-setup/livestream-sync.sh liveStream/
    chmod +x liveStream/livestream-sync.sh
fi

# Setup systemd service
echo "⚙️  Setting up systemd service..."
sudo cp liveStream/vps-setup/livestream-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable livestream-sync.service

echo "✅ Setup complete!"
echo ""
echo "To start the sync service, run:"
echo "  sudo systemctl start livestream-sync"
echo ""
echo "To check status:"
echo "  sudo systemctl status livestream-sync"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u livestream-sync -f"
