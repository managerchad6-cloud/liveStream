#!/bin/bash
# Quick fix for line endings issue
# Run this on your VPS if you get the ^M error

echo "Fixing line endings for all shell scripts..."

# Remove carriage returns from all .sh files
find vps-setup -name "*.sh" -exec sed -i 's/\r$//' {} \;

echo "✅ Line endings fixed!"
echo "You can now run: ./vps-setup/setup-livestream.sh"
