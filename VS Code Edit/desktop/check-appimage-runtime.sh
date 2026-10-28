#!/usr/bin/env bash
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
appimage="${1:-"$script_dir/../release/desktop/KuduNS-0.1.0.AppImage"}"

if [[ ! -x "$appimage" ]]; then
  printf 'AppImage is missing or not executable: %s\n' "$appimage" >&2
  exit 2
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'Unsupported architecture: %s (this build targets x86_64).\n' "$(uname -m)" >&2
  exit 2
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  printf 'Do not launch KuduNS as root; use an unprivileged desktop user.\n' >&2
  exit 1
fi

appimage="$(realpath -- "$appimage")"
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT

if ! (cd "$temporary_dir" && "$appimage" --appimage-extract >/dev/null 2>&1); then
  printf 'Could not inspect the AppImage. Check that its embedded runtime can extract it.\n' >&2
  exit 1
fi

app_dir="$temporary_dir/squashfs-root"
app_binary="$app_dir/kuduns-desktop"
app_run="$app_dir/AppRun"
desktop_entry="$app_dir/KuduNS.desktop"
failures=0

if [[ ! -x "$app_binary" ]]; then
  printf 'Packaged KuduNS executable was not found.\n' >&2
  exit 1
fi

if [[ ! -x "$app_run" ]]; then
  printf 'Packaged AppRun launcher was not found or is not executable.\n' >&2
  failures=1
elif grep -Fq 'NO_SANDBOX' "$app_run"; then
  printf 'AppRun contains a fallback that can inject --no-sandbox.\n' >&2
  failures=1
elif ! grep -Fq 'KuduNS must be run as an unprivileged desktop user.' "$app_run" \
  || ! grep -Fq 'KuduNS refuses to start with --no-sandbox.' "$app_run" \
  || ! grep -Fq 'KuduNS requires unprivileged user namespaces;' "$app_run"; then
  printf 'AppRun is missing one or more required fail-closed sandbox checks.\n' >&2
  failures=1
else
  printf 'AppRun rejects root/--no-sandbox and never injects a sandbox-disabling flag.\n'
fi

missing_libraries=""
for executable in \
  "$app_binary" \
  "$app_dir/chrome_crashpad_handler" \
  "$app_dir/chrome-sandbox" \
  "$app_dir/libffmpeg.so" \
  "$app_dir/libvk_swiftshader.so" \
  "$app_dir/libvulkan.so.1"; do
  [[ -f "$executable" ]] || continue
  unresolved="$(ldd "$executable" 2>&1 | awk '/not found/ { print $1 }' | sort -u)"
  if [[ -n "$unresolved" ]]; then
    missing_libraries+=$'\n'"$(basename "$executable"): $unresolved"
  fi
done
if [[ -n "$missing_libraries" ]]; then
  printf 'Missing shared libraries in the AppImage:\n%s\n' "$missing_libraries" >&2
  failures=1
else
  printf 'Bundled executable and library dependencies: present.\n'
fi

if ! command -v ldconfig >/dev/null 2>&1 || ! ldconfig -p 2>/dev/null | grep -Fq 'libfuse.so.2'; then
  printf 'Missing AppImage launcher dependency: libfuse.so.2 (Ubuntu/Debian package: libfuse2).\n' >&2
  failures=1
else
  printf 'AppImage FUSE 2 runtime: present.\n'
fi

if ! command -v unshare >/dev/null 2>&1 || ! unshare -Ur true >/dev/null 2>&1; then
  printf 'Unprivileged user namespaces are unavailable; KuduNS will refuse to launch rather than disable the sandbox.\n' >&2
  failures=1
else
  printf 'Unprivileged user namespaces: available.\n'
fi

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  printf 'No X11 or Wayland display is available in this session.\n' >&2
  failures=1
else
  printf 'Graphical display environment: present.\n'
fi

if [[ -f "$desktop_entry" ]] && grep -Eq '^Exec=.*--no-sandbox' "$desktop_entry"; then
  printf 'AppImage desktop entry explicitly disables Electron sandboxing.\n' >&2
  failures=1
fi

if [[ "$failures" -ne 0 ]]; then
  printf 'Prerequisite check failed. No system packages were installed and the app was not launched.\n' >&2
  exit 1
fi

printf 'Prerequisites appear present. This check does not launch the UI or test a KuduNS server.\n'
