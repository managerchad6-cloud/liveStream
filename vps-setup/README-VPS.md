# VPS Setup Instructions for LiveStream

This guide will help you set up automatic bidirectional git syncing on your Ubuntu VPS.

## Quick Setup

1. **Upload the setup files to your VPS:**
   ```bash
   scp -r vps-setup/ user@your-vps-ip:~/
   ```

2. **SSH into your VPS:**
   ```bash
   ssh user@your-vps-ip
   ```

3. **Fix line endings (if you get ^M error):**
   ```bash
   cd ~
   chmod +x vps-setup/fix-line-endings.sh
   ./vps-setup/fix-line-endings.sh
   ```
   
   Or manually:
   ```bash
   sed -i 's/\r$//' vps-setup/*.sh
   ```

4. **Run the setup script:**
   ```bash
   cd ~
   chmod +x vps-setup/setup-livestream.sh
   ./vps-setup/setup-livestream.sh
   ```

4. **Start the sync service:**
   ```bash
   sudo systemctl start livestream-sync
   ```

## Manual Setup (Alternative)

If you prefer to set up manually:

1. **Create the directory and clone:**
   ```bash
   cd ~
   mkdir -p liveStream
   cd liveStream
   git clone https://github.com/managerchad6-cloud/liveStream.git .
   ```

2. **Install dependencies:**
   ```bash
   # Install Node.js (if not installed)
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs git inotify-tools
   
   # Install project dependencies
   npm install
   ```

3. **Copy and configure the sync script:**
   ```bash
   cp ~/vps-setup/livestream-sync.sh ~/liveStream/
   chmod +x ~/liveStream/livestream-sync.sh
   ```

4. **Setup systemd service:**
   ```bash
   # Edit the service file to replace %USER% and %h with your actual username and home
   sudo nano ~/vps-setup/livestream-sync.service
   # Replace %USER% with your username
   # Replace %h with /home/your-username
   
   sudo cp ~/vps-setup/livestream-sync.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable livestream-sync.service
   sudo systemctl start livestream-sync.service
   ```

## Service Management

**Check status:**
```bash
sudo systemctl status livestream-sync
```

**View logs:**
```bash
sudo journalctl -u livestream-sync -f
```

**Stop service:**
```bash
sudo systemctl stop livestream-sync
```

**Restart service:**
```bash
sudo systemctl restart livestream-sync
```

**Disable auto-start:**
```bash
sudo systemctl disable livestream-sync
```

## How It Works

The sync service:
- **Pulls remote changes** every 5 seconds
- **Watches for local file changes** using inotify
- **Automatically commits and pushes** local changes
- **Handles conflicts** by stashing local changes before pulling
- **Runs continuously** as a systemd service

## Important Notes

⚠️ **Conflict Handling:**
- If you have local changes when remote changes arrive, they will be stashed
- After pulling, stashed changes are reapplied
- If there are conflicts, check with `git stash list` and resolve manually

⚠️ **Best Practice:**
- Edit from either local OR server, not both simultaneously
- Wait for sync to complete before making new changes
- The service checks every 5 seconds, so wait at least 10 seconds between edits

## Troubleshooting

**Service won't start:**
```bash
# Check the service file paths
sudo systemctl status livestream-sync
# Check logs for errors
sudo journalctl -u livestream-sync -n 50
```

**Git authentication issues:**
```bash
# If using HTTPS, you may need to set up credentials
cd ~/liveStream
git config --global credential.helper store
# Or use SSH keys instead
```

**Permission issues:**
```bash
# Make sure the script is executable
chmod +x ~/liveStream/livestream-sync.sh
# Check file ownership
ls -la ~/liveStream/
```

## Running the App

After syncing, you can run the Node.js server:

```bash
cd ~/liveStream
npm start
```

Or run it as a service (create another systemd service file for the Node.js app).
