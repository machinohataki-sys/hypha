'use strict';
// HYPHA · CI / pre-commit guard for regex mirroring between
// `app/lib/hypha-learn/state-machine.js` (source of truth) and
// `app/design/screen-lesson-chat.jsx` (renderer-side mirror, required because
// Electron context isolation prevents the renderer from `require`-ing the
// CommonJS state-machine module).
//
// Added 2026-05-08 per MEOW Gate A Patch 3. The 3 regexes (STATE_TAG_RE,
// NEXT_TAG_RE, STRIP_TAG_RE) MUST stay char-identical between the two files.
// Any drift breaks the contract that the renderer correctly strips/preserves
// state markers in sync with what main.js's parseStateMarker recognizes.
//
// Run pre-commit or in CI:
//   node app/scripts/check-regex-mirror.cjs
// Exits 0 if all 3 regexes match. Exits 1 with a diff log if any drift.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'app', 'lib', 'hypha-learn', 'state-machine.js');
const MIRROR = path.join(ROOT, 'app', 'design', 'screen-lesson-chat.jsx');

const NAMES = ['STATE_TAG_RE', 'NEXT_TAG_RE', 'STRIP_TAG_RE'];

function extract(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  // Match: const NAME = /…/flags;  (literal regex with optional gi flags)
  const re = /const\s+(STATE_TAG_RE|NEXT_TAG_RE|STRIP_TAG_RE)\s*=\s*(\/[^\n]+\/[gimsuy]*)\s*;/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function main() {
  let source, mirror;
  try {
    source = extract(SOURCE);
    mirror = extract(MIRROR);
  } catch (err) {
    console.error('check-regex-mirror: read failed —', err.message);
    process.exit(2);
  }

  const drifts = [];
  for (const name of NAMES) {
    if (!source[name]) {
      drifts.push(`${name}: missing in source (${SOURCE})`);
      continue;
    }
    if (!mirror[name]) {
      drifts.push(`${name}: missing in mirror (${MIRROR})`);
      continue;
    }
    if (source[name] !== mirror[name]) {
      drifts.push(
        `${name}:\n  source: ${source[name]}\n  mirror: ${mirror[name]}`
      );
    }
  }

  if (drifts.length) {
    console.error('REGEX DRIFT DETECTED between mirror + source:');
    drifts.forEach(d => console.error('  ' + d));
    console.error('\nFix: align the renderer copy in screen-lesson-chat.jsx with state-machine.js.');
    process.exit(1);
  }

  console.log('OK · 3 regex pairs char-identical between');
  console.log('     ' + path.relative(ROOT, SOURCE));
  console.log('     ' + path.relative(ROOT, MIRROR));
  process.exit(0);
}

main();
