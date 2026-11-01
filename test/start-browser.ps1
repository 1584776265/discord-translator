# 启动一个完全隔离的 headless Edge 实例用于测试
# 会挑选一个真正空闲的端口，并在启动后校验该实例确实是自己拉起的
param(
    [int]$StartPort = 9599,
    [switch]$WithExtension
)

$ErrorActionPreference = 'Stop'
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "Edge not found" }

function Test-PortFree([int]$p) {
    $used = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
    return ($null -eq $used)
}

$port = 0
for ($p = $StartPort; $p -lt $StartPort + 60; $p++) {
    if (Test-PortFree $p) { $port = $p; break }
}
if ($port -eq 0) { throw "no free port found" }

$root = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:TEMP ("dt_iso_" + $port)
if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }

$args = @(
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=msEdgeSyncConfirmation',
    "--remote-debugging-port=$port",
    "--user-data-dir=$profileDir"
)

if ($WithExtension) {
    $ext = (Resolve-Path (Join-Path $root 'extension')).Path
    $args += "--load-extension=$ext"
    $args += "--disable-extensions-except=$ext"
}

$args += 'about:blank'

Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Hidden | Out-Null

# 等待调试端口就绪
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 400
    try {
        $v = Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2
        if ($v.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if (-not $ok) { throw "debug port $port never came up" }

# 校验：只有我们自己的页面，没有用户浏览器的扩展
$list = (Invoke-WebRequest "http://127.0.0.1:$port/json/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
$pageCount = ($list | Where-Object { $_.type -eq 'page' }).Count
$foreign = ($list | Where-Object { $_.url -like 'https://*.com/*' }).Count

Write-Host ("PORT=" + $port)
Write-Host ("PAGES=" + $pageCount)
Write-Host ("FOREIGN=" + $foreign)
Write-Host ("PROFILE=" + $profileDir)
