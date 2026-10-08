# ==================================================================================================
# CAPTURE HELPER - the missing piece of every screenshot this control core has ever taken.
#
# ==================================================================================================
# WHY THIS FILE EXISTS
#
# OperatorHost.cs has ALWAYS delegated its screen capture to this script:
#
#     string helper = Path.Combine(dir, "capture-helper.ps1");
#     if (!File.Exists(helper)) throw new FileNotFoundException("capture-helper.ps1 missing at " + helper);
#
# and that file was NOT IN THE REPOSITORY. Every call to /screen.png and /panelgrid therefore threw
# FileNotFoundException from inside the request handler, the socket closed without a response, and the
# client saw "other side closed".
#
# Two proofs - prove-panel-colour and prove-status-truth - have been INCONCLUSIVE because of it, and the
# M17 proof gate cannot go green. This is the same defect class as the five proofs that never executed:
# a required artefact was absent, the failure was invisible, and the repository still cited capabilities
# that depended on it.
#
# So this file is written to THE CONTRACT THE C# ALREADY EXPECTS, not to a contract invented here.
#
# ==================================================================================================
# THE CONTRACT, read off OperatorHost.ScreenPng()
# ==================================================================================================
#   -X -Y -W -H     the region, in the HOST'S VIRTUALIZED coordinates
#   -VirtW -VirtH   the host's virtualized desktop size
#   -Out            where to write the PNG
#   stdout must contain  "scalePct":[<int>]   - the C# parses that literal prefix and reads the number,
#                                                so this script must emit EXACTLY that spelling
#
# WHY THE SCALE IS MEASURED RATHER THAN ASSUMED
#
# The host process is deliberately DPI-UNAWARE. The C# comments record that making it aware was tried
# and reverted: it fixed the crop and broke click targeting, because the test browser reports client
# coordinates in the virtualized 1536x864 space while clicks are injected in physical space, and the
# mismatch produced a scale of exactly 0.8 that missed every target.
#
# LOGPIXELSX cannot recover it either - inside a DPI-unaware process it reports 96 even on a 125%-scaled
# desktop, silently misplacing every region capture with no error at all.
#
# So the scale is MEASURED here, in a helper that is deliberately AWARE, by comparing the true physical
# screen size against the virtualized size the host passed in. Nothing is assumed.
#
# ==================================================================================================

param(
    [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
    [int]$VirtW = 0, [int]$VirtH = 0,
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

# Exactly ONE P/Invoke, and it is the important one: this thread must become DPI-aware before anything
# measures or copies, because every coordinate below is physical.
#
# An earlier version did the whole capture in C# - CreateCompatibleDC, CreateCompatibleBitmap, BitBlt,
# Image.FromHbitmap - which needed an explicit System.Drawing reference for Add-Type and juggled four GDI
# handles per capture. On a long-lived host that is slow resource exhaustion, not a crash, which is the
# worst kind of bug to leave in a safety-critical process.
#
# Graphics.CopyFromScreen performs the same Blit in one call with nothing to release, and it reads
# physical device coordinates - which is exactly right once this thread is aware.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AiosDpi {
    [DllImport("user32.dll")]
    public static extern int SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int n);

    public static void MakeAware() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }  // PER_MONITOR_V2
    public static int PhysicalW() { return GetSystemMetrics(0); }
    public static int PhysicalH() { return GetSystemMetrics(1); }
}
'@

[AiosDpi]::MakeAware()

$physW = [AiosDpi]::PhysicalW()
$physH = [AiosDpi]::PhysicalH()

$effVirtW = if ($VirtW -gt 0) { $VirtW } else { $physW }
$effVirtH = if ($VirtH -gt 0) { $VirtH } else { $physH }

# The scale between the host's virtualized space and true physical pixels. MEASURED, never assumed.
$scale = 100
if ($physW -gt 0) { $scale = [int][Math]::Round(($effVirtW * 100.0) / $physW) }

if ($W -le 0) { $W = $effVirtW }
if ($H -le 0) { $H = $effVirtH }

# Virtualized region -> physical region.
$px = [int][Math]::Round($X * $physW / [double]$effVirtW)
$py = [int][Math]::Round($Y * $physH / [double]$effVirtH)
$pw = [int][Math]::Round($W * $physW / [double]$effVirtW)
$ph = [int][Math]::Round($H * $physH / [double]$effVirtH)

# Clamp to the physical screen. A region outside it makes the copy read unmapped memory, and the crash
# that follows is far harder to read than a clamp.
if ($px -lt 0) { $pw = $pw + $px; $px = 0 }
if ($py -lt 0) { $ph = $ph + $py; $py = 0 }
if ($px + $pw -gt $physW) { $pw = $physW - $px }
if ($py + $ph -gt $physH) { $ph = $physH - $py }
if ($pw -lt 1) { $pw = 1 }
if ($ph -lt 1) { $ph = 1 }

try {
    $bmp = New-Object System.Drawing.Bitmap($pw, $ph, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($px, $py, 0, 0, (New-Object System.Drawing.Size($pw, $ph)),
                           [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally {
        $g.Dispose()
    }

    $ms = New-Object System.IO.MemoryStream
    try {
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
    } finally {
        $ms.Dispose()
        $bmp.Dispose()
    }

    if ($Out -ne '') {
        $dir = [System.IO.Path]::GetDirectoryName($Out)
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($Out, $bytes)
    }

    # EXACTLY the shape OperatorHost.ScreenPng parses: it looks for the literal `"scalePct":[` and then
    # parses the number up to the next comma or `]`. Emit anything else and the C# silently records a
    # scale of 0 - which is the failure mode this comment exists to prevent.
    $json = '{' +
        '"scalePct":[' + $scale + '],' +
        '"physicalW":' + $physW + ',' +
        '"physicalH":' + $physH + ',' +
        '"virtualW":' + $effVirtW + ',' +
        '"virtualH":' + $effVirtH + ',' +
        '"px":' + $px + ',"py":' + $py + ',' +
        '"pw":' + $pw + ',"ph":' + $ph + ',' +
        '"bytes":' + $bytes.Length +
        '}'
    Write-Output $json
    exit 0
} catch {
    Write-Output ('{ "error": "' + ($_.Exception.Message -replace '"', "'") + '" }')
    exit 1
}