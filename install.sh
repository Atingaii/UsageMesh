#!/bin/sh
set -eu

REPO="Atingaii/UsageMesh"
DEFAULT_RELEASE_BASE="https://github.com/$REPO/releases/latest/download"
BASE="${USAGEMESH_RELEASE_BASE:-$DEFAULT_RELEASE_BASE}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux) PLATFORM="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCHIVE_ARCH="x86_64" ;;
  arm64|aarch64) ARCHIVE_ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

STEM="usagemesh-${PLATFORM}-${ARCHIVE_ARCH}"
ASSET="${STEM}.tar.gz"
CHECKSUM="${STEM}.sha256"

path_has_dir() {
  wanted="$1"
  old_ifs=$IFS
  IFS=:
  for entry in ${PATH:-}; do
    [ "$entry" = "$wanted" ] && { IFS=$old_ifs; return 0; }
  done
  IFS=$old_ifs
  return 1
}

choose_install_dir() {
  if [ -n "${USAGEMESH_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$USAGEMESH_INSTALL_DIR"
    return
  fi
  for candidate in "$HOME/.local/bin" "$HOME/bin" "$HOME/.cargo/bin"; do
    if path_has_dir "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s\n' "$HOME/.local/bin"
}

INSTALL_DIR="$(choose_install_dir)"
WAS_ON_PATH=0
path_has_dir "$INSTALL_DIR" && WAS_ON_PATH=1
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t usagemesh)"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$INSTALL_DIR"

resolve_github_token() {
  for name in USAGEMESH_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN; do
    eval "value=\${$name:-}"
    if [ -n "${value:-}" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  if command -v gh >/dev/null 2>&1; then
    gh auth token 2>/dev/null || true
  fi
}

download_direct() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 2 --connect-timeout 15 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
  else
    return 1
  fi
}

download_with_gh() {
  name="$1"
  output="$2"
  command -v gh >/dev/null 2>&1 || return 1
  token="$(resolve_github_token)"
  if [ -n "${token:-}" ]; then
    GH_TOKEN="$token" gh release download --repo "$REPO" --pattern "$name" --output "$output" --clobber >/dev/null
  else
    gh release download --repo "$REPO" --pattern "$name" --output "$output" --clobber >/dev/null
  fi
}

download_release_file() {
  name="$1"
  output="$2"

  if download_direct "$BASE/$name" "$output"; then
    return 0
  fi

  if [ -z "${USAGEMESH_RELEASE_BASE:-}" ]; then
    echo "Direct latest-release download failed; trying GitHub CLI..." >&2
    if download_with_gh "$name" "$output"; then
      return 0
    fi
  fi

  echo "Failed to download $name." >&2
  echo "If GitHub access is restricted, run 'gh auth login' once and retry." >&2
  exit 1
}

download_release_file "$ASSET" "$TMP/$ASSET"
download_release_file "$CHECKSUM" "$TMP/$CHECKSUM"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c "$CHECKSUM")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$TMP" && shasum -a 256 -c "$CHECKSUM")
else
  echo "No SHA-256 verifier found; refusing an unverified install." >&2
  exit 1
fi

tar -xzf "$TMP/$ASSET" -C "$TMP"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$TMP/usagemesh" "$INSTALL_DIR/usagemesh"
else
  cp "$TMP/usagemesh" "$INSTALL_DIR/usagemesh"
  chmod 0755 "$INSTALL_DIR/usagemesh"
fi

BINARY="$INSTALL_DIR/usagemesh"
"$BINARY" --version

if [ "$WAS_ON_PATH" -eq 0 ]; then
  SHELL_NAME="$(basename "${SHELL:-sh}")"
  case "$SHELL_NAME" in
    zsh) PROFILE="$HOME/.zshrc" ;;
    bash) if [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"; else PROFILE="$HOME/.profile"; fi ;;
    *) PROFILE="$HOME/.profile" ;;
  esac
  [ -e "$PROFILE" ] || : > "$PROFILE"
  if ! grep -F '# usagemesh' "$PROFILE" >/dev/null 2>&1; then
    printf '\nexport PATH="%s:$PATH" # usagemesh\n' "$INSTALL_DIR" >> "$PROFILE"
  fi
fi

echo
echo "Installed: $BINARY"
if "$BINARY" status >/dev/null 2>&1; then
  echo "Existing UsageMesh configuration detected on this machine."
  echo "Refresh historical accounting after an upgrade with:"
  printf "  '%s' sync --full\n" "$BINARY"
else
  echo "No local UsageMesh configuration detected on this machine."
  echo "If this is the FIRST device for a new workspace:"
  printf "  '%s' setup\n" "$BINARY"
  echo "If another device already owns the workspace, DO NOT run setup here."
  echo "Run 'usagemesh invite' on the existing device and paste its complete"
  echo "'usagemesh join ...' command on this machine."
fi

if [ "$WAS_ON_PATH" -eq 0 ]; then
  echo "A new terminal will find 'usagemesh' through your shell profile."
fi
