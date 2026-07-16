#!/usr/bin/env node
// Merge per-platform updater fragments into the final `latest.json`.
//
// Each build runner emits its own `platforms` slice via
// `gen-updater-manifest.mjs` (macOS on macos-latest, Windows on windows-latest).
// The release job collects those fragments into one directory and runs this to
// stitch them into a single manifest the Tauri updater can poll.
//
// Usage (from repo root):
//   node scripts/merge-updater-manifest.mjs <fragments-dir> [outfile]
//
// - <fragments-dir>: directory holding one or more `*.json` fragments.
// - [outfile]:       where to write the manifest (default: latest.json).
//
// If no fragments carry any platform (all builds were unsigned) we skip writing
// and exit 0 — the release still ships installers, just no auto-update.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fragmentsDir = process.argv[2];
const outfile = join(root, process.argv[3] ?? 'latest.json');

if (!fragmentsDir || !existsSync(fragmentsDir)) {
  console.error(`✗ fragments dir not found: ${fragmentsDir ?? '(none given)'}`);
  console.error('  usage: node scripts/merge-updater-manifest.mjs <fragments-dir> [outfile]');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const platforms = {};
let versionSeen;
const fragmentFiles = readdirSync(fragmentsDir).filter((f) => f.endsWith('.json'));

for (const f of fragmentFiles) {
  const frag = JSON.parse(readFileSync(join(fragmentsDir, f), 'utf8'));
  if (frag.version) versionSeen = frag.version;
  Object.assign(platforms, frag.platforms ?? {});
}

const targets = Object.keys(platforms);
if (targets.length === 0) {
  console.warn('⚠ no platforms across fragments (all builds unsigned) — skipping latest.json.');
  process.exit(0);
}

// Fragments should all agree on the version; warn if a stray one doesn't.
if (versionSeen && versionSeen !== version) {
  console.warn(`⚠ fragment version ${versionSeen} != package.json ${version}; using ${version}.`);
}

const manifest = {
  version,
  notes: `clawd v${version} — see the release notes on GitHub.`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(outfile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ wrote ${outfile}`);
console.log(`  version ${version} · targets ${targets.join(', ')}`);
