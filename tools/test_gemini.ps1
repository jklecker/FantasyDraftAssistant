# Gemini direct test — run after: $env:GEMINI_API_KEY = "your-key"
# Bypasses the Spring Boot backend so we see the exact Gemini response/error.

$key = $env:GEMINI_API_KEY
if (-not $key) { Write-Error "Set `$env:GEMINI_API_KEY first"; exit 1 }

$model = "gemini-2.0-flash-lite"
$url   = "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}"

$body = @{
    contents = @(
        @{ role = "user";  parts = @(@{ text = "fantasy football analyst. Recommend one RB to draft." }) },
        @{ role = "model"; parts = @(@{ text = "Ready." }) },
        @{ role = "user";  parts = @(@{ text = "Who should I draft at pick 5?" }) }
    )
    generationConfig = @{ maxOutputTokens = 100; temperature = 0.4 }
} | ConvertTo-Json -Depth 10

Write-Host "`n=== Sending test request to Gemini ($model) ===" -ForegroundColor Cyan

try {
    $resp = Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop
    Write-Host "Status: $($resp.StatusCode)" -ForegroundColor Green
    $resp.Content | ConvertFrom-Json | ConvertTo-Json -Depth 6
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $raw    = $_.ErrorDetails.Message
    Write-Host "Status: $status" -ForegroundColor Red

    if ($raw) {
        $parsed = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($parsed) {
            Write-Host "`n=== Gemini error detail ===" -ForegroundColor Yellow
            $parsed | ConvertTo-Json -Depth 6
            # Surface the quota type
            $msg = $parsed.error.message ?? ""
            if ($msg -match "per.*minute|RATE_LIMIT|rpm")   { Write-Host "`n>>> PER-MINUTE limit (RPM). Wait ~60s and retry." -ForegroundColor Magenta }
            elseif ($msg -match "per.*day|daily|rpd")       { Write-Host "`n>>> DAILY limit (RPD). Resets midnight Pacific Time." -ForegroundColor Magenta }
            elseif ($msg -match "token|tpm")                { Write-Host "`n>>> TOKEN limit (TPM). Use shorter prompts." -ForegroundColor Magenta }
            else                                            { Write-Host "`n>>> Unknown limit type. Full error above." -ForegroundColor Magenta }
        } else {
            Write-Host "Raw: $raw"
        }
    } else {
        Write-Host "No response body: $($_.Exception.Message)"
    }
}

Write-Host "`n=== Check your live usage/limits at ===" -ForegroundColor Cyan
Write-Host "https://aistudio.google.com/rate-limit?timeRange=last-28-days"
