# start-dev.ps1
# Starts the Spring Boot backend and React frontend in separate terminal windows.

$root = $PSScriptRoot

# ── Clear port 8080 if something is already running on it ──────────────────
$existing = netstat -ano | Select-String ':8080 ' | Select-String 'LISTENING'
if ($existing) {
    $pid8080 = ($existing -split '\s+')[-1]
    Write-Host "Killing process $pid8080 on port 8080..." -ForegroundColor Yellow
    taskkill /PID $pid8080 /F | Out-Null
    Start-Sleep -Seconds 1
}

Write-Host "Starting Fantasy Draft Assistant..." -ForegroundColor Cyan

# 1. Spring Boot backend (port 8080)
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "cd '$root'; Write-Host 'Backend starting on http://localhost:8080' -ForegroundColor Green; .\gradlew.bat bootRun"

# 2. React frontend (port 3000) — give the JVM a few seconds to begin starting
Start-Sleep -Seconds 3
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "cd '$root\frontend'; Write-Host 'Frontend starting on http://localhost:3000' -ForegroundColor Yellow; npm start"

Write-Host ""
Write-Host "Both processes launched in separate windows." -ForegroundColor Cyan
Write-Host "  Backend  -> http://localhost:8080" -ForegroundColor Green
Write-Host "  Frontend -> http://localhost:3000" -ForegroundColor Yellow

