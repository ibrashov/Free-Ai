param(
    [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) "free_ai_vscode_extension"),
    [string]$Destination = (Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.3")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Source)) {
    throw "Extension source not found: $Source"
}

$destinationParent = Split-Path -Parent $Destination
if (-not (Test-Path $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.0"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.1"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.2"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
}

Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force

Write-Host "Free AI Console extension installed to:"
Write-Host $Destination
Write-Host ""
Write-Host "Restart VS Code, then open the Free AI icon in the Activity Bar."
