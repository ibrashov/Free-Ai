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

$json | Add-Member -NotePropertyName 'claudeCode.disableLoginPrompt' -NotePropertyValue $true -Force
$gatewayVariables = @(
    @{ name = "ANTHROPIC_BASE_URL"; value = "http://localhost:8082" }
    @{ name = "ANTHROPIC_AUTH_TOKEN"; value = "freecc" }
    @{ name = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"; value = "1" }
    @{ name = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"; value = "190000" }
)
$preservedVariables = @($json."claudeCode.environmentVariables" | Where-Object { $_ -and $_.name -notin $gatewayVariables.name })
$json | Add-Member -NotePropertyName 'claudeCode.environmentVariables' -NotePropertyValue @($preservedVariables + $gatewayVariables) -Force

$json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $SettingsPath -Encoding UTF8

Write-Host "Claude Code is now configured to use free-claude-code gateway."
Write-Host "Backup: $backupPath"
Write-Host "Restart VS Code after this change."

