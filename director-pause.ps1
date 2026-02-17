$ErrorActionPreference = "Stop"
$api = "http://127.0.0.1:3003/api/orchestrator/pause"
$r = Invoke-RestMethod -Method Post -Uri $api -ContentType "application/json" -Body "{}"
Write-Host "Director playback: PAUSE" -ForegroundColor Yellow
$r | ConvertTo-Json -Depth 6
