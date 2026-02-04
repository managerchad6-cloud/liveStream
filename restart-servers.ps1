# Restart LiveStream servers (main on 3002, animation on 3003)
# Run from project root: .\restart-servers.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

Write-Host "Stopping servers on 3002 and 3003..." -ForegroundColor Yellow
$pids = @()
netstat -ano | Select-String "LISTENING" | Where-Object { $_ -match ":3002\s|:3003\s" } | ForEach-Object {
    $parts = ($_.Line -split "\s+", [System.StringSplitOptions]::RemoveEmptyEntries)
    $pidVal = $parts[-1]
    if ($pidVal -match "^\d+$") { $pids += [int]$pidVal }
}
$pids = $pids | Sort-Object -Unique
foreach ($p in $pids) {
    try {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped PID $p"
    } catch {}
}
if ($pids.Count -eq 0) { Write-Host "  No servers were running." }
Start-Sleep -Seconds 2

Write-Host "Starting main server (port 3002)..." -ForegroundColor Green
Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory $root -WindowStyle Normal

Start-Sleep -Seconds 1
Write-Host "Starting animation server (port 3003)..." -ForegroundColor Green
$ffmpegPath = [Environment]::GetEnvironmentVariable("FFMPEG_PATH", "User")
$animCmd = "Set-Location '$root'; if (`$env:FFMPEG_PATH) {} else { `$env:FFMPEG_PATH = [Environment]::GetEnvironmentVariable('FFMPEG_PATH','User') }; npm run animation"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $animCmd -WindowStyle Normal

Write-Host "Done. Main server: http://localhost:3002  Animation: http://localhost:3003" -ForegroundColor Cyan
