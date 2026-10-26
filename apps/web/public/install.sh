#!/bin/sh
# Chili CLI installer. Review this file before running it if you prefer.
# CHILI_VERSION=0.1.0 pins a release; CHILI_INSTALL_DIR overrides ~/.local/bin.
set -eu

fail() { printf 'Chili: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail 'This release supports macOS Apple Silicon and Linux. Windows is not yet supported.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=x64 ;;
  *) fail 'Unsupported CPU architecture.' ;;
esac
target="$platform-$architecture"
case "$target" in
  darwin-arm64|linux-arm64|linux-x64) ;;
  *) fail "No tested release for $target yet. See https://github.com/ponyfly6/chili#使用" ;;
esac
if [ "$platform" = linux ] && command -v ldd >/dev/null 2>&1; then
  if ldd --version 2>&1 | grep -qi musl; then
    fail 'Linux releases require glibc 2.28 or newer; Alpine/musl is not yet supported.'
  fi
fi

base='https://github.com/ponyfly6/chili/releases'
version=${CHILI_VERSION:-}
if [ -z "$version" ]; then
  latest=$(curl --proto '=https' --tlsv1.2 -fsSLI --retry 2 --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "$base/latest") || fail 'Cannot resolve the latest release.'
  case "$latest" in "$base/tag/v"*) version=${latest##*/v} ;; *) fail 'No public CLI release is available yet.' ;; esac
fi
version=${version#v}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'CHILI_VERSION must be major.minor.patch.'
asset="chili-$version-$target.tar.gz"
url="$base/download/v$version"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/chili-install.XXXXXXXX") || fail 'Cannot create a temporary directory.'
staged=''
cleanup() { rm -rf "$temporary"; [ -z "$staged" ] || rm -f "$staged"; }
trap cleanup EXIT HUP INT TERM
printf 'Downloading Chili %s for %s…\n' "$version" "$target"
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 15 --max-time 600 "$url/$asset" -o "$temporary/$asset" || fail 'Download failed; the existing installation has not changed.'
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 15 --max-time 60 "$url/SHA256SUMS" -o "$temporary/SHA256SUMS" || fail 'Cannot download release checksums.'
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{64}$' || fail 'Missing or ambiguous release checksum.'
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{print $1}')
else
  fail 'A SHA-256 tool is required (sha256sum or shasum).'
fi
[ "$expected" = "$actual" ] || fail 'Checksum mismatch; the existing installation has not changed.'
# Extract one known file to stdout: archive paths and symlinks are never written to disk.
tar -xOzf "$temporary/$asset" chili > "$temporary/chili" || fail 'Cannot unpack the release.'
[ -s "$temporary/chili" ] || fail 'The release contains no CLI.'
chmod 755 "$temporary/chili"
reported=$("$temporary/chili" --version) || fail 'The downloaded CLI cannot run on this machine.'
[ "$reported" = "chili $version" ] || fail 'The CLI version does not match the release.'

destination=${CHILI_INSTALL_DIR:-"$HOME/.local/bin"}
case "$destination" in /*) ;; *) fail 'CHILI_INSTALL_DIR must be an absolute path.' ;; esac
mkdir -p "$destination" || fail "Cannot create $destination. Choose a writable CHILI_INSTALL_DIR."
[ ! -d "$destination/chili" ] || fail 'The install destination is a directory.'
staged=$(mktemp "$destination/.chili-install.XXXXXXXX") || fail 'Cannot stage the new installation.'
cat "$temporary/chili" > "$staged"
chmod 755 "$staged"
mv -f "$staged" "$destination/chili"
staged=''
printf '\nInstalled %s at %s/chili\n' "$reported" "$destination"
case ":$PATH:" in
  *":$destination:"*) ;;
  *)
    if [ -z "${CHILI_INSTALL_DIR:-}" ] && [ "${CHILI_NO_MODIFY_PATH:-0}" != 1 ]; then
      shell=${SHELL:-/bin/sh}
      case "${shell##*/}" in
        zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
        bash) if [ "$platform" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
        sh|dash|'') profile="$HOME/.profile" ;;
        *) profile='' ;;
      esac
      if [ -n "$profile" ]; then
        path_line='export PATH="$HOME/.local/bin:$PATH"'
        if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
          printf '\n# Chili CLI\n%s\n' "$path_line" >> "$profile" || printf 'Add %s to PATH manually.\n' "$destination"
        fi
        printf 'Open a new terminal, or run: export PATH="$HOME/.local/bin:$PATH"\n'
      else
        printf 'Add %s to PATH in your shell configuration.\n' "$destination"
      fi
    else
      printf '\nAdd this directory to PATH in your shell profile:\n  %s\n' "$destination"
    fi
    ;;
esac
printf '\nGet started: https://usechili.com/download\nRun: chili --help\nUpdate: rerun this installer. Uninstall: remove %s/chili.\n' "$destination"
