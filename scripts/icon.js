#!/usr/bin/env node
'use strict';

// Hypha icon generator — rasterizes build/icon-source.svg into Win .ico
// (multi-resolution) + Linux/PNG fallback. Run:
//   npm run icon
// Output: build/icon.ico (16/32/48/64/128/256), build/icon.png (256), build/icon@512.png
// scripts/pack.js auto-picks build/icon.ico for win32 builds.

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const sharp = require('sharp');
  const toIco = require('to-ico');
  const ROOT = path.resolve(__dirname, '..');
  const src = path.join(ROOT, 'build', 'icon-source.svg');
  if (!fs.existsSync(src)) {
    console.error('  build/icon-source.svg not found');
    process.exit(1);
  }
  const svg = fs.readFileSync(src);
  const sizes = [16, 32, 48, 64, 128, 256];
  console.log(`[icon] rasterizing ${src} → ${sizes.length} sizes`);
  const pngs = [];
  for (const sz of sizes) {
    const buf = await sharp(svg).resize(sz, sz).png().toBuffer();
    pngs.push(buf);
  }
  const icoBuf = await toIco(pngs);
  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  fs.writeFileSync(icoPath, icoBuf);
  console.log(`[icon] wrote ${icoPath} (${icoBuf.length} bytes)`);
  // PNG fallback for Linux + Mac (Mac would prefer .icns; this PNG lets
  // electron-packager use --icon for Linux at least).
  const png256 = pngs[pngs.length - 1];
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png256);
  console.log(`[icon] wrote build/icon.png (256×256)`);
  // Higher-res 512 for retina taskbar / dock previews
  const png512 = await sharp(svg).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(ROOT, 'build', 'icon@512.png'), png512);
  console.log(`[icon] wrote build/icon@512.png (512×512)`);
}

main().catch(err => { console.error('[icon] FAILED', err.message); process.exit(1); });
