#!/usr/bin/env bash
# 停止 cursor-tg-bot（与 src/main.ts 的 .run/cursor-tg-bot.pid 对应）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="${SCRIPT_DIR}/.run/cursor-tg-bot.pid"

if [[ ! -f "${PIDFILE}" ]]; then
  echo "[stop] 无 pid 文件，尝试按命令行查找..."
  pids=$(pgrep -f "tsx.*main" 2>/dev/null || true)
  if [[ -z "${pids}" ]]; then
    echo "[stop] 未发现运行中的 Bot 进程"
    exit 0
  fi
  echo "[stop] kill: ${pids}"
  kill ${pids} 2>/dev/null || true
  exit 0
fi

old_pid="$(tr -d ' \n' < "${PIDFILE}")"
if [[ -z "${old_pid}" ]]; then
  rm -f "${PIDFILE}"
  echo "[stop] pid 文件为空，已删除"
  exit 0
fi

if kill -0 "${old_pid}" 2>/dev/null; then
  echo "[stop] 结束 Bot PID=${old_pid}"
  kill "${old_pid}" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "${old_pid}" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "${old_pid}" 2>/dev/null; then
    echo "[stop] 仍在运行，发送 SIGKILL"
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
else
  echo "[stop] PID ${old_pid} 已不存在"
fi

rm -f "${PIDFILE}"
echo "[stop] 完成"
