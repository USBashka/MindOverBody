#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --manifest-path native/Cargo.toml --target wasm32-unknown-unknown --release --locked
mkdir -p public/rusterize
cp native/target/wasm32-unknown-unknown/release/mob_map.wasm public/rusterize/app.wasm
cp vendor/rusterize/hosts/web/*.js public/rusterize/
cp vendor/rusterize/LICENSE-MIT public/rusterize/LICENSE-MIT.txt
cp vendor/rusterize/LICENSE-APACHE public/rusterize/LICENSE-APACHE.txt
chmod 644 public/rusterize/*
printf 'Rusterize map compiled: %s bytes\n' "$(wc -c < public/rusterize/app.wasm)"
