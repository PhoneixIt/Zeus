# Builds the Zeus V1.0 desktop icon: a green rounded square with a futuristic Z.
#
# Drawn rather than shipped as a binary so the mark can be regenerated and stays consistent with
# the one inlined in the interface. The interface and the desktop icon are the SAME shape; a logo
# that drifts from its in-app twin is worse than no logo.
#
# Multi-size .ico with PNG-compressed entries (supported since Vista), which avoids the
# 32-bit-per-pixel BMP path and its alpha handling entirely.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-ZBytes([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [double]$size
  $pad = $s * 0.06
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad))
  $radius = $s * 0.235
  $d = $radius * 2

  $plate = New-Object System.Drawing.Drawing2D.GraphicsPath
  $plate.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $plate.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
  $plate.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
  $plate.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
  $plate.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF($rect.X, $rect.Y)),
    (New-Object System.Drawing.PointF($rect.Right, $rect.Bottom)),
    [System.Drawing.Color]::FromArgb(255, 15, 157, 118),
    [System.Drawing.Color]::FromArgb(255, 25, 227, 170))
  $g.FillPath($brush, $plate)

  # The Z is drawn as three strokes rather than set as a font glyph, so it renders identically at
  # 16 pixels and at 256 with no font dependency that could go missing on another machine.
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($s * 0.085))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $inset = $s * 0.30
  $top = $s * 0.30
  $bot = $s * 0.70
  $right = $s - $inset

  $g.DrawLine($pen, $inset, $top, $right, $top)
  $g.DrawLine($pen, $right, $top, $inset, $bot)
  $g.DrawLine($pen, $inset, $bot, $right, $bot)

  # CONVERT TO THE CLASSIC 32-BIT DIB ICON ENTRY, NOT A PNG.
  #
  # The first version of this file packed PNG-compressed entries, which Vista and later accept and
  # which halves the file size. It also produced an icon System.Drawing.Icon refused to open -
  # "Requested range extends past the end of the array" - and one only some shells would display. A
  # logo is the one asset that must render everywhere, so the compact format is not worth the
  # compatibility risk and the entries are written uncompressed.
  #
  # Layout: BITMAPINFOHEADER (with height doubled to cover the AND mask), then the XOR bitmap
  # bottom-up as BGRA, then the 1-bit AND mask bottom-up with each row padded to 4 bytes.
  $dib = New-Object System.IO.MemoryStream
  $dw = New-Object System.IO.BinaryWriter($dib)
  $dw.Write([UInt32]40)
  $dw.Write([Int32]$size)
  $dw.Write([Int32]($size * 2))
  $dw.Write([UInt16]1)
  $dw.Write([UInt16]32)
  $dw.Write([UInt32]0)
  $dw.Write([UInt32]($size * $size * 4))
  $dw.Write([Int32]0)
  $dw.Write([Int32]0)
  $dw.Write([UInt32]0)
  $dw.Write([UInt32]0)
  $maskRowBytes = [int](([Math]::Ceiling($size / 32.0)) * 4)
  for ($y = $size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $size; $x++) {
      $px = $bmp.GetPixel($x, $y)
      $dw.Write([Byte]$px.B); $dw.Write([Byte]$px.G); $dw.Write([Byte]$px.R); $dw.Write([Byte]$px.A)
    }
  }
  for ($y = 0; $y -lt $size; $y++) {
    $bits = New-Object byte[] $maskRowBytes
    for ($x = 0; $x -lt $size; $x++) {
      if ($bmp.GetPixel($x, $y).A -lt 128) { $bits[($x -shr 3)] = $bits[($x -shr 3)] -bor (0x80 -shr ($x -band 7)) }
    }
    $dw.Write($bits, 0, $bits.Length)
  }
  $dw.Flush()
  $result = $dib.ToArray()
  $dw.Dispose()
  $dib.Dispose()

  $g.Dispose()
  $brush.Dispose()
  $plate.Dispose()
  $pen.Dispose()
  $bmp.Dispose()

  # The leading comma is load-bearing. Without it PowerShell unrolls the byte array into a stream of
  # individual integers, and the icon gets valid-looking headers with no images inside it - a
  # 125-byte file that satisfies every check except the one that matters.
  return , $result
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.ArrayList
foreach ($sz in $sizes) { [void]$images.Add((New-ZBytes $sz)) }

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)

$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]
  $dim = if ($sz -ge 256) { 0 } else { $sz }
  $payload = [byte[]]$images[$i]
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$payload.Length)
  $bw.Write([UInt32]$offset)
  $offset += $payload.Length
}

foreach ($img in $images) {
  $payload = [byte[]]$img
  $bw.Write($payload, 0, $payload.Length)
}
$bw.Flush()

$target = Join-Path $env:TEMP 'zeus.ico'
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
$bw.Dispose()
$out.Dispose()

Write-Output ("wrote {0} ({1} bytes, sizes {2})" -f $target, (Get-Item $target).Length, ($sizes -join '/'))
