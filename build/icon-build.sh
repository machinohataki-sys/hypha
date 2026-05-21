#!/usr/bin/env bash
# build/icon-build.sh — generate icon.icns + icon.ico from icon-source.svg / icon.png
#
# Run from project root:
#   ./build/icon-build.sh                # generate everything missing
#   ./build/icon-build.sh --force        # regenerate even if present
#   ./build/icon-build.sh --icns-only    # macOS .icns only
#   ./build/icon-build.sh --ico-only     # Windows .ico only
#
# Required tooling (script prints actionable install hints if missing):
#   - rsvg-convert or inkscape  : SVG → PNG at exact sizes
#   - ImageMagick (convert)     : multi-size .ico assembly
#   - iconutil (macOS only)     : .iconset → .icns
#   - png2icns (Linux/WSL)      : fallback .icns generator (icnsutils package)
#
# This script is idempotent. It only writes files. No npm deps.

set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$BUILD_DIR/icon-source.svg"
PNG="$BUILD_DIR/icon.png"
ICNS="$BUILD_DIR/icon.icns"
ICO="$BUILD_DIR/icon.ico"

FORCE=0
DO_ICNS=1
DO_ICO=1

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --icns-only) DO_ICO=0 ;;
    --ico-only) DO_ICNS=0 ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# --- pick SVG renderer ---
render_png() {
  # render_png <size>
  local size="$1"
  local out="$BUILD_DIR/_tmp_icon_${size}.png"
  if have rsvg-convert; then
    rsvg-convert -w "$size" -h "$size" "$SVG" -o "$out"
  elif have inkscape; then
    inkscape "$SVG" --export-type=png --export-filename="$out" -w "$size" -h "$size" >/dev/null
  elif have magick; then
    magick -background none -density 1024 "$SVG" -resize "${size}x${size}" "$out"
  elif have convert; then
    convert -background none -density 1024 "$SVG" -resize "${size}x${size}" "$out"
  else
    echo "[FAIL] No SVG renderer found. Install one of:" >&2
    echo "       macOS:  brew install librsvg" >&2
    echo "       Linux:  apt install librsvg2-bin imagemagick" >&2
    echo "       Windows (Git Bash): choco install inkscape   OR  scoop install rsvg" >&2
    return 1
  fi
  echo "$out"
}

cleanup_tmp() { rm -f "$BUILD_DIR"/_tmp_icon_*.png 2>/dev/null || true; }
trap cleanup_tmp EXIT

# --- macOS .icns ---
build_icns() {
  if [[ -f "$ICNS" && "$FORCE" -eq 0 ]]; then
    echo "[SKIP] $ICNS exists (use --force to overwrite)."
    return 0
  fi
  if [[ ! -f "$SVG" && ! -f "$PNG" ]]; then
    echo "[FAIL] Need either $SVG or $PNG to generate .icns" >&2
    return 1
  fi

  echo "[GEN] icon.icns"

  # Pure-node fallback first if no SVG renderer AND a valid icon.png exists.
  # This is the cross-platform path that works without iconutil/png2icns.
  if ! have rsvg-convert && ! have inkscape && ! have magick && ! have convert && [[ -f "$PNG" ]]; then
    echo "[GEN] using pure-node fallback (build/generate-icns-from-png.js)"
    if node "$BUILD_DIR/generate-icns-from-png.js" --force; then
      echo "[OK] $ICNS (via pure-node)"
      return 0
    fi
    echo "[WARN] pure-node fallback failed; trying native tools..."
  fi

  if have iconutil; then
    # macOS native path — build .iconset directory + iconutil
    local ICONSET="$BUILD_DIR/icon.iconset"
    mkdir -p "$ICONSET"
    declare -a sizes=(16 32 64 128 256 512 1024)
    declare -a names=(
      "icon_16x16.png"
      "icon_16x16@2x.png"
      "icon_32x32.png"
      "icon_32x32@2x.png"
      "icon_128x128.png"
      "icon_128x128@2x.png"
      "icon_256x256.png"
      "icon_256x256@2x.png"
      "icon_512x512.png"
      "icon_512x512@2x.png"
    )
    declare -a render_sizes=(16 32 32 64 128 256 256 512 512 1024)

    for i in "${!names[@]}"; do
      local rs="${render_sizes[$i]}"
      local out
      out="$(render_png "$rs")"
      cp "$out" "$ICONSET/${names[$i]}"
    done

    iconutil -c icns "$ICONSET" -o "$ICNS"
    rm -rf "$ICONSET"
    echo "[OK] $ICNS"
  elif have png2icns; then
    # Linux/WSL fallback via icnsutils
    local p16 p32 p128 p256 p512 p1024
    p16="$(render_png 16)"
    p32="$(render_png 32)"
    p128="$(render_png 128)"
    p256="$(render_png 256)"
    p512="$(render_png 512)"
    p1024="$(render_png 1024)"
    png2icns "$ICNS" "$p16" "$p32" "$p128" "$p256" "$p512" "$p1024"
    echo "[OK] $ICNS (via png2icns)"
  else
    # Last-ditch pure-node fallback (any platform with node + icon.png)
    if [[ -f "$PNG" ]] && have node; then
      echo "[GEN] no native .icns tool — falling back to pure-node generator"
      if node "$BUILD_DIR/generate-icns-from-png.js" --force; then
        echo "[OK] $ICNS (via pure-node fallback)"
        return 0
      fi
    fi
    echo "[FAIL] No .icns generator found. Install one of:" >&2
    echo "       macOS:  iconutil ships with Xcode CLT — xcode-select --install" >&2
    echo "       Linux:  apt install icnsutils  (provides png2icns)" >&2
    echo "       Pure:   node build/generate-icns-from-png.js  (NO deps, needs icon.png)" >&2
    echo "       Cross:  npm install --save-dev electron-icon-builder  (then:" >&2
    echo "                 npx electron-icon-builder --input=$SVG --output=$BUILD_DIR --flatten)" >&2
    return 1
  fi
}

# --- Windows .ico ---
build_ico() {
  if [[ -f "$ICO" && "$FORCE" -eq 0 ]]; then
    echo "[SKIP] $ICO exists (use --force to overwrite)."
    return 0
  fi
  echo "[GEN] icon.ico"
  if ! have convert && ! have magick; then
    echo "[FAIL] ImageMagick not found. Install:" >&2
    echo "       macOS:  brew install imagemagick" >&2
    echo "       Linux:  apt install imagemagick" >&2
    echo "       Windows: choco install imagemagick" >&2
    return 1
  fi
  local CONVERT
  if have magick; then CONVERT="magick"; else CONVERT="convert"; fi

  local p16 p32 p48 p64 p128 p256
  p16="$(render_png 16)"
  p32="$(render_png 32)"
  p48="$(render_png 48)"
  p64="$(render_png 64)"
  p128="$(render_png 128)"
  p256="$(render_png 256)"

  $CONVERT "$p16" "$p32" "$p48" "$p64" "$p128" "$p256" "$ICO"
  echo "[OK] $ICO"
}

[[ "$DO_ICNS" -eq 1 ]] && build_icns
[[ "$DO_ICO"  -eq 1 ]] && build_ico

echo ""
echo "All requested icons present:"
ls -la "$BUILD_DIR" | grep -E '\.(icns|ico|png|svg)$' || true
