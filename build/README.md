# build/ — electron-builder resources

`electron-builder` reads everything in this directory as the build-resources root
(`directories.buildResources` in `package.json`). Anything here is referenced by
relative path from the build config; nothing here is bundled into the app at
runtime.

## Icons required

| File              | Purpose                          | Format / Spec                            | Status (boot-8) |
| ----------------- | -------------------------------- | ---------------------------------------- | --------------- |
| `icon.png`        | Linux AppImage, fallback         | 1024×1024 PNG, transparent background    | shipped (11923 B, valid PNG sig) |
| `icon@512.png`    | Secondary raster                 | 512×512 PNG                              | shipped (31618 B) |
| `icon.ico`        | Windows NSIS installer + EXE     | Multi-res: 16/32/48/64/128/256           | shipped (358742 B, 6 entries) |
| `icon.icns`       | macOS DMG + .app bundle          | Apple Iconset: 16/32/64/128/256/512/1024 | shipped via `generate-icns-from-png.js` (pure-node, sharp-assisted multi-res) |
| `icon-source.svg` | Vector master                    | Single canonical source                  | shipped (1218 B) |

### Generating `icon.icns`

Four paths, ordered by portability:

**Option D — Pure Node (recommended, NO external tools)**

```bash
node build/generate-icns-from-png.js          # generate if missing
node build/generate-icns-from-png.js --force  # overwrite existing
```

Reads `build/icon.png` and writes `build/icon.icns` using only Node built-ins
for the ICNS container format (Apple Iconset, big-endian). When `sharp`
(already in `devDependencies`) is installed, generates multi-resolution
entries `ic07` (128) / `ic08` (256) / `ic09` (512) / `ic10` (1024) by
downsampling. When `sharp` is absent, emits a single best-matching slot
verbatim — macOS scales at display.

Cross-platform (Win/Linux/macOS). No `iconutil` / `png2icns` /
`rsvg-convert` / `electron-icon-builder` required. This is the fallback
inside `icon-build.sh` and `icon-build.ps1` when no native tool is found.

**Option A — Cross-platform, uses npm**

```bash
npm install --save-dev electron-icon-builder
npx electron-icon-builder --input=build/icon-source.svg --output=build --flatten
```

**Option B — macOS / Linux native (no npm dep)**

```bash
./build/icon-build.sh           # auto-detects iconutil / png2icns
./build/icon-build.sh --force   # overwrite existing
./build/icon-build.sh --icns-only
```

Requires one SVG renderer (`rsvg-convert` / `inkscape` / `magick`) plus
`iconutil` (macOS, ships with Xcode CLT) or `png2icns` (`apt install icnsutils`).

**Option C — Windows native**

```powershell
pwsh build/icon-build.ps1
pwsh build/icon-build.ps1 -Force
```

`.icns` generation on Windows routes through `npx electron-icon-builder`
(Option A under the hood). `.ico` generation uses ImageMagick directly.

### Placeholder safety-net

`build/generate-icon-placeholder.js` is an **idempotent recovery script**
that synthesizes a minimal 1024×1024 solid-cream PNG via pure Node built-ins
(no deps) if `build/icon.png` is missing. It exits without action when the
shipped PNG is intact. Never overwrites unless `--force` is passed.

```bash
node build/generate-icon-placeholder.js          # no-op if icon.png valid
node build/generate-icon-placeholder.js --force  # regenerate
```

This is the build-chain safety net; it is **not** the production-quality
icon. Real rendering goes through icon-source.svg → icon-build scripts.

## Entitlements (macOS)

`entitlements.mac.plist` is the hardened-runtime entitlements file referenced by
`build.mac.entitlements` / `entitlementsInherit`. Keep it minimal — every key
extra widens the attack surface and triggers Apple notarization review.

Default policy: network outbound on, JIT off, dyld-env off, unsigned-executable
off. If a future build needs camera / mic / Apple-Events, add the corresponding
`com.apple.security.device.*` or `com.apple.security.automation.*` keys.

## Publishing — placeholders

`build.publish[0]` ships with `PLACEHOLDER_OWNER` / `PLACEHOLDER_REPO`. Replace
before running `npm run dist` against the real release channel:

```jsonc
"publish": [{
  "provider": "github",
  "owner": "machinohataki-sys",   // real GitHub org/user
  "repo":  "hypha"                // real repo
}]
```

Token: `GH_TOKEN` env var with `repo` scope. Used by both auto-publish (CI) and
auto-update (`electron-updater`).

## Signing — not configured here

- **Windows**: certificate via `CSC_LINK` (PFX path or base64) + `CSC_KEY_PASSWORD`
  env vars. EV cert preferred (no SmartScreen warm-up).
- **macOS**: Developer ID Application cert in Keychain + `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env for notarization.
- **Linux AppImage**: no signing.

All three signing flows are env-only. Never commit cert files or keys to this
directory — `.gitignore` excludes `*.pfx`, `*.p12`, `*.key`.

## CI

Recommended: GitHub Actions matrix (`ubuntu-latest`, `macos-latest`,
`windows-latest`) with `electron-builder` `--publish always` on tag push.
See `electron-builder` recipes for a known-good template; do not bake CI
credentials into this README.
