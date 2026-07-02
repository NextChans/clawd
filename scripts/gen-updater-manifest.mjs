#!/usr/bin/env node
// Generate the updater's `latest.json` from a finished universal macOS build.
//
// Tauri's updater polls the `latest.json` published on the GitHub release and
// compares its `version` to the running app; if newer, it downloads the
// `.app.tar.gz` named in `platforms` and verifies it against the signature here
// (the pubkey lives in tauri.conf.json). We build a *universal* binary, so the
// single `.app.tar.gz` serves both Intel and Apple-Silicon — the two platform
// keys point at the same artifact + signature.
//
// Run AFTER `tauri build --target universal-apple-darwin`, from the repo root:
//   node scripts/gen-updater-manifest.mjs
//
// If the build wasn't signed (no key configured yet) there's no `.sig`, so we
// skip writing the manifest and exit 0 — the release still ships its DMG and the
// app falls back to opening the Releases page.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'NextChans/clawd';
const BUNDLE_DIR = join(
  root,
  'src-tauri/target/universal-apple-darwin/release/bundle/macos',
);

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(BUNDLE_DIR)) {
  console.error(`✗ bundle dir not found: ${BUNDLE_DIR}`);
  console.error('  did `tauri build --target universal-apple-darwin` run?');
  process.exit(1);
}

const files = readdirSync(BUNDLE_DIR);
const tarball = files.find((f) => f.endsWith('.app.tar.gz'));
const sigFile = files.find((f) => f.endsWith('.app.tar.gz.sig'));

if (!tarball || !sigFile) {
  console.warn('⚠ no signed updater artifact found (.app.tar.gz[.sig] missing).');
  console.warn('  The release was likely built unsigned — skipping latest.json.');
  console.warn('  Set TAURI_SIGNING_PRIVATE_KEY to enable auto-update.');
  process.exit(0);
}

const signature = readFileSync(join(BUNDLE_DIR, sigFile), 'utf8').trim();
// `latest/download/<name>` resolves to whichever release is newest, so the URL
// stays valid release-to-release as long as the asset name is stable.
const url = `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(tarball)}`;

const platform = { signature, url };
const manifest = {
  version,
  notes: `clawd v${version} — see the release notes on GitHub.`,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-x86_64': platform,
    'darwin-aarch64': platform,
  },
};

const out = join(root, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ wrote ${out}`);
console.log(`  version ${version} · artifact ${tarball}`);
