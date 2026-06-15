param(
    [string]$ModelDir = "C:\OllamaModels",

    [string]$Model = "qwen2.5-coder:3b",

    [int]$StartupTimeoutSec = 30,

    [int]$TestTimeoutSec = 120
)

$ErrorActionPreference = "Stop"

Write-Host "Using Ollama model directory: $ModelDir"
New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null

[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $ModelDir, "User")
$env:OLLAMA_MODELS = $ModelDir

Write-Host "Stopping existing Ollama processes..."
Get-Process | Where-Object { $_.ProcessName -like "ollama*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$ollamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $ollamaExe)) {
    $ollamaExe = "ollama"
}

Write-Host "Starting Ollama with OLLAMA_MODELS=$ModelDir"
Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden

$ready = $false
$deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    throw "Ollama did not become ready within $StartupTimeoutSec seconds."
}

Write-Host "Pulling/verifying model: $Model"
ollama pull $Model

Write-Host "Testing model..."
$testBody = @{
    model = $Model
    prompt = "Reply exactly OK"
    stream = $false
    keep_alive = 0
    options = @{
        num_ctx = 2048
        num_predict = 4
    }
} | ConvertTo-Json -Depth 6 -Compress

$testResult = Invoke-RestMethod `
    -Uri "http://127.0.0.1:11434/api/generate" `
    -Method Post `
    -ContentType "application/json" `
    -Body $testBody `
    -TimeoutSec $TestTimeoutSec

Write-Host "Response: $($testResult.response)"

Write-Host ""
Write-Host "Ollama local mode is ready."
Write-Host "If VS Code was open before this script, reload VS Code so it sees the updated environment."
