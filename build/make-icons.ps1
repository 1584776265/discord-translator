# Generate extension icons (pure ASCII source; Chinese glyph injected via char code)
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'extension\icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$glyph = [char]0x8BD1   # 'yi' = translate

function New-RoundedPath([int]$w, [int]$h, [int]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
    $path.AddArc(0, $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$sizes = @(16, 32, 48, 128)

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $radius = [int][Math]::Max(3, [Math]::Round($s * 0.24))
    $path = New-RoundedPath $s $s $radius

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 88, 101, 242),
        [System.Drawing.Color]::FromArgb(255, 124, 92, 255),
        45.0)
    $g.FillPath($brush, $path)
    $brush.Dispose()

    # glyph
    $fontSize = [single]($s * 0.62)
    $font = New-Object System.Drawing.Font(
        'Microsoft YaHei',
        $fontSize,
        [System.Drawing.FontStyle]::Bold,
        [System.Drawing.GraphicsUnit]::Pixel)

    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $box = New-Object System.Drawing.RectangleF(0, 1, $s, $s)
    $g.DrawString($glyph, $font, $textBrush, $box, $fmt)

    $textBrush.Dispose()
    $font.Dispose()
    $fmt.Dispose()
    $g.Dispose()
    $path.Dispose()

    $file = Join-Path $outDir ("icon{0}.png" -f $s)
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host ("icon{0}.png written" -f $s)
}

Write-Host 'done'
