param(
    [string]$ModelDir = "C:\OllamaModels",

    [string]$Model = "qwen2.5-coder:3b"
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
Start-Sleep -Seconds 3

Write-Host "Pulling/verifying model: $Model"
ollama pull $Model

Write-Host "Testing model..."
ollama run $Model "Reply exactly OK"

Write-Host ""
Write-Host "Ollama local mode is ready."
Write-Host "If VS Code was open before this script, reload VS Code so it sees the updated environment."
