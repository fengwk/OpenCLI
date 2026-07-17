#!/usr/bin/env bash
# Package this OpenCLI fork for local install:
#   1) build CLI + cli-manifest
#   2) build Browser Bridge extension
#   3) emit dated extension zip (+ optional Windows Downloads copy)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M)"
EXT_VER="$(node -p "require('./extension/package.json').version" 2>/dev/null || echo '1.0.22')"
ZIP_NAME="opencli-extension-ws-capture-v${EXT_VER}-fork-${STAMP}.zip"
ZIP_PATH="${ROOT}/${ZIP_NAME}"

echo "==> [1/4] Build OpenCLI (tsc + manifest)"
npm run build

echo "==> [2/4] Build extension"
(
  cd extension
  npm run build
  npm run package:release
)

echo "==> [3/4] Zip extension-package → ${ZIP_NAME}"
(
  cd extension-package
  rm -f "$ZIP_PATH"
  zip -r -q "$ZIP_PATH" .
)

# Sanity: new setFileInput markers
if ! unzip -p "$ZIP_PATH" dist/background.js | grep -q 'showPicker'; then
  echo "ERROR: packaged background.js missing showPicker" >&2
  exit 1
fi
if ! unzip -p "$ZIP_PATH" dist/background.js | grep -q 'within 8s'; then
  echo "ERROR: packaged background.js missing 8s chooser timeout" >&2
  exit 1
fi

echo "==> [4/4] Optional copy to Windows Downloads"
WIN_DL="/mnt/c/Users"
if [[ -d "$WIN_DL" ]]; then
  # Prefer $WINDOWS_USER / $USER profile
  USER_CANDIDATES=()
  [[ -n "${WINDOWS_USER:-}" ]] && USER_CANDIDATES+=("$WINDOWS_USER")
  [[ -n "${USER:-}" ]] && USER_CANDIDATES+=("$USER")
  COPIED=0
  for u in "${USER_CANDIDATES[@]}" $(ls "$WIN_DL" 2>/dev/null || true); do
    dest="$WIN_DL/$u/Downloads"
    if [[ -d "$dest" ]]; then
      cp -f "$ZIP_PATH" "$dest/"
      echo "    copied → $dest/$ZIP_NAME"
      COPIED=1
      break
    fi
  done
  if [[ "$COPIED" -eq 0 ]]; then
    echo "    (no Downloads dir under /mnt/c/Users — skip)"
  fi
else
  echo "    (no /mnt/c — skip Windows copy)"
fi

echo
echo "Done."
echo "  Extension zip : $ZIP_PATH"
echo "  Unpacked dir  : $ROOT/extension-package"
echo "  CLI build     : $ROOT/dist (npm install -g . to refresh global opencli)"
echo
echo "Reload Chrome extension from extension-package or the zip."
echo "Plugin adapters: opencli plugin install ~/proj/my-opencli"
