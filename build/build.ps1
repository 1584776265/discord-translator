# Build: 1) BetterDiscord single-file plugin  2) extension zip
# Pure ASCII source (no Chinese here) to stay safe under Windows PowerShell 5.1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8([string]$path, [string]$content) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

# ---------------------------------------------------------------- #
# 1. BetterDiscord plugin
# ---------------------------------------------------------------- #

Write-Host '[1/3] Building BetterDiscord plugin...' -ForegroundColor Cyan

$moduleFiles = @(
    (Join-Path $root 'extension\src\core\engine.js'),
    (Join-Path $root 'extension\src\core\settings.js'),
    (Join-Path $root 'extension\src\core\dom.js')
)

$chunks = foreach ($f in $moduleFiles) {
    if (-not (Test-Path $f)) { throw "Missing module: $f" }
    Read-Utf8 $f
}

$joined = ($chunks -join "`r`n")

# Wrap so that the CommonJS 'module' of the BD plugin is NOT clobbered
$wrapped = "(function (module, exports, require) {" + "`r`n" + $joined + "`r`n" + "})(undefined, undefined, undefined);"

$template = Read-Utf8 (Join-Path $root 'betterdiscord\_template.js')
if ($template.IndexOf('/*__MODULES__*/') -lt 0) { throw 'Template placeholder missing' }

$plugin = $template.Replace('/*__MODULES__*/', $wrapped)
$pluginOut = Join-Path $root 'betterdiscord\DiscordTranslator.plugin.js'
Write-Utf8 $pluginOut $plugin

$sizeKB = [Math]::Round((Get-Item $pluginOut).Length / 1KB, 1)
Write-Host ("      -> {0} ({1} KB)" -f $pluginOut, $sizeKB) -ForegroundColor Green

# ---------------------------------------------------------------- #
# 2. Extension zip
# ---------------------------------------------------------------- #

Write-Host '[2/3] Packaging extension...' -ForegroundColor Cyan

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir -Force | Out-Null }

$zipPath = Join-Path $distDir 'DiscordTranslator-extension.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Compress-Archive -Path (Join-Path $root 'extension\*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipKB = [Math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host ("      -> {0} ({1} KB)" -f $zipPath, $zipKB) -ForegroundColor Green

# ---------------------------------------------------------------- #
# 3. Sanity checks
# ---------------------------------------------------------------- #

Write-Host '[3/3] Sanity checks...' -ForegroundColor Cyan

$required = @(
    'extension\manifest.json',
    'extension\icons\icon16.png',
    'extension\icons\icon128.png',
    'extension\src\core\engine.js',
    'extension\src\core\settings.js',
    'extension\src\core\dom.js',
    'extension\src\background\sw.js',
    'extension\src\content\content.js',
    'extension\src\content\content.css',
    'extension\src\popup\popup.html',
    'extension\src\popup\popup.js',
    'extension\src\popup\popup.css',
    'betterdiscord\DiscordTranslator.plugin.js'
)

$missing = @()
foreach ($r in $required) {
    if (-not (Test-Path (Join-Path $root $r))) { $missing += $r }
}

if ($missing.Count -gt 0) {
    Write-Host '      MISSING:' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
    exit 1
}

Write-Host '      all files present' -ForegroundColor Green
Write-Host ''
Write-Host 'Build OK.' -ForegroundColor Green
