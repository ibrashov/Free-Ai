param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    [ValidateSet("", "auto", "cerebras", "gemini", "gemini-fast", "groq", "openrouter", "ollama")]
    [string]$Provider = "auto",

    [int]$MaxTokens = 1200,

    [string]$GatewayUrl = "http://127.0.0.1:8082",

    [string]$AuthToken = "freecc"
)

$ErrorActionPreference = "Stop"

function Select-FreeAIProvider {
    param([string]$Text, [string]$RequestedProvider)

    if (-not [string]::IsNullOrWhiteSpace($RequestedProvider) -and $RequestedProvider -ne "auto") {
        return $RequestedProvider
    }

    $lower = $Text.ToLowerInvariant()

    if ($lower -match 'offline|local|private|privacy|ollama') {
        return "ollama"
    }

    return "cerebras"
}

$SelectedProvider = Select-FreeAIProvider -Text $Prompt -RequestedProvider $Provider

if (-not [string]::IsNullOrWhiteSpace($SelectedProvider)) {
    $expectedModels = @{
        "openrouter"  = "open_router/google/gemma-4-31b-it:free"
        "gemini"      = "gemini/models/gemini-2.5-flash"
        "gemini-fast" = "gemini/models/gemini-2.0-flash"
        "groq"        = "groq/qwen/qwen3-32b"
        "cerebras"    = "cerebras/gpt-oss-120b"
        "ollama"      = "ollama/qwen2.5-coder:3b"
    }
    $expectedModel = $expectedModels[$SelectedProvider]
    $envPath = Join-Path $env:USERPROFILE ".fcc\.env"
    $currentModel = ""
    if (Test-Path $envPath) {
        $modelLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -like "MODEL=*" } | Select-Object -First 1
        if ($modelLine) {
            $currentModel = $modelLine.Substring("MODEL=".Length).Trim()
        }
    }
    if ($currentModel -ne $expectedModel) {
        $switchScript = Join-Path $PSScriptRoot "Set-GatewayModel.ps1"
        & $switchScript -Provider $SelectedProvider | Out-Null
    }
}

$safePrompt = @"
You are the user's separate Free AI assistant.

Important rules:
- Do not call tools.
- Do not pretend that you edited files.
- Do not output fake Write/Edit/Read JSON.
- If the user asks for code, write code in the chat.
- If the user asks for architecture, answer in Markdown.

User request:
$Prompt
"@

$body = @{
    model = "claude-3-5-sonnet-20241022"
    max_tokens = $MaxTokens
    messages = @(
        @{
            role = "user"
            content = $safePrompt
        }
    )
} | ConvertTo-Json -Depth 10 -Compress

try {
    $raw = Invoke-RestMethod `
        -Uri "$GatewayUrl/v1/messages" `
        -Method Post `
        -Headers @{
            Authorization = "Bearer $AuthToken"
            "Content-Type" = "application/json"
        } `
        -Body $body `
        -TimeoutSec 180
} catch {
    if ($_.ErrorDetails.Message) {
        throw $_.ErrorDetails.Message
    }
    throw
}

$text = New-Object System.Text.StringBuilder

foreach ($line in ($raw -split "`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed.StartsWith("data:")) {
        continue
    }

    $jsonText = $trimmed.Substring(5).Trim()
    if ($jsonText -eq "[DONE]" -or [string]::IsNullOrWhiteSpace($jsonText)) {
        continue
    }

    try {
        $event = $jsonText | ConvertFrom-Json
        if ($event.type -eq "content_block_delta" -and $event.delta.text) {
            [void]$text.Append($event.delta.text)
        }
    } catch {
        # Ignore non-JSON stream lines.
    }
}

$result = $text.ToString()
if ([string]::IsNullOrWhiteSpace($result)) {
    $raw
} else {
    $result
}
