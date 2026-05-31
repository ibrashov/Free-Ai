param(
    [ValidateSet("auto", "cerebras", "gemini", "gemini-fast", "groq", "openrouter", "ollama")]
    [string]$Provider = "auto",

    [int]$MaxTokens = 1200
)

$ErrorActionPreference = "Stop"

$askScript = Join-Path $PSScriptRoot "Ask-FreeAI.ps1"

Write-Host "Free AI Console"
Write-Host "Provider: $Provider"
Write-Host "Type /exit to close."
Write-Host "Type /provider auto|cerebras|gemini|gemini-fast|groq|openrouter|ollama to switch."
Write-Host ""

while ($true) {
    $inputText = Read-Host "free-ai"

    if ([string]::IsNullOrWhiteSpace($inputText)) {
        continue
    }

    if ($inputText -eq "/exit") {
        break
    }

    if ($inputText.StartsWith("/provider ")) {
        $nextProvider = $inputText.Substring("/provider ".Length).Trim()
        if ($nextProvider -in @("auto", "cerebras", "gemini", "gemini-fast", "groq", "openrouter", "ollama")) {
            $Provider = $nextProvider
            Write-Host "Provider changed to: $Provider"
        } else {
            Write-Host "Unknown provider: $nextProvider"
        }
        continue
    }

    Write-Host ""
    try {
        & $askScript -Prompt $inputText -Provider $Provider -MaxTokens $MaxTokens
    } catch {
        Write-Host "Free AI request failed: $($_.Exception.Message)"
    }
    Write-Host ""
}
