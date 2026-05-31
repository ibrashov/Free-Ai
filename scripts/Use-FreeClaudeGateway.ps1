param(
    [string]$SettingsPath = (Join-Path $env:APPDATA "Code\User\settings.json")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SettingsPath)) {
    throw "VS Code settings file not found: $SettingsPath"
}

$backupPath = "$SettingsPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $SettingsPath -Destination $backupPath -Force

$json = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json

$json."claudeCode.disableLoginPrompt" = $true
$json."claudeCode.environmentVariables" = @(
    @{ name = "ANTHROPIC_BASE_URL"; value = "http://localhost:8082" }
    @{ name = "ANTHROPIC_AUTH_TOKEN"; value = "freecc" }
    @{ name = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"; value = "1" }
    @{ name = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"; value = "190000" }
)

$json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $SettingsPath -Encoding UTF8

Write-Host "Claude Code is now configured to use free-claude-code gateway."
Write-Host "Backup: $backupPath"
Write-Host "Restart VS Code after this change."

