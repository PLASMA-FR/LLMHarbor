#!/usr/bin/env bash
set -Eeuo pipefail

# macOS installer for LLMHarbor. The generic install.sh also supports macOS;
# this wrapper gives Mac users better defaults and prerequisite hints.

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This installer is for macOS. Use ./install.sh on Linux.\n' >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  printf 'Missing git. Install Xcode Command Line Tools with: xcode-select --install\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Missing Node.js/npm.
Recommended macOS install:
  brew install node

If you do not have Homebrew:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew install node
EOF
  exit 1
fi

if [[ -z "${LLMHARBOR_BIN_DIR:-}" ]]; then
  if [[ -w /usr/local/bin ]]; then
    export LLMHARBOR_BIN_DIR=/usr/local/bin
  else
    export LLMHARBOR_BIN_DIR="$HOME/.local/bin"
  fi
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
exec "$SCRIPT_DIR/install.sh" "$@"
