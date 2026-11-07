#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data/wasm
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault -p accord-test-token
cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault.wasm
cp target/wasm32-unknown-unknown/release/accord_test_token.wasm .data/wasm/token.wasm
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault --features fault-injection
cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-starved.wasm
# Restore the ordinary target output so it cannot be mistaken for the negative-test build.
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault
node scripts/optimize-wasm.mjs
