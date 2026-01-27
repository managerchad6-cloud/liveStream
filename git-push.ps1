# PowerShell script for auto-commit and push
param(
    [string]$Message = "Update: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)

# Add all changes
git add .

# Commit with message
git commit -m $Message

# Push to origin
git push origin master

Write-Host "✅ Changes committed and pushed successfully!" -ForegroundColor Green
