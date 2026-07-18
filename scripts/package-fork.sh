#!/usr/bin/env bash
# Package this OpenCLI fork for local install or CI release artifacts:
#   1) build CLI + cli-manifest
#   2) build Browser Bridge extension
#   3) emit versioned npm .tgz, extension zip, SHA256SUMS, build-info.json
#
# Usage:
#   ./scripts/package-fork.sh
#   ./scripts/package-fork.sh --output-dir /tmp/opencli-artifacts
#   ./scripts/package-fork.sh --copy-to-windows-downloads
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUTPUT_DIR="${ROOT}/artifacts"
COPY_TO_WINDOWS_DOWNLOADS=0

usage() {
  cat <<'EOF'
Usage: package-fork.sh [options]

Options:
  --output-dir <dir>             Artifact output directory (default: artifacts/)
  --copy-to-windows-downloads    Also copy extension zip to a Windows Downloads
                                 path under /mnt/c when available (off by default)
  -h, --help                     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --output-dir requires a directory argument" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --copy-to-windows-downloads)
      COPY_TO_WINDOWS_DOWNLOADS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${OUTPUT_DIR}" != /* ]]; then
  OUTPUT_DIR="${ROOT}/${OUTPUT_DIR}"
fi

CLI_VERSION="$(node -p "require('./package.json').version")"
EXT_VERSION="$(node -p "require('./extension/package.json').version")"
CLI_TGZ_NAME="jackwener-opencli-${CLI_VERSION}.tgz"
EXT_ZIP_NAME="opencli-extension-v${EXT_VERSION}.zip"
CLI_TGZ_PATH="${OUTPUT_DIR}/${CLI_TGZ_NAME}"
EXT_ZIP_PATH="${OUTPUT_DIR}/${EXT_ZIP_NAME}"
SHA256SUMS_PATH="${OUTPUT_DIR}/SHA256SUMS"
BUILD_INFO_PATH="${OUTPUT_DIR}/build-info.json"
SHRINKWRAP_PATH="${ROOT}/npm-shrinkwrap.json"
STAGE_EXT_DIR="${ROOT}/extension-package"
CREATED_SHRINKWRAP=0

cleanup() {
  # Only remove a shrinkwrap that this packaging run created.
  if [[ "${CREATED_SHRINKWRAP}" -eq 1 ]]; then
    rm -f "${SHRINKWRAP_PATH}"
  fi
}
trap cleanup EXIT

# Refuse to clobber a pre-existing shrinkwrap (may be intentional local state).
if [[ -e "${SHRINKWRAP_PATH}" ]]; then
  echo "ERROR: ${SHRINKWRAP_PATH} already exists." >&2
  echo "       Refusing to overwrite or delete a pre-existing npm-shrinkwrap.json." >&2
  echo "       Move/remove it manually, then re-run packaging." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
rm -f "${CLI_TGZ_PATH}" "${EXT_ZIP_PATH}" "${SHA256SUMS_PATH}" "${BUILD_INFO_PATH}"

echo "==> [1/6] Build OpenCLI (tsc + manifest)"
npm run build

echo "==> [2/6] Build extension"
(
  cd extension
  npm run build
  npm run package:release -- --out "${STAGE_EXT_DIR}"
)

echo "==> [3/6] Pack installable CLI tarball (${CLI_TGZ_NAME})"
# Temporary shrinkwrap pins the published dependency tree from the committed lockfile.
# Track creation so cleanup never deletes a pre-existing file.
cp package-lock.json "${SHRINKWRAP_PATH}"
CREATED_SHRINKWRAP=1
# npm 10 may still invoke `prepare` for `npm pack --ignore-scripts`, while npm 11
# skips it. Fence the repository prepare hook explicitly so neither behavior can
# delete the already verified dist/ tree during packing.
OPENCLI_SKIP_PREPARE_BUILD=1 npm pack --ignore-scripts --pack-destination "${OUTPUT_DIR}"
if [[ ! -f "${CLI_TGZ_PATH}" ]]; then
  echo "ERROR: expected npm pack output missing: ${CLI_TGZ_PATH}" >&2
  ls -la "${OUTPUT_DIR}" >&2 || true
  exit 1
fi
# Remove the temporary shrinkwrap promptly; EXIT trap is a safety net.
rm -f "${SHRINKWRAP_PATH}"
CREATED_SHRINKWRAP=0

echo "==> [4/6] Zip extension-package → ${EXT_ZIP_NAME}"
(
  cd "${STAGE_EXT_DIR}"
  rm -f "${EXT_ZIP_PATH}"
  # -X strips extra file attributes for more reproducible archives.
  zip -X -r -q "${EXT_ZIP_PATH}" .
)

echo "==> [5/6] Verify package contents"
# Materialize the tar listing once. Avoid `grep -q` under pipefail: early
# grep exit can SIGPIPE tar and make a successful match look like failure.
TAR_LIST="$(tar -tzf "${CLI_TGZ_PATH}")"
tar_has_path() {
  local rel="$1"
  grep -xF "${rel}" <<<"${TAR_LIST}" >/dev/null && return 0
  grep -F "${rel}/" <<<"${TAR_LIST}" >/dev/null && return 0
  return 1
}

# CLI tarball contents (npm pack nests under package/)
REQUIRED_TAR_PATHS=(
  "package/package.json"
  "package/npm-shrinkwrap.json"
  "package/dist/src/main.js"
  "package/cli-manifest.json"
  "package/clis"
)
for rel in "${REQUIRED_TAR_PATHS[@]}"; do
  if ! tar_has_path "${rel}"; then
    echo "ERROR: CLI tarball missing required path: ${rel}" >&2
    exit 1
  fi
done

PACKED_CLI_VERSION="$(tar -xOf "${CLI_TGZ_PATH}" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version))")"
if [[ "${PACKED_CLI_VERSION}" != "${CLI_VERSION}" ]]; then
  echo "ERROR: packed package.json version ${PACKED_CLI_VERSION} != ${CLI_VERSION}" >&2
  exit 1
fi

# Extension zip: fork-specific runtime markers + manifest version
PACKED_BG_JS="$(unzip -p "${EXT_ZIP_PATH}" dist/background.js)"
if [[ "${PACKED_BG_JS}" != *showPicker* ]]; then
  echo "ERROR: packaged background.js missing showPicker" >&2
  exit 1
fi
if [[ "${PACKED_BG_JS}" != *'within 8s'* ]]; then
  echo "ERROR: packaged background.js missing 8s chooser timeout" >&2
  exit 1
fi
PACKED_EXT_VERSION="$(unzip -p "${EXT_ZIP_PATH}" manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version))")"
if [[ "${PACKED_EXT_VERSION}" != "${EXT_VERSION}" ]]; then
  echo "ERROR: packaged manifest.json version ${PACKED_EXT_VERSION} != ${EXT_VERSION}" >&2
  exit 1
fi

echo "==> [6/6] Write SHA256SUMS + build-info.json"
(
  cd "${OUTPUT_DIR}"
  # Portable SHA256 listing without requiring GNU coreutils options
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${CLI_TGZ_NAME}" "${EXT_ZIP_NAME}" > SHA256SUMS
  else
    # macOS / BSD
    {
      shasum -a 256 "${CLI_TGZ_NAME}"
      shasum -a 256 "${EXT_ZIP_NAME}"
    } > SHA256SUMS
  fi
)

SOURCE_COMMIT="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"

# Prefer useful refs for detached tag CI (e.g. fork-v1.8.7-fengwk.2), not bare HEAD.
resolve_source_ref() {
  local ref=""

  # Explicit override for local/CI callers.
  if [[ -n "${OPENCLI_SOURCE_REF:-}" ]]; then
    printf '%s\n' "${OPENCLI_SOURCE_REF}"
    return 0
  fi

  # GitHub Actions: GITHUB_REF_NAME is the branch or tag name.
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    printf '%s\n' "${GITHUB_REF_NAME}"
    return 0
  fi

  # Symbolic branch when available (not detached).
  ref="$(git -C "${ROOT}" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  if [[ -n "${ref}" ]]; then
    printf '%s\n' "${ref}"
    return 0
  fi

  # Exact tag pointing at HEAD (common for tag-triggered releases).
  ref="$(git -C "${ROOT}" describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [[ -n "${ref}" ]]; then
    printf '%s\n' "${ref}"
    return 0
  fi

  # Fallback: short commit, never the literal "HEAD" from rev-parse --abbrev-ref.
  ref="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || true)"
  if [[ -n "${ref}" ]]; then
    printf '%s\n' "${ref}"
    return 0
  fi

  printf '%s\n' "unknown"
}

SOURCE_REF="$(resolve_source_ref)"

if [[ -n "$(git -C "${ROOT}" status --porcelain 2>/dev/null || true)" ]]; then
  SOURCE_DIRTY=true
else
  SOURCE_DIRTY=false
fi

# Safe JSON generation (no shell string concatenation into JSON).
SOURCE_COMMIT="${SOURCE_COMMIT}" \
SOURCE_REF="${SOURCE_REF}" \
SOURCE_DIRTY="${SOURCE_DIRTY}" \
CLI_VERSION="${CLI_VERSION}" \
EXT_VERSION="${EXT_VERSION}" \
CLI_TGZ_NAME="${CLI_TGZ_NAME}" \
EXT_ZIP_NAME="${EXT_ZIP_NAME}" \
BUILD_INFO_PATH="${BUILD_INFO_PATH}" \
node --input-type=module -e '
import { writeFileSync } from "node:fs";

const buildInfo = {
  schemaVersion: 1,
  repository: "fengwk/OpenCLI",
  sourceCommit: process.env.SOURCE_COMMIT,
  sourceRef: process.env.SOURCE_REF,
  sourceDirty: process.env.SOURCE_DIRTY === "true",
  cliVersion: process.env.CLI_VERSION,
  extensionVersion: process.env.EXT_VERSION,
  cliAsset: process.env.CLI_TGZ_NAME,
  extensionAsset: process.env.EXT_ZIP_NAME,
};

writeFileSync(process.env.BUILD_INFO_PATH, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
'

if [[ "${COPY_TO_WINDOWS_DOWNLOADS}" -eq 1 ]]; then
  echo "==> Optional copy to Windows Downloads"
  WIN_DL="/mnt/c/Users"
  if [[ -d "${WIN_DL}" ]]; then
    USER_CANDIDATES=()
    [[ -n "${WINDOWS_USER:-}" ]] && USER_CANDIDATES+=("${WINDOWS_USER}")
    [[ -n "${USER:-}" ]] && USER_CANDIDATES+=("${USER}")
    COPIED=0
    for u in "${USER_CANDIDATES[@]}" $(ls "${WIN_DL}" 2>/dev/null || true); do
      dest="${WIN_DL}/${u}/Downloads"
      if [[ -d "${dest}" ]]; then
        cp -f "${EXT_ZIP_PATH}" "${dest}/"
        echo "    copied → ${dest}/${EXT_ZIP_NAME}"
        COPIED=1
        break
      fi
    done
    if [[ "${COPIED}" -eq 0 ]]; then
      echo "    (no Downloads dir under /mnt/c/Users — skip)"
    fi
  else
    echo "    (no /mnt/c — skip Windows copy)"
  fi
fi

echo
echo "Done."
echo "  Output dir     : ${OUTPUT_DIR}"
echo "  CLI tarball    : ${CLI_TGZ_PATH}"
echo "  Extension zip  : ${EXT_ZIP_PATH}"
echo "  Checksums      : ${SHA256SUMS_PATH}"
echo "  Build info     : ${BUILD_INFO_PATH}"
echo "  Unpacked ext   : ${STAGE_EXT_DIR}"
echo
echo "Install CLI:  npm install -g ${CLI_TGZ_PATH}"
echo "Reload Chrome extension from the zip or ${STAGE_EXT_DIR}."
echo "Plugin adapters: opencli plugin install ~/proj/my-opencli/packages/chatgpt-agent"
