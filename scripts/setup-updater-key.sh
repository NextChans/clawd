#!/usr/bin/env bash
#
# One-time setup for clawd's self-updater signing key.
#
# Tauri's updater REQUIRES every release to be signed. This script walks you
# through generating a keypair and wiring it up. Run it yourself — clawd never
# generates or commits a key for you, since the private key must stay secret.
#
#   ./scripts/setup-updater-key.sh
#
# What it does:
#   1. Generates a keypair at ~/.tauri/clawd.key (+ .key.pub).
#   2. Prints the PUBLIC key — paste it into src-tauri/tauri.conf.json under
#      plugins.updater.pubkey (replacing the PLACEHOLDER).
#   3. Registers the PRIVATE key as the GitHub secret the release workflow reads.
#
# Prereqs: the repo deps installed (`npm ci`) and the GitHub CLI (`gh`) logged in.

set -euo pipefail

REPO="NextChans/clawd"
KEY_PATH="$HOME/.tauri/clawd.key"

echo "clawd updater key setup"
echo "======================="
echo

if [[ -f "$KEY_PATH" ]]; then
  echo "⚠  A key already exists at $KEY_PATH"
  echo "   Re-generating will INVALIDATE every already-shipped release (users on"
  echo "   the old key can no longer auto-update). Ctrl-C to abort, or remove it"
  echo "   first if you really mean to rotate."
  exit 1
fi

mkdir -p "$(dirname "$KEY_PATH")"

echo "1/3 · Generating keypair at $KEY_PATH"
echo "     (you'll be asked for a password — remember it; it's needed to sign)"
npm run tauri signer generate -- -w "$KEY_PATH"
echo

echo "2/3 · PUBLIC KEY — paste this into src-tauri/tauri.conf.json"
echo "     at  plugins.updater.pubkey  (replace the PLACEHOLDER string):"
echo "-----------------------------------------------------------------"
cat "$KEY_PATH.pub"
echo "-----------------------------------------------------------------"
echo

echo "3/3 · Registering the PRIVATE key as a GitHub Actions secret"
echo "     (repo: $REPO)"
read -r -p "     Proceed with 'gh secret set TAURI_SIGNING_PRIVATE_KEY'? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$KEY_PATH"
  echo "     ✓ TAURI_SIGNING_PRIVATE_KEY set."
  echo
  echo "     If you gave the key a password, also set it:"
  echo "       gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $REPO"
else
  echo "     Skipped. Set it later with:"
  echo "       gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $REPO < $KEY_PATH"
fi

echo
echo "Done. Commit the pubkey change and cut a release (git tag vX.Y.Z && git push --tags)."
echo "Until the secret + pubkey are in place, releases stay unsigned and the app"
echo "gracefully falls back to opening the Releases page."
