param(
    [ValidateSet("openrouter", "gemini", "gemini-fast", "groq", "cerebras", "ollama", "custom")]
    [string]$Provider = "openrouter",

    [string]$Model = "",

    [string]$GatewayUrl = "http://127.0.0.1:8082",

    [string]$AuthToken = "freecc"
)

$ErrorActionPreference = "Stop"

$modelMap = @{
    "openrouter"  = "open_router/google/gemma-4-31b-it:free"
    "gemini"      = "gemini/models/gemini-2.5-flash"
    "gemini-fast" = "gemini/models/gemini-2.0-flash"
    "groq"        = "groq/qwen/qwen3-32b"
    "cerebras"    = "cerebras/gpt-oss-120b"
    "ollama"      = "ollama/qwen2.5-coder:7b"
}

if ($Provider -eq "custom") {
    if ([string]::IsNullOrWhiteSpace($Model)) {
        throw "For -Provider custom you must pass -Model, for example: -Model 'groq/qwen/qwen3-32b'"
    }
    $selectedModel = $Model
} else {
    $selectedModel = $modelMap[$Provider]
}

Write-Host "Switching gateway model to: $selectedModel"

$payload = @{
    values = @{
        MODEL = $selectedModel
        MODEL_OPUS = ""
        MODEL_SONNET = ""
        MODEL_HAIKU = ""
        ENABLE_MODEL_THINKING = "false"
        PROVIDER_RATE_LIMIT = "1"
        PROVIDER_RATE_WINDOW = "10"
    }
} | ConvertTo-Json -Depth 5 -Compress

$response = Invoke-WebRequest `
    -Uri "$GatewayUrl/admin/api/config/apply" `
    -Method Post `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $payload `
    -UseBasicParsing `
    -TimeoutSec 30

$json = $response.Content | ConvertFrom-Json
Write-Host "Applied: $($json.applied)"
Write-Host "Valid:   $($json.valid)"

$cachePath = Join-Path $env:USERPROFILE ".claude\cache\gateway-models.json"
if (Test-Path $cachePath) {
    $backupPath = "$cachePath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    try {
        Move-Item -LiteralPath $cachePath -Destination $backupPath -Force
        Write-Host "Claude Code model cache moved to: $backupPath"
    } catch {
        Write-Host "Could not move Claude Code model cache: $($_.Exception.Message)"
        Write-Host "You can still restart VS Code, or rerun this script from a normal PowerShell window."
    }
}

Write-Host ""
Write-Host "Visible models:"
try {
    $headers = @{
        Authorization = "Bearer $AuthToken"
    }
    $models = Invoke-RestMethod -Uri "$GatewayUrl/v1/models" -Headers $headers -TimeoutSec 10
    $models.data | Select-Object -First 5 -ExpandProperty display_name
} catch {
    Write-Host "Model list check failed: $($_.Exception.Message)"
}
