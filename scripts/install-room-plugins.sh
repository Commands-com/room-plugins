#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ./scripts/install-room-plugins.sh [options]

Options:
  --source <dir>          Source plugin directory (default: ./room-plugins)
  --dest <dir>            Destination plugin directory (default: ~/.commands-agent/room-plugins)
  --allowlist <file>      Allowlist output file (derived from --dest parent by default)
  --plugin <name>         Install only a specific plugin (repeatable)
  --skip-allowlist        Do not write allowlist file
  --skip-npm-install      Skip npm install for plugins that have package.json
  -h, --help              Show this help
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE_DIR="${REPO_ROOT}/room-plugins"
DEST_DIR="${HOME}/.commands-agent/room-plugins"
ALLOWLIST_PATH=""
ALLOWLIST_EXPLICIT=0
WRITE_ALLOWLIST=1
INSTALL_DEPS=1
REQUESTED_PLUGINS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"; shift 2 ;;
    --dest)
      DEST_DIR="$2"; shift 2 ;;
    --allowlist)
      ALLOWLIST_PATH="$2"; ALLOWLIST_EXPLICIT=1; shift 2 ;;
    --plugin)
      REQUESTED_PLUGINS+=("$2"); shift 2 ;;
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

# Create destination early so that path resolution below can rely on it.
mkdir -p "${DEST_DIR}"

# Derive allowlist path from the destination directory when not explicitly set.
# The runtime expects room-plugins-allowed.json in the plugin directory's parent.
# We resolve after mkdir so the cd always succeeds, even on fresh installs.
if [[ "${ALLOWLIST_EXPLICIT}" -eq 0 ]]; then
  ALLOWLIST_PATH="$(cd "${DEST_DIR}" && cd .. && pwd)/room-plugins-allowed.json"
fi

echo "Installing room plugins"
echo "Source: ${SOURCE_DIR}"
echo "Dest:   ${DEST_DIR}"

shopt -s nullglob

PLUGIN_PATHS=()
SELECTIVE_INSTALL=0

if [[ "${#REQUESTED_PLUGINS[@]}" -gt 0 ]]; then
  SELECTIVE_INSTALL=1
  seen_plugin_names=":"
  for plugin_name in "${REQUESTED_PLUGINS[@]}"; do
    plugin_path="${SOURCE_DIR}/${plugin_name}"
    if [[ ! -d "${plugin_path}" ]]; then
      echo "Requested plugin not found: ${plugin_name}" >&2
      exit 1
    fi

    case "${seen_plugin_names}" in
      *":${plugin_name}:"*)
        continue
        ;;
    esac

    seen_plugin_names="${seen_plugin_names}${plugin_name}:"
    PLUGIN_PATHS+=("${plugin_path}")
  done
else
  for plugin_path in "${SOURCE_DIR}"/*; do
    [[ -d "${plugin_path}" ]] || continue
    PLUGIN_PATHS+=("${plugin_path}")
  done
fi

if [[ "${SELECTIVE_INSTALL}" -eq 1 ]]; then
  echo "Mode:   selective"
fi

if [[ "${SELECTIVE_INSTALL}" -eq 0 ]]; then
  # Collect source plugin names for stale-directory pruning (Bash 3-compatible).
  # Names are bracketed with colons on both sides so case-matching is exact
  # (e.g. ":template-room:" will not match a dest named "template").
  source_plugin_names=":"
  for plugin_path in "${PLUGIN_PATHS[@]}"; do
    source_plugin_names="${source_plugin_names}$(basename "${plugin_path}"):"
  done

  # Remove destination plugin directories that no longer exist in source.
  # Safety: only delete directories this installer previously managed.
  for dest_path in "${DEST_DIR}"/*; do
    [[ -d "${dest_path}" ]] || continue
    dest_name="$(basename "${dest_path}")"
    case "${source_plugin_names}" in
      *":${dest_name}:"*)
        ;; # still exists in source, keep it
      *)
        if [[ -f "${dest_path}/.installed-by-commands-room-plugins" ]]; then
          echo "[${dest_name}] removing stale plugin directory"
          rm -rf "${dest_path}"
        else
          echo "[${dest_name}] skipping removal (not managed by this installer)"
        fi
        ;;
    esac
  done
fi

# Sync each source plugin to destination
for plugin_path in "${PLUGIN_PATHS[@]}"; do
  plugin_name="$(basename "${plugin_path}")"
  dest_plugin_path="${DEST_DIR}/${plugin_name}"

  echo "[${plugin_name}] syncing"
  mkdir -p "${dest_plugin_path}"
  rsync -a --delete --exclude '.DS_Store' --exclude '.git' --exclude 'node_modules/' \
    "${plugin_path}/" "${dest_plugin_path}/"

  # Marker used by prune step to avoid deleting third-party folders.
  echo "installed by commands-com-agent-rooms" > "${dest_plugin_path}/.installed-by-commands-room-plugins"

  if [[ "${INSTALL_DEPS}" -eq 1 && -f "${dest_plugin_path}/package.json" ]]; then
    echo "[${plugin_name}] npm install --omit=dev"
    npm install --prefix "${dest_plugin_path}" --omit=dev
  fi
done

if [[ "${WRITE_ALLOWLIST}" -eq 1 ]]; then
  node "${REPO_ROOT}/scripts/generate-room-allowlist.mjs" --managed-only "${DEST_DIR}" "${ALLOWLIST_PATH}"
fi

echo "Done. Restart Commands Desktop to load plugins."
