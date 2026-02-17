# Ensure LiveStream servers are up (main 3002, animation 3003)
# Usage (from project root): .\ensure-servers.ps1

$ErrorActionPreference = "SilentlyContinue"
$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

function Test-PortListening($port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
  } catch { return $false }
}

function Test-Http($url) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch { return $false }
}

function Wait-ForHttp($url, $retries = 20, $sleepSec = 1) {
  for ($i = 0; $i -lt $retries; $i++) {
    if (Test-Http $url) { return $true }
    Start-Sleep -Seconds $sleepSec
  }
  return $false
}

function Start-Main() {
  if (Test-PortListening 3002) {
    Write-Host "Main already listening on 3002, skip start." -ForegroundColor DarkGray
    return
  }
  Write-Host "Starting main server on 3002..." -ForegroundColor Green
  Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory $root -WindowStyle Normal | Out-Null
}

function Start-Animation() {
  if (Test-PortListening 3003) {
    Write-Host "Animation already listening on 3003, skip start." -ForegroundColor DarkGray
    return
  }
  Write-Host "Starting animation server on 3003..." -ForegroundColor Green
  $animCmd = "Set-Location '$root'; npm run animation"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $animCmd -WindowStyle Normal | Out-Null
}

# Start only missing services
if (-not (Test-PortListening 3002)) { Start-Main }
if (-not (Test-PortListening 3003)) { Start-Animation }

# Give boot time and verify health
$mainHealthy = Wait-ForHttp "http://localhost:3002" 25 1
$animHealthy = Wait-ForHttp "http://localhost:3003" 25 1

if ($mainHealthy -and $animHealthy) {
  Write-Host "LiveStream OK ✅  main:http://localhost:3002  anim:http://localhost:3003" -ForegroundColor Cyan
  exit 0
}

Write-Host "Health check still failing (main=$mainHealthy, anim=$animHealthy). No auto-restart to avoid duplicate consoles." -ForegroundColor Yellow
Write-Host "Run restart-servers.ps1 manually if you want a full reset." -ForegroundColor Yellow
exit 1
