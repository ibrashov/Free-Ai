param(
    [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) "extension"),
    [string]$Destination = (Join-Path $env:USERPROFILE ".vscode\extensions\anuar-local.anuar-free-ai-console-0.2.0"),
    [string]$LegacyDestination = (Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.2.0")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Source)) {
    throw "Extension source not found: $Source"
}

# Validate every configurable deletion target before touching installed files.
$extensionsRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.vscode\extensions'))
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
foreach ($target in @($Destination, $LegacyDestination)) {
    if (-not $target) { continue }
    $resolvedTarget = [IO.Path]::GetFullPath($target).TrimEnd('\', '/')
    if ((Split-Path -Parent $resolvedTarget) -ne $extensionsRoot -or
        (Split-Path -Leaf $resolvedTarget) -notmatch '^(anuar-local\.)?anuar-free-ai-console-\d+\.\d+\.\d+$' -or
        $sourcePath -eq $resolvedTarget -or $sourcePath.StartsWith($resolvedTarget + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe extension installation destination: $resolvedTarget"
    }
    if ((Test-Path -LiteralPath $resolvedTarget) -and
        ((Get-Item -LiteralPath $resolvedTarget).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Installation destination must not be a junction or symbolic link: $resolvedTarget"
    }
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

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.3"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.4"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.5"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

$oldExtension = Join-Path $env:USERPROFILE ".vscode\extensions\anuar-free-ai-console-0.1.6"
if (Test-Path $oldExtension) {
    Remove-Item -LiteralPath $oldExtension -Recurse -Force
}

if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
}

Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force

if ($LegacyDestination -and $LegacyDestination -ne $Destination) {
    if (Test-Path $LegacyDestination) {
        Remove-Item -LiteralPath $LegacyDestination -Recurse -Force
    }
    Copy-Item -LiteralPath $Source -Destination $LegacyDestination -Recurse -Force
}

Write-Host "Free AI Console extension installed to:"
Write-Host $Destination
if ($LegacyDestination -and $LegacyDestination -ne $Destination) {
    Write-Host "Compatibility copy installed to:"
    Write-Host $LegacyDestination
}
Write-Host ""
Write-Host "Restart VS Code, then open the Free AI icon in the Activity Bar."
