#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ./scripts/install-room-plugins.sh [options]

Options:
  --source <dir>          Source plugin directory (default: ./room-plugins)
  --dest <dir>            Destination plugin directory (default: ~/.commands-agent/room-plugins)
  --allowlist <file>      Allowlist output file (default: ~/.commands-agent/room-plugins-allowed.json)
  --skip-allowlist        Do not write allowlist file
  --skip-npm-install      Skip npm install for plugins that have package.json
  -h, --help              Show this help
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE_DIR="${REPO_ROOT}/room-plugins"
DEST_DIR="${HOME}/.commands-agent/room-plugins"
ALLOWLIST_PATH="${HOME}/.commands-agent/room-plugins-allowed.json"
WRITE_ALLOWLIST=1
INSTALL_DEPS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"; shift 2 ;;
    --dest)
      DEST_DIR="$2"; shift 2 ;;
    --allowlist)
      ALLOWLIST_PATH="$2"; shift 2 ;;
    --skip-allowlist)
      WRITE_ALLOWLIST=0; shift ;;
    --skip-npm-install)
      INSTALL_DEPS=0; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Source directory not found: ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

echo "Installing room plugins"
echo "Source: ${SOURCE_DIR}"
echo "Dest:   ${DEST_DIR}"

shopt -s nullglob
for plugin_path in "${SOURCE_DIR}"/*; do
  [[ -d "${plugin_path}" ]] || continue
  plugin_name="$(basename "${plugin_path}")"
  dest_plugin_path="${DEST_DIR}/${plugin_name}"

  echo "[${plugin_name}] syncing"
  mkdir -p "${dest_plugin_path}"
  rsync -a --delete --exclude '.DS_Store' --exclude '.git/' --exclude 'node_modules/' \
    "${plugin_path}/" "${dest_plugin_path}/"

  if [[ "${INSTALL_DEPS}" -eq 1 && -f "${dest_plugin_path}/package.json" ]]; then
    echo "[${plugin_name}] npm install --omit=dev"
    npm install --prefix "${dest_plugin_path}" --omit=dev
  fi
done

if [[ "${WRITE_ALLOWLIST}" -eq 1 ]]; then
  node "${REPO_ROOT}/scripts/generate-room-allowlist.mjs" "${DEST_DIR}" "${ALLOWLIST_PATH}"
fi

echo "Done. Restart Commands Desktop to load plugins."
