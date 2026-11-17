#!/bin/sh
# Builds the native helper and registers it with Brave (and Chrome, if installed).
set -eu
cd "$(dirname "$0")"
ROOT="$(pwd)"
mkdir -p bin
swiftc -O host/main.swift -o bin/cosmos-copy-host
EXT_ID="gdkbjkepnfmnonhgfjmklmmnboiamdad"
for dir in \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"; do
  [ -d "$(dirname "$dir")" ] || continue
  mkdir -p "$dir"
  cat > "$dir/com.henrikkvamme.cosmos_copy.json" <<JSON
{
  "name": "com.henrikkvamme.cosmos_copy",
  "description": "Cosmos Copy clipboard helper",
  "path": "$ROOT/bin/cosmos-copy-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "Registered in $dir"
done
echo "Load $ROOT/extension as an unpacked extension (extension ID $EXT_ID)."
