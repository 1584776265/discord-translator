# Build the Tauri desktop app.
#
#   powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1            # release + NSIS installer
#   powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1 -NoBundle # exe only, no installer
#   powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1 -Debug    # debug build

param(
    [switch]$Debug,
    [switch]$NoBundle
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'desktop'
$shared = Join-Path $root 'extension\src'

Write-Host '[1/3] Syncing shared core modules...'
Copy-Item (Join-Path $shared 'core\engine.js') (Join-Path $desktop 'src\engine.js') -Force
Copy-Item (Join-Path $shared 'core\dom.js') (Join-Path $desktop 'src\dom.js') -Force
Copy-Item (Join-Path $shared 'content\content.css') (Join-Path $desktop 'src\content.css') -Force
Write-Host '      engine.js / dom.js / content.css'

Write-Host '[2/3] Building frontend assets...'
$required = @('index.html', 'app.js', 'style.css', 'engine.js', 'dom.js', 'content.css')
foreach ($f in $required) {
    if (-not (Test-Path (Join-Path $desktop "src\$f"))) {
        throw "missing frontend asset: src\$f"
    }
}
Write-Host '      all assets present'

Write-Host '[3/3] Tauri build...'
Push-Location $desktop
try {
    $args = @('build')
    if ($Debug) { $args += '--debug' }
    if ($NoBundle) { $args += '--no-bundle' }

    & tauri @args
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Build OK.' -ForegroundColor Green
if (-not $Debug) {
    Write-Host ('  exe: ' + (Join-Path $desktop 'src-tauri\target\release\DiscordTranslator.exe'))
    if (-not $NoBundle) {
        Write-Host ('  nsis: ' + (Join-Path $desktop 'src-tauri\target\release\bundle\nsis'))
    }
}
