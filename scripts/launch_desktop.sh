#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${HOME}/.mortic/logs"
LOG_FILE="${LOG_DIR}/simple-mortic-desktop.log"
MODE="${MORTIC_DESKTOP_LAUNCH_MODE:-dev}"

cd "${REPO_DIR}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found on PATH. Open a terminal with Node.js available, then run:"
  echo "  cd ${REPO_DIR}"
  echo "  npm run desktop:dev"
  exit 127
fi

if [[ "${MORTIC_DESKTOP_LAUNCH_DRY_RUN:-}" == "1" ]]; then
  echo "Simple Mortic launcher is ready."
  echo "Repo: ${REPO_DIR}"
  echo "Mode: ${MODE}"
  echo "Log: ${LOG_FILE}"
  exit 0
fi

kill_existing() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return
  fi

  local patterns=(
    "${REPO_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron dist/desktop/desktop/main.js"
    "node ${REPO_DIR}/node_modules/.bin/electron dist/desktop/desktop/main.js"
  )
  local pids=""
  local pattern
  for pattern in "${patterns[@]}"; do
    pids="${pids}"$'\n'"$(pgrep -f "${pattern}" || true)"
  done

  pids="$(printf "%s\n" "${pids}" | awk 'NF && !seen[$0]++')"
  if [[ -z "${pids}" ]]; then
    return
  fi

  echo "Restarting existing Simple Mortic desktop..."
  while IFS= read -r pid; do
    if [[ -n "${pid}" && "${pid}" != "$$" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done <<< "${pids}"
  sleep 0.8
}

echo "Launching Simple Mortic desktop..."
echo "Repo: ${REPO_DIR}"
echo "Log: ${LOG_FILE}"
echo

mkdir -p "${LOG_DIR}"
kill_existing

{
  echo
  echo "===== Simple Mortic desktop launch $(date -u +"%Y-%m-%dT%H:%M:%SZ") ====="
  echo "Repo: ${REPO_DIR}"
  echo "Mode: ${MODE}"
} >> "${LOG_FILE}"

if [[ "${MORTIC_DESKTOP_BACKGROUND:-}" == "1" ]]; then
  if [[ "${MODE}" == "start" ]]; then
    nohup npm run desktop:start >> "${LOG_FILE}" 2>&1 &
  else
    nohup npm run desktop:dev >> "${LOG_FILE}" 2>&1 &
  fi
  pid=$!
  disown "${pid}" 2>/dev/null || true
  echo "Simple Mortic is starting in the background."
  echo "Launcher pid: ${pid}"
  echo "You can close this Terminal window."
  exit 0
fi

if [[ "${MODE}" == "start" ]]; then
  exec npm run desktop:start
fi

exec npm run desktop:dev
