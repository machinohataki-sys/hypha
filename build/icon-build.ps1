# build/icon-build.ps1 — generate icon.icns + icon.ico from icon-source.svg
#
# Run from project root:
#   pwsh build/icon-build.ps1                # generate everything missing
#   pwsh build/icon-build.ps1 -Force         # regenerate even if present
#   pwsh build/icon-build.ps1 -IcnsOnly      # macOS .icns only
#   pwsh build/icon-build.ps1 -IcoOnly       # Windows .ico only
#
# Required tooling (script prints actionable install hints if missing):
#   - inkscape OR rsvg-convert (via choco / scoop)   : SVG → PNG sizes
#   - ImageMagick (magick)                            : multi-size .ico
#   - electron-icon-builder (npm)                     : .icns cross-platform
#
# .icns generation on Windows MUST use electron-icon-builder OR remote
# macOS / Linux. Native Windows cannot produce .icns without 3rd-party.
#
# This script is idempotent. No npm deps required beyond electron-icon-builder
# if you need .icns on Windows.

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$IcnsOnly,
    [switch]$IcoOnly
)

$ErrorActionPreference = 'Stop'

$BuildDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Svg = Join-Path $BuildDir 'icon-source.svg'
$Png = Join-Path $BuildDir 'icon.png'
$Icns = Join-Path $BuildDir 'icon.icns'
$Ico = Join-Path $BuildDir 'icon.ico'

$DoIcns = -not $IcoOnly
$DoIco  = -not $IcnsOnly

function Test-Cmd {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-RenderPng {
    param([int]$Size)
    $out = Join-Path $BuildDir "_tmp_icon_${Size}.png"
    if (Test-Cmd 'rsvg-convert') {
        & rsvg-convert -w $Size -h $Size $Svg -o $out | Out-Null
    } elseif (Test-Cmd 'inkscape') {
        & inkscape $Svg --export-type=png --export-filename=$out -w $Size -h $Size | Out-Null
    } elseif (Test-Cmd 'magick') {
        & magick -background none -density 1024 $Svg -resize "${Size}x${Size}" $out | Out-Null
    } else {
        Write-Error @"
[FAIL] No SVG renderer found. Install one of:
       choco install inkscape
       scoop install rsvg
       choco install imagemagick
"@
    }
    return $out
}

function Remove-Tmp {
    Get-ChildItem -Path $BuildDir -Filter '_tmp_icon_*.png' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

try {

if ($DoIcns) {
    if ((Test-Path $Icns) -and -not $Force) {
        Write-Host "[SKIP] $Icns exists (use -Force to overwrite)."
    } else {
        Write-Host "[GEN] icon.icns"
        # Pure-node fallback first — works on bare Windows w/o npx/electron-icon-builder
        # as long as build/icon.png exists. Try it before npm-based path.
        if ((Test-Path $Png) -and (Test-Cmd 'node')) {
            Write-Host "    Trying pure-node generator (build/generate-icns-from-png.js)..."
            $genScript = Join-Path $BuildDir 'generate-icns-from-png.js'
            & node $genScript --force
            if (Test-Path $Icns) {
                Write-Host "[OK] $Icns (via pure-node)"
                return
            }
            Write-Host "[WARN] pure-node fallback failed; trying electron-icon-builder..."
        }
        if (Test-Cmd 'npx') {
            # Cross-platform path — uses electron-icon-builder
            Write-Host "    Using electron-icon-builder (npx). Installing if absent..."
            # Lazy install scoped to project; uses devDependencies if already declared
            $eibPath = Join-Path (Split-Path -Parent $BuildDir) 'node_modules\.bin\electron-icon-builder.cmd'
            if (-not (Test-Path $eibPath)) {
                Write-Host "    Run: npm install --save-dev electron-icon-builder"
                Write-Host "    Then re-run this script."
                throw "electron-icon-builder not installed"
            }
            & npx electron-icon-builder --input=$Svg --output=$BuildDir --flatten
            # electron-icon-builder writes icons/icon.icns; move it
            $genIcns = Join-Path $BuildDir 'icon.icns'
            if (Test-Path (Join-Path $BuildDir 'icons\icon.icns')) {
                Move-Item -Force (Join-Path $BuildDir 'icons\icon.icns') $genIcns
                Remove-Item -Force -Recurse (Join-Path $BuildDir 'icons') -ErrorAction SilentlyContinue
            }
            if (Test-Path $genIcns) {
                Write-Host "[OK] $Icns"
            } else {
                throw "electron-icon-builder did not produce icon.icns"
            }
        } else {
            Write-Error @"
[FAIL] Windows cannot natively generate .icns. Install electron-icon-builder:
       npm install --save-dev electron-icon-builder
       Or generate .icns on macOS/Linux via build/icon-build.sh and commit it.
"@
        }
    }
}

if ($DoIco) {
    if ((Test-Path $Ico) -and -not $Force) {
        Write-Host "[SKIP] $Ico exists (use -Force to overwrite)."
    } else {
        Write-Host "[GEN] icon.ico"
        if (-not (Test-Cmd 'magick')) {
            Write-Error @"
[FAIL] ImageMagick not found. Install:
       choco install imagemagick
       OR  scoop install imagemagick
"@
        }
        $p16   = Invoke-RenderPng -Size 16
        $p32   = Invoke-RenderPng -Size 32
        $p48   = Invoke-RenderPng -Size 48
        $p64   = Invoke-RenderPng -Size 64
        $p128  = Invoke-RenderPng -Size 128
        $p256  = Invoke-RenderPng -Size 256
        & magick $p16 $p32 $p48 $p64 $p128 $p256 $Ico
        if (Test-Path $Ico) {
            Write-Host "[OK] $Ico"
        } else {
            throw "ImageMagick did not produce icon.ico"
        }
    }
}

Write-Host ""
Write-Host "All requested icons present:"
Get-ChildItem -Path $BuildDir -Filter 'icon*' | Format-Table Name, Length -AutoSize

} finally {
    Remove-Tmp
}
