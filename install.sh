#!/bin/sh
# Install as the account that runs Codex / the VS Code remote extension.
set -eu
cd "$(dirname "$0")"
if [ "$(uname -s)" != Linux ]; then
  echo 'This installer requires Linux with systemd. Run it on your server.' >&2
  exit 1
fi
install_prefix="$HOME/.local/share/easy-switch"
mkdir -p "$install_prefix"
package_dir=$(mktemp -d)
trap 'rm -rf "$package_dir"' EXIT HUP INT TERM
supported_node() {
  "$1" -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>20||a===20&&(b>18||b===18&&c>=1)?0:1)' >/dev/null 2>&1
}
node_binary=$(command -v node || true)
if [ -z "$node_binary" ] || ! supported_node "$node_binary" || ! command -v npm >/dev/null 2>&1; then
  node_binary="$install_prefix/runtime/bin/node"
  if ! supported_node "$node_binary"; then
    node_version=v22.23.5
    case "$(uname -m)" in
      x86_64|amd64) node_arch=x64; node_sha=c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1 ;;
      aarch64|arm64) node_arch=arm64; node_sha=8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3 ;;
      *) echo 'Install Node.js 20.18.1+ and npm for this CPU architecture, then rerun ./install.sh.' >&2; exit 1 ;;
    esac
    echo "Preparing a private Node.js $node_version runtime (your system Node.js is unchanged)…"
    node_archive="$package_dir/node.tar.gz"
    node_url="https://nodejs.org/dist/$node_version/node-$node_version-linux-$node_arch.tar.gz"
    if command -v curl >/dev/null 2>&1; then curl --fail --location --retry 2 "$node_url" -o "$node_archive"
    elif command -v wget >/dev/null 2>&1; then wget -O "$node_archive" "$node_url"
    else echo 'Install curl or wget, then rerun ./install.sh.' >&2; exit 1
    fi
    printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum -c -
    mkdir -p "$package_dir/runtime"
    tar -xzf "$node_archive" -C "$package_dir/runtime" --strip-components=1
    supported_node "$package_dir/runtime/bin/node" || { echo 'The private runtime cannot run on this Linux system. Install a compatible Node.js 20.18.1+ build.' >&2; exit 1; }
    rm -rf "$install_prefix/runtime"
    mv "$package_dir/runtime" "$install_prefix/runtime"
  fi
fi
node_binary=$("$node_binary" -p 'process.execPath')
PATH="$(dirname "$node_binary"):$PATH"
export PATH
# Packing needs no development dependencies. Only the package's runtime dependencies are installed.
npm pack --ignore-scripts --pack-destination "$package_dir"
npm install --prefix "$install_prefix" --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock "$package_dir"/easy-switch-*.tgz
"$node_binary" "$install_prefix/node_modules/easy-switch/src/setup.js"
