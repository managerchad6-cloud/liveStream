$ErrorActionPreference = "Stop"
$api = "http://127.0.0.1:3003/api/orchestrator/play"
$r = Invoke-RestMethod -Method Post -Uri $api -ContentType "application/json" -Body "{}"
Write-Host "Director playback: PLAY" -ForegroundColor Green
$r | ConvertTo-Json -Depth 6
