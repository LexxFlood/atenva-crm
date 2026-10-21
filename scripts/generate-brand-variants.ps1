param(
  [Parameter(Mandatory = $true)][string]$GreenMarkSource
)

Add-Type -AssemblyName System.Drawing

$assets = Join-Path $PSScriptRoot '..\public\assets'
$assets = [System.IO.Path]::GetFullPath($assets)
$transparent = [System.Drawing.Color]::Transparent
$white = [System.Drawing.Color]::White
$black = [System.Drawing.Color]::FromArgb(255, 7, 12, 9)
$greenText = [System.Drawing.Color]::FromArgb(255, 11, 53, 31)
$navyText = [System.Drawing.Color]::FromArgb(255, 15, 47, 93)

function Get-AlphaBounds([System.Drawing.Bitmap]$Bitmap) {
  $left = $Bitmap.Width; $top = $Bitmap.Height; $right = -1; $bottom = -1
  for ($y = 0; $y -lt $Bitmap.Height; $y += 2) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += 2) {
      if ($Bitmap.GetPixel($x, $y).A -gt 8) {
        if ($x -lt $left) { $left = $x }; if ($x -gt $right) { $right = $x }
        if ($y -lt $top) { $top = $y }; if ($y -gt $bottom) { $bottom = $y }
      }
    }
  }
  if ($right -lt $left) { return [System.Drawing.Rectangle]::new(0, 0, $Bitmap.Width, $Bitmap.Height) }
  return [System.Drawing.Rectangle]::new($left, $top, $right - $left + 1, $bottom - $top + 1)
}

function Save-Png([System.Drawing.Bitmap]$Bitmap, [string]$Path) {
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Draw-FittedMark([System.Drawing.Graphics]$Graphics, [System.Drawing.Bitmap]$Source, [System.Drawing.Rectangle]$Destination) {
  $bounds = Get-AlphaBounds $Source
  $scale = [Math]::Min($Destination.Width / $bounds.Width, $Destination.Height / $bounds.Height)
  $width = [int]($bounds.Width * $scale); $height = [int]($bounds.Height * $scale)
  $x = $Destination.X + [int](($Destination.Width - $width) / 2)
  $y = $Destination.Y + [int](($Destination.Height - $height) / 2)
  $Graphics.DrawImage($Source, [System.Drawing.Rectangle]::new($x, $y, $width, $height), $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-MarkVariant([System.Drawing.Bitmap]$Source, [System.Drawing.Color]$Background, [string]$Path) {
  $canvas = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear($Background)
  Draw-FittedMark $graphics $Source ([System.Drawing.Rectangle]::new(98, 98, 828, 828))
  Save-Png $canvas $Path
  $graphics.Dispose(); $canvas.Dispose()
}

function New-LogoVariant([System.Drawing.Bitmap]$Source, [System.Drawing.Color]$Background, [System.Drawing.Color]$TextColor, [string]$Path) {
  $canvas = [System.Drawing.Bitmap]::new(1400, 1000, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear($Background)
  Draw-FittedMark $graphics $Source ([System.Drawing.Rectangle]::new(330, 38, 740, 650))
  $wordFont = [System.Drawing.Font]::new('Arial', 132, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $tagFont = [System.Drawing.Font]::new('Arial', 29, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new($TextColor)
  $center = [System.Drawing.StringFormat]::new(); $center.Alignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString('ATENVA', $wordFont, $brush, [System.Drawing.RectangleF]::new(80, 690, 1240, 160), $center)
  $graphics.DrawString('PLATAFORMA DE CONVERSÃO RELACIONAL', $tagFont, $brush, [System.Drawing.RectangleF]::new(80, 846, 1240, 70), $center)
  Save-Png $canvas $Path
  $center.Dispose(); $brush.Dispose(); $wordFont.Dispose(); $tagFont.Dispose(); $graphics.Dispose(); $canvas.Dispose()
}

$greenLoaded = [System.Drawing.Bitmap]::FromFile((Resolve-Path $GreenMarkSource))
$green = [System.Drawing.Bitmap]::new($greenLoaded); $greenLoaded.Dispose()
$navyLoaded = [System.Drawing.Bitmap]::FromFile((Join-Path $assets 'atenva-mark-navy.png'))
$navy = [System.Drawing.Bitmap]::new($navyLoaded); $navyLoaded.Dispose()

New-MarkVariant $green $transparent (Join-Path $assets 'atenva-mark-green.png')
New-MarkVariant $green $white (Join-Path $assets 'atenva-mark-green-white.png')
New-MarkVariant $green $black (Join-Path $assets 'atenva-mark-green-black.png')
New-LogoVariant $green $transparent $greenText (Join-Path $assets 'atenva-logo-green.png')
New-LogoVariant $green $white $greenText (Join-Path $assets 'atenva-logo-green-white.png')
New-LogoVariant $green $black $white (Join-Path $assets 'atenva-logo-green-black.png')

New-MarkVariant $navy $transparent (Join-Path $assets 'atenva-mark-navy.png')
New-MarkVariant $navy $white (Join-Path $assets 'atenva-mark-navy-white.png')
New-MarkVariant $navy $black (Join-Path $assets 'atenva-mark-navy-black.png')
New-LogoVariant $navy $transparent $navyText (Join-Path $assets 'atenva-logo-navy.png')
New-LogoVariant $navy $white $navyText (Join-Path $assets 'atenva-logo-navy-white.png')
New-LogoVariant $navy $black $white (Join-Path $assets 'atenva-logo-navy-black.png')

$green.Dispose(); $navy.Dispose()
Get-ChildItem -LiteralPath $assets -Filter 'atenva-*.png' | Sort-Object Name | Select-Object Name, Length
