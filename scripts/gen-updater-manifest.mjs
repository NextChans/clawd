#!/usr/bin/env node
// Generate a per-platform updater *fragment* from a finished Tauri build.
//
// Tauri's updater polls the `latest.json` published on the GitHub release and
// compares its `version` to the running app; if newer, it downloads the
// artifact named in `platforms.<target>.url` and verifies it against the
// signature there (the pubkey lives in tauri.conf.json).
//
// clawd ships two platforms built on two different runners (macOS + Windows),
// so each runner emits only *its* slice of the `platforms` map here, and
// `merge-updater-manifest.mjs` stitches the slices into the final `latest.json`.
// This script auto-detects which platform it's running on:
//
//   - macOS  → universal `.app.tar.gz` (serves darwin-x86_64 + darwin-aarch64)
//   - Windows → NSIS `-setup.exe`      (serves windows-x86_64)
//
// Run AFTER the platform build, from the repo root:
//   node scripts/gen-updater-manifest.mjs [outfile]   (default: updater-fragment.json)
//
// If the build wasn't signed (no key configured yet) there's no `.sig`, so we
// skip writing the fragment and exit 0 — the release still ships its installer
// and the app falls back to opening the Releases page.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'NextChans/clawd';
const outfile = join(root, process.argv[2] ?? 'updater-fragment.json');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// `latest/download/<name>` resolves to whichever release is newest, so the URL
// stays valid release-to-release as long as the asset name is stable.
const urlFor = (name) =>
  `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(name)}`;

// Describe where each platform's build artifact + signature live and which
// updater target keys they satisfy.
const PLATFORMS = {
  darwin: {
    bundleDir: join(root, 'src-tauri/target/universal-apple-darwin/release/bundle/macos'),
    // Universal binary: the single artifact serves both Intel and Apple Silicon.
    artifact: (f) => f.endsWith('.app.tar.gz'),
    targets: ['darwin-x86_64', 'darwin-aarch64'],
    hint: 'did `tauri build --target universal-apple-darwin` run?',
  },
  win32: {
    bundleDir: join(root, 'src-tauri/target/release/bundle/nsis'),
    artifact: (f) => f.endsWith('-setup.exe'),
    targets: ['windows-x86_64'],
    hint: 'did `tauri build` run on Windows (NSIS bundle)?',
  },
};

const spec = PLATFORMS[process.platform];
if (!spec) {
  console.error(`✗ unsupported platform for updater fragment: ${process.platform}`);
  process.exit(1);
}

if (!existsSync(spec.bundleDir)) {
  console.error(`✗ bundle dir not found: ${spec.bundleDir}`);
  console.error(`  ${spec.hint}`);
  process.exit(1);
}

const files = readdirSync(spec.bundleDir);
const artifact = files.find(spec.artifact);
const sigFile = artifact ? files.find((f) => f === `${artifact}.sig`) : undefined;

if (!artifact || !sigFile) {
  console.warn('⚠ no signed updater artifact found (artifact/.sig missing).');
  console.warn('  The build was likely unsigned — skipping the fragment.');
  console.warn('  Set TAURI_SIGNING_PRIVATE_KEY to enable auto-update.');
  process.exit(0);
}

const signature = readFileSync(join(spec.bundleDir, sigFile), 'utf8').trim();
const entry = { signature, url: urlFor(artifact) };

const platforms = {};
for (const target of spec.targets) platforms[target] = entry;

const fragment = { version, platforms };
writeFileSync(outfile, JSON.stringify(fragment, null, 2) + '\n');
console.log(`✓ wrote ${outfile}`);
console.log(`  version ${version} · artifact ${artifact} · targets ${spec.targets.join(', ')}`);
