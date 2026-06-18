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
# Resolve project bootstrap
#   --project sets PROJECT_ROOT (local dev)
#   Otherwise: PROJECT_GIT_URL | PROJECT_ROOT | data/projects.json
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p)
      export PROJECT_ROOT="$2"; shift 2 ;;
    --project=*)
      export PROJECT_ROOT="${1#*=}"; shift ;;
    *)
      shift ;;
  esac
done

HAS_PROJECTS_JSON=false
[[ -f "$SCRIPT_DIR/data/projects.json" ]] && HAS_PROJECTS_JSON=true

can_start=false
[[ -n "${PROJECT_GIT_URL:-}" ]] && can_start=true
[[ "$HAS_PROJECTS_JSON" == true ]] && can_start=true
if [[ -n "${PROJECT_ROOT:-}" && -d "$PROJECT_ROOT" ]]; then
  can_start=true
  export PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
fi

if [[ "$can_start" != true ]]; then
  echo "[error] 未配置目标项目。"
  if [[ -n "${PROJECT_ROOT:-}" && ! -d "$PROJECT_ROOT" ]]; then
    echo "  PROJECT_ROOT 不存在: $PROJECT_ROOT"
    echo "  服务器部署请改用 PROJECT_GIT_URL（见 .env.example），不要拷贝本机路径。"
  fi
  echo "  推荐: 在 .env 设置 PROJECT_GIT_URL=git@github.com:org/repo.git"
  echo "  或:   设置 PROJECT_ROOT=/path/to/local/project"
  echo "  或:   cp data/projects.json.example data/projects.json 后编辑"
  exit 1
fi

if [[ -n "${PROJECT_GIT_URL:-}" ]]; then
  echo "[init] project_git=$PROJECT_GIT_URL"
elif [[ -n "${PROJECT_ROOT:-}" ]]; then
  echo "[init] project_root=$PROJECT_ROOT"
else
  echo "[init] projects=data/projects.json"
fi
echo ""

TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "[error] Dependencies not installed (missing tsx)."
  echo "  Run: cd \"$SCRIPT_DIR\" && npm install"
  exit 1
fi

cd "$SCRIPT_DIR"
exec "$TSX_BIN" "$SCRIPT_DIR/src/main.ts"
