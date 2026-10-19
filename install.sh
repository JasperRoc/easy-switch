#!/bin/sh
# Run as the server account that runs Codex / the VS Code remote extension.
set -eu
cd "$(dirname "$0")"
if [ "$(uname -s)" != Linux ]; then
  echo 'This installer requires Linux with systemd. Run it on your server.' >&2
  exit 1
fi
npm ci --ignore-scripts
package_dir=$(mktemp -d)
trap 'rm -rf "$package_dir"' EXIT HUP INT TERM
npm pack --ignore-scripts --pack-destination "$package_dir"
npm install -g --ignore-scripts "$package_dir"/*.tgz
node "$(npm root -g)/easy-switch/src/setup.js"
