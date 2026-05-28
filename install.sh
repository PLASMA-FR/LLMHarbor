#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${LLMHARBOR_REPO:-https://github.com/PLASMA-FR/LLMHarbor.git}"
INSTALL_DIR="${LLMHARBOR_HOME:-$HOME/.llmharbor/app}"
BIN_DIR="${LLMHARBOR_BIN_DIR:-$HOME/.local/bin}"
COMMAND_PATH="$BIN_DIR/llmharbor"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "Error: $*"
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  command_exists "$1" || fail "Missing required command: $1"
}

main() {
  require_cmd git
  require_cmd node
  require_cmd npm

  mkdir -p "$BIN_DIR"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Updating LLMHarbor in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  elif [[ -e "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR already exists but is not a git checkout. Set LLMHARBOR_HOME to another directory."
  else
    log "Cloning LLMHarbor into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  log "Installing dependencies and building production assets"
  LLMHARBOR_HOME="$INSTALL_DIR" "$INSTALL_DIR/bin/llmharbor" install

  ln -sfn "$INSTALL_DIR/bin/llmharbor" "$COMMAND_PATH"
  chmod +x "$INSTALL_DIR/bin/llmharbor"

  cat <<EOF

LLMHarbor installed.

Command:
  $COMMAND_PATH

Next steps:
  llmharbor start
  llmharbor open

If your shell cannot find llmharbor, add this to your shell profile:
  export PATH="$BIN_DIR:\$PATH"
EOF
}

main "$@"
