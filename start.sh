#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load nvm if available
export NVM_DIR="${HOME}/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Load .env
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# Resolve target project directory
#   Priority: --project arg > PROJECT_ROOT env > prompt error
# ---------------------------------------------------------------------------
PROJECT_ROOT="${PROJECT_ROOT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p)
      PROJECT_ROOT="$2"; shift 2 ;;
    --project=*)
      PROJECT_ROOT="${1#*=}"; shift ;;
    *)
      shift ;;
  esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
  echo "[error] No project directory specified."
  echo "Usage: $0 --project /path/to/project"
  echo "   or: set PROJECT_ROOT in .env"
  exit 1
fi

if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "[error] Project directory not found: $PROJECT_ROOT"
  echo "  1. 编辑 .env，设置 PROJECT_ROOT 为服务器上的项目绝对路径（参考 .env.example）"
  echo "  2. 或启动时指定: $0 --project /path/to/project"
  echo "  3. 多项目: cp data/projects.json.example data/projects.json 后编辑"
  exit 1
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
echo "[init] project_root=$PROJECT_ROOT"

echo "[init] installing bot skills into project..."
node "${SCRIPT_DIR}/scripts/install-project-skills.mjs" "$PROJECT_ROOT" "$SCRIPT_DIR"
echo "[init] done"
echo ""

# ---------------------------------------------------------------------------
# Start bot with cwd = project root
# ---------------------------------------------------------------------------
TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "[error] Dependencies not installed (missing tsx)."
  echo "  Run: cd \"$SCRIPT_DIR\" && npm install"
  exit 1
fi

cd "$PROJECT_ROOT"
exec "$TSX_BIN" "$SCRIPT_DIR/src/main.ts"
