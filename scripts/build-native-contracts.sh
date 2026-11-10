#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
old=.data/wasm/vault-before-native-deposits.wasm
if [ ! -f "$old" ]; then
  echo '2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04  .data/wasm/vault.wasm' | sha256sum -c -
  cp .data/wasm/vault.wasm "$old"
fi
echo '2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04  .data/wasm/vault-before-native-deposits.wasm' | sha256sum -c -
bash sandbox/build.sh
# Deliberate failed transfer, distinct from the failed-callback artifact.
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault --features native-transfer-failure
cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-native-failed.wasm
node scripts/optimize-wasm.mjs vault-native-failed
# Leave the normal target output restored; negative artifacts must never deploy.
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault
