#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${LLMHARBOR_REPO:-https://github.com/PLASMA-FR/LLMHarbor.git}"
INSTALL_DIR="${LLMHARBOR_HOME:-$HOME/.llmharbor/app}"
BIN_DIR="${LLMHARBOR_BIN_DIR:-$HOME/.local/bin}"
COMMAND_PATH="$BIN_DIR/llmharbor"
MIN_NODE_MESSAGE="Node.js ^22.12.0 or ^24.0.0"

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

require_supported_node() {
  require_cmd node
  local version supported
  version="$(node -p 'process.versions.node')" || fail "Could not determine the Node.js version"
  supported="$(node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.stdout.write(String((major === 22 && minor >= 12) || major === 24));
  ')" || fail "Could not validate the Node.js version"
  [[ "$supported" == "true" ]] || fail "$MIN_NODE_MESSAGE is required; found Node.js $version"
}

canonical_target() {
  local target="$1" parent name
  if [[ -d "$target" ]]; then
    (cd "$target" >/dev/null 2>&1 && pwd -P)
    return
  fi
  parent="$(dirname "$target")"
  name="$(basename "$target")"
  if [[ -d "$parent" ]]; then
    parent="$(cd "$parent" >/dev/null 2>&1 && pwd -P)"
    printf '%s/%s\n' "$parent" "$name"
  else
    node -e 'process.stdout.write(require("path").resolve(process.argv[1]) + "\n")' "$target"
  fi
}

assert_existing_install_idle() {
  local pid_file="$INSTALL_DIR/.llmharbor/llmharbor.pid" pid="" working_directory=""
  if [[ -f "$pid_file" ]]; then
    pid="$(<"$pid_file")"
    if [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] && kill -0 "$pid" >/dev/null 2>&1; then
      fail "LLMHarbor is running with PID $pid. Stop it before rerunning the installer."
    fi
  fi

  if command_exists systemctl && systemctl is-active --quiet llmharbor.service 2>/dev/null; then
    working_directory="$(systemctl show llmharbor.service -p WorkingDirectory --value 2>/dev/null || true)"
    if [[ -n "$working_directory" && -d "$working_directory" ]]; then
      working_directory="$(cd "$working_directory" >/dev/null 2>&1 && pwd -P)"
      if [[ "$working_directory" == "$INSTALL_DIR" ]]; then
        fail "LLMHarbor is managed by the active llmharbor.service. Stop it before rerunning the installer."
      fi
    fi
  fi
}

install_command_link() {
  local target="$INSTALL_DIR/bin/llmharbor"
  chmod +x "$target"

  if [[ -L "$COMMAND_PATH" ]]; then
    ln -sfn "$target" "$COMMAND_PATH"
  elif [[ -e "$COMMAND_PATH" ]]; then
    fail "$COMMAND_PATH already exists and is not a symbolic link; refusing to overwrite it"
  else
    ln -s "$target" "$COMMAND_PATH"
  fi
}

main() {
  require_cmd git
  require_supported_node
  require_cmd npm

  INSTALL_DIR="$(canonical_target "$INSTALL_DIR")"
  BIN_DIR="$(canonical_target "$BIN_DIR")"
  COMMAND_PATH="$BIN_DIR/llmharbor"
  [[ "$COMMAND_PATH" != "$INSTALL_DIR/bin/llmharbor" ]] \
    || fail "Command directory cannot be the repository's bin directory; it would overwrite the installed CLI: $COMMAND_PATH"
  if [[ -e "$COMMAND_PATH" && ! -L "$COMMAND_PATH" ]]; then
    fail "$COMMAND_PATH already exists and is not a symbolic link; refusing to update or overwrite it"
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    assert_existing_install_idle
    log "Updating LLMHarbor through its lifecycle-aware CLI in $INSTALL_DIR"
    LLMHARBOR_HOME="$INSTALL_DIR" "$INSTALL_DIR/bin/llmharbor" update
  elif [[ -e "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR already exists but is not a git checkout. Set LLMHARBOR_HOME to another directory."
  else
    log "Cloning LLMHarbor into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone -- "$REPO_URL" "$INSTALL_DIR"
    log "Installing dependencies and building production assets"
    LLMHARBOR_HOME="$INSTALL_DIR" "$INSTALL_DIR/bin/llmharbor" install
  fi

  mkdir -p "$BIN_DIR"
  BIN_DIR="$(cd "$BIN_DIR" >/dev/null 2>&1 && pwd -P)"
  COMMAND_PATH="$BIN_DIR/llmharbor"
  [[ -d "$BIN_DIR" && -w "$BIN_DIR" ]] || fail "Command directory is not writable: $BIN_DIR"
  install_command_link

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

  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) ;;
    *) log "Note: $BIN_DIR is not on PATH in this shell." ;;
  esac
}

main "$@"
