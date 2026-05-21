#!/usr/bin/env node
// intentional-placeholder: this script intentionally produces a solid-fill
// PNG when build/icon.png is missing. Final brand-rendered PNG is shipped
// in-repo (11923 bytes, hand-rendered from icon-source.svg). This generator
// is the recovery path for fresh clones / wiped build/ dirs — it guarantees
// electron-builder has a valid 1024×1024 PNG to consume so the build chain
// does not silently fail with "ENOENT icon.png". The solid-fill output is
// non-final by design; the script prints loud instructions pointing back
// to icon-source.svg + icon-build.sh / icon-build.ps1 for real rendering.
/**
 * build/generate-icon-placeholder.js
 *
 * Idempotent placeholder generator for build/icon.png. Real icon.png ships
 * already (1024×1024, hand-crafted from icon-source.svg) — this script is
 * the safety-net for when someone wipes build/ or clones fresh and the PNG
 * is missing.
 *
 * Strategy:
 *   1. If build/icon.png already exists AND is a valid PNG ≥ 512 bytes, exit 0.
 *   2. If missing, synthesize a minimal 1024×1024 solid-fill PNG using only
 *      Node built-ins (node:zlib for IDAT compression + manual chunk CRC).
 *      Fill = cream paper #F0D9C8 (brand register, matches icon-source.svg bg).
 *      This is NOT the final icon — it is a "build won't fail because PNG
 *      decoder rejected the file" guarantee.
 *   3. Print clear instructions pointing to icon-source.svg + the .icns gap.
 *
 * Run from project root:  node build/generate-icon-placeholder.js
 * Force regenerate:        node build/generate-icon-placeholder.js --force
 *
 * Exit codes: 0 = ok (existed or generated); 1 = write error.
 *
 * NO npm deps. Pure Node ≥18 built-ins (fs, path, zlib).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_PATH = path.join(__dirname, 'icon.png');
const FORCE = process.argv.includes('--force');
const WIDTH = 1024;
const HEIGHT = 1024;
// Cream paper #F0D9C8 — matches icon-source.svg disc fill.
const FILL_R = 0xF0;
const FILL_G = 0xD9;
const FILL_B = 0xC8;

// --- CRC table (PNG chunks need this) ---
const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(typeStr, data) {
  const type = Buffer.from(typeStr, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([lengthBuf, type, data, crcBuf]);
}

function buildSolidPng(width, height, r, g, b) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR: 13 bytes — width, height, bitDepth=8, colorType=2 (RGB), compression=0, filter=0, interlace=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // IDAT: per-row filter byte (0 = None) + width*3 RGB bytes, all rows identical
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < width; x++) {
      const px = off + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function isValidPng(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 512) return false;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  } catch (_err) {
    return false;
  }
}

function main() {
  if (!FORCE && isValidPng(ICON_PATH)) {
    const stat = fs.statSync(ICON_PATH);
    console.log(`[OK] build/icon.png already valid (${stat.size} bytes) — no action.`);
    console.log('     Run with --force to regenerate a minimal solid-fill placeholder.');
    printIcnsHint();
    return 0;
  }

  console.log(`[GEN] Synthesizing ${WIDTH}×${HEIGHT} solid-fill placeholder...`);
  const png = buildSolidPng(WIDTH, HEIGHT, FILL_R, FILL_G, FILL_B);
  try {
    fs.writeFileSync(ICON_PATH, png);
  } catch (err) {
    console.error(`[FAIL] Could not write ${ICON_PATH}: ${err.message}`);
    return 1;
  }
  const stat = fs.statSync(ICON_PATH);
  console.log(`[OK] Wrote build/icon.png (${stat.size} bytes, solid cream #F0D9C8).`);
  console.log('     This is a NON-BRAND placeholder so electron-builder does not fail.');
  console.log('     Replace with a real render of build/icon-source.svg before public release.');
  printIcnsHint();
  return 0;
}

function printIcnsHint() {
  const icns = path.join(__dirname, 'icon.icns');
  if (!fs.existsSync(icns)) {
    console.log('');
    console.log('NOTE: build/icon.icns is still MISSING (macOS DMG fallback).');
    console.log('      Run build/icon-build.sh (macOS/Linux) or build/icon-build.ps1 (Windows)');
    console.log('      to generate it from icon-source.svg or icon.png.');
  }
}

process.exit(main());
