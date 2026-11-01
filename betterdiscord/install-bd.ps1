# Install DiscordTranslator into BetterDiscord.
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-bd.ps1
#   powershell -ExecutionPolicy Bypass -File install-bd.ps1 -KeepOtherTranslators
#
# By default this disables other translation plugins (Translator / AutoTranslate)
# because running them together produces duplicated translation blocks.
# Use -KeepOtherTranslators to leave them enabled.

param(
    [switch]$KeepOtherTranslators
)

$ErrorActionPreference = 'Stop'

$pluginName = 'DiscordTranslator'
$bdRoot = Join-Path $env:APPDATA 'BetterDiscord'
$pluginDir = Join-Path $bdRoot 'plugins'
$dataDir = Join-Path $bdRoot 'data\stable'
$pluginsJson = Join-Path $dataDir 'plugins.json'

if (-not (Test-Path $bdRoot)) {
    Write-Host "ERROR: BetterDiscord not installed ($bdRoot)" -ForegroundColor Red
    Write-Host "Install BetterDiscord first: https://betterdiscord.app/"
    exit 1
}

if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
}

$src = Join-Path $PSScriptRoot "$pluginName.plugin.js"
if (-not (Test-Path $src)) {
    Write-Host "ERROR: $pluginName.plugin.js not found next to this script. Run build\build.ps1 first." -ForegroundColor Red
    exit 1
}

# ---- 1. copy plugin (backup existing) ----
$dst = Join-Path $pluginDir "$pluginName.plugin.js"
if (Test-Path $dst) {
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $bak = "$dst.$stamp.bak"
    Copy-Item -LiteralPath $dst -Destination $bak -Force
    Write-Host "Backed up old plugin -> $bak"
}
Copy-Item -LiteralPath $src -Destination $dst -Force
Write-Host "Installed plugin -> $dst"

# ---- 2. update plugins.json ----
if (Test-Path $pluginsJson) {
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    Copy-Item -LiteralPath $pluginsJson -Destination "$pluginsJson.$stamp.bak" -Force
    Write-Host "Backed up plugins.json"

    $raw = [System.IO.File]::ReadAllText($pluginsJson, [System.Text.Encoding]::UTF8)
    $cfg = $raw | ConvertFrom-Json

    # ConvertFrom-Json gives PSCustomObject; rebuild as ordered hashtable
    $map = @{}
    foreach ($p in $cfg.PSObject.Properties) {
        $map[$p.Name] = $p.Value
    }
    $map[$pluginName] = $true

    if (-not $KeepOtherTranslators) {
        foreach ($other in @('Translator', 'AutoTranslate')) {
            if ($map.ContainsKey($other)) {
                $map[$other] = $false
                Write-Host "Disabled conflicting plugin: $other"
            }
        }
    }

    $lines = @('{')
    $keys = @($map.Keys)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $k = $keys[$i]
        $v = if ($map[$k]) { 'true' } else { 'false' }
        $comma = if ($i -lt $keys.Count - 1) { ',' } else { '' }
        $lines += ('    "' + $k + '": ' + $v + $comma)
    }
    $lines += '}'
    $out = ($lines -join "`r`n")

    [System.IO.File]::WriteAllText($pluginsJson, $out, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "plugins.json updated"
    Write-Host $out
}
else {
    Write-Host "WARNING: plugins.json not found at $pluginsJson" -ForegroundColor Yellow
    Write-Host "Enable the plugin manually in Discord -> Settings -> BetterDiscord -> Plugins"
}

Write-Host ""
Write-Host "DONE. Restart Discord, then check Settings -> BetterDiscord -> Plugins." -ForegroundColor Green
Write-Host "Plugin name: $pluginName"
