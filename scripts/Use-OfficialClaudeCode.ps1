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

$json."claudeCode.disableLoginPrompt" = $false

if ($json."claudeCode.environmentVariables") {
    $json."claudeCode.environmentVariables" = @(
        $json."claudeCode.environmentVariables" | Where-Object {
            $_.name -notin @(
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
            )
        }
    )
}

$json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $SettingsPath -Encoding UTF8

Write-Host "Claude Code is now configured for official login/API mode."
Write-Host "Backup: $backupPath"
Write-Host "Restart VS Code after this change."

