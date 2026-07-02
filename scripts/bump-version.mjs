#!/usr/bin/env node
// Sync the app version across the three files that carry it:
//   - package.json            "version"
//   - src-tauri/Cargo.toml     [package] version
//   - src-tauri/tauri.conf.json "version"
//
// Usage: npm run version:bump 0.6.0
//
// Keeping these in lockstep matters because the DMG filename, the in-app
// "current version" and the release tag all derive from them; a drift means the
// "새 버전 확인" check compares against the wrong number.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: npm run version:bump <version>   e.g. 0.6.0");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`invalid version "${version}" — expected semver like 0.6.0`);
  process.exit(1);
}

/** Replace via a regex, asserting exactly one substitution happened. */
function patch(relPath, pattern, replacement) {
  const path = join(root, relPath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.error(`  ✗ ${relPath}: no version field matched — file layout changed?`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`  ✓ ${relPath}`);
}

console.log(`bumping to ${version}`);

// package.json — the first "version" key.
patch("package.json", /("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);

// tauri.conf.json — top-level "version".
patch("src-tauri/tauri.conf.json", /("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);

// Cargo.toml — the [package] version line (first `version = "..."`).
patch("src-tauri/Cargo.toml", /(^version\s*=\s*")\d+\.\d+\.\d+(")/m, `$1${version}$2`);

console.log(`done. next:  git tag v${version} && git push --tags`);
