#!/bin/sh
# Run as the server account that runs Codex / the VS Code remote extension.
set -eu
cd "$(dirname "$0")"
if [ "$(uname -s)" != Linux ]; then
  echo 'This installer requires Linux with systemd. Run it on your server.' >&2
  exit 1
fi
npm ci
npm install -g .
node "$(npm root -g)/easy-switch/src/setup.js"
