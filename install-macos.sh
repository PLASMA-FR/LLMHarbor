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
  brew install node@24
  export PATH="$(brew --prefix node@24)/bin:$PATH"

If you do not have Homebrew:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew install node@24
  export PATH="$(brew --prefix node@24)/bin:$PATH"
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

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
  if [[ -f "$SCRIPT_DIR/install.sh" ]]; then
    exec "$SCRIPT_DIR/install.sh" "$@"
  fi
fi

# When this script is piped from curl, it has no adjacent install.sh. Fetch the
# generic installer explicitly so the documented one-line macOS command works.
if ! command -v curl >/dev/null 2>&1; then
  printf 'Missing curl; download install.sh from the LLMHarbor repository and run it locally.\n' >&2
  exit 1
fi

INSTALL_SCRIPT_URL="${LLMHARBOR_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install.sh}"
TEMP_DIR="$(mktemp -d)"
TEMP_INSTALLER="$TEMP_DIR/install.sh"
cleanup() {
  rm -f "$TEMP_INSTALLER"
  rmdir "$TEMP_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

curl -fsSL "$INSTALL_SCRIPT_URL" -o "$TEMP_INSTALLER"
chmod 700 "$TEMP_INSTALLER"
"$TEMP_INSTALLER" "$@"
