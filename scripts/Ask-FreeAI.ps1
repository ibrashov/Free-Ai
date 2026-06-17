param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    [ValidateSet("", "auto", "cerebras", "gemini", "gemini-fast", "groq", "openrouter", "ollama", "gemma")]
    [string]$Provider = "auto",

    [int]$MaxTokens = 1200,

    [string]$GatewayUrl = "http://127.0.0.1:8082",

    [string]$AuthToken = "freecc",

    [string]$OllamaUrl = "http://127.0.0.1:11434",

    [int]$TimeoutSec = 120
)

$ErrorActionPreference = "Stop"

function Select-FreeAIProvider {
    param([string]$Text, [string]$RequestedProvider)

    if (-not [string]::IsNullOrWhiteSpace($RequestedProvider) -and $RequestedProvider -ne "auto") {
        return $RequestedProvider
    }

    $lower = $Text.ToLowerInvariant()

    if ($lower -match 'gemma') {
        return "gemma"
    }

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
        "groq"        = "groq/llama-3.1-8b-instant"
        "cerebras"    = "cerebras/gpt-oss-120b"
        "ollama"      = "ollama/qwen2.5-coder:3b"
        "gemma"       = "ollama/gemma3:4b"
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
    if ($currentModel -ne $expectedModel -and -not $expectedModel.StartsWith("ollama/")) {
        $switchScript = Join-Path $PSScriptRoot "Set-GatewayModel.ps1"
        & $switchScript -Provider $SelectedProvider | Out-Null
    }
}

$safePrompt = @"
You are the user's separate Free AI assistant.

Important rules:
- Answer in the same language as the user's request unless the user asks otherwise.
- Do not call tools.
- Do not pretend that you edited files.
- Do not output fake Write/Edit/Read JSON.
- If the user asks for code, write code in the chat.
- If the user asks for architecture, answer in Markdown.

User request:
$Prompt
"@

if ($expectedModel -and $expectedModel.StartsWith("ollama/")) {
    $ollamaModel = $expectedModel.Substring("ollama/".Length)
    $ollamaBody = @{
        model = $ollamaModel
        stream = $false
        options = @{
            num_ctx = 2048
            num_predict = $MaxTokens
        }
        messages = @(
            @{
                role = "system"
                content = "You are the user's separate Free AI assistant. Answer in the same language as the user's request unless the user asks otherwise. Do not call tools or claim that you edited files."
            }
            @{
                role = "user"
                content = $Prompt
            }
        )
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $ollamaResponse = Invoke-RestMethod `
            -Uri "$($OllamaUrl.TrimEnd('/'))/api/chat" `
            -Method Post `
            -Headers @{ "Content-Type" = "application/json" } `
            -Body $ollamaBody `
            -TimeoutSec $TimeoutSec
    } catch {
        $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($detail -match 'model.+not found|pull model|404') {
            throw "Ollama model '$ollamaModel' is not visible to the active server. Restart Ollama with OLLAMA_MODELS=C:\OllamaModels: .\scripts\Repair-OllamaLocalModels.ps1 -Model $ollamaModel"
        }
        throw
    }

    $ollamaText = [string]$ollamaResponse.message.content
    if ([string]::IsNullOrWhiteSpace($ollamaText)) {
        $ollamaResponse
    } else {
        $ollamaText
    }
    exit 0
}

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
        -TimeoutSec $TimeoutSec
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
