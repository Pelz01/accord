#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data/wasm
# Reproduce the old schema when checking an upgrade from the initial release.
if [ ! -f .data/wasm/vault-v1.wasm ]; then
  legacy_dir="$(mktemp -d "$PWD/.data/legacy-v1.XXXXXX")"
  git archive 763e771 Cargo.toml Cargo.lock rust-toolchain.toml .cargo contracts | tar -x -C "$legacy_dir"
  cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$legacy_dir/Cargo.toml" --target-dir "$PWD/target" -p accord-vault
  cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-v1.wasm
  node scripts/optimize-wasm.mjs vault-v1
fi
if [ ! -f .data/wasm/vault-v2-invoices.wasm ]; then
  invoice_dir="$(mktemp -d "$PWD/.data/legacy-invoices.XXXXXX")"
  git archive b3553e7 Cargo.toml Cargo.lock rust-toolchain.toml .cargo contracts | tar -x -C "$invoice_dir"
  cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$invoice_dir/Cargo.toml" --target-dir "$PWD/target" -p accord-vault
  cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-v2-invoices.wasm
  node scripts/optimize-wasm.mjs vault-v2-invoices
fi
if [ ! -f .data/wasm/vault-v2-automatic.wasm ]; then
  automatic_dir="$(mktemp -d "$PWD/.data/legacy-automatic.XXXXXX")"
  git archive e5566eb Cargo.toml Cargo.lock rust-toolchain.toml .cargo contracts | tar -x -C "$automatic_dir"
  cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$automatic_dir/Cargo.toml" --target-dir "$PWD/target" -p accord-vault
  cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-v2-automatic.wasm
  node scripts/optimize-wasm.mjs vault-v2-automatic
fi
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault -p accord-test-token
cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault.wasm
cp target/wasm32-unknown-unknown/release/accord_test_token.wasm .data/wasm/token.wasm
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault --features fault-injection
cp target/wasm32-unknown-unknown/release/accord_vault.wasm .data/wasm/vault-starved.wasm
# Restore the ordinary target output so it cannot be mistaken for the negative-test build.
cargo build --locked --release --target wasm32-unknown-unknown -p accord-vault
node scripts/optimize-wasm.mjs
