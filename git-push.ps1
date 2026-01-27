# PowerShell script for auto-commit and push
param(
    [string]$Message = "Update: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)

# Add all changes
git add .

# Commit with message
git commit -m $Message

# Push to origin (try main first, fallback to master)
git push origin main 2>$null
if ($LASTEXITCODE -ne 0) {
    git push origin master
}

Write-Host "✅ Changes committed and pushed successfully!" -ForegroundColor Green
