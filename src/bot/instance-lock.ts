import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pid } from "node:process";
import { BOT_PID_FILE } from "../config/paths.js";

function isProcessAlive(procPid: number): boolean {
  if (!procPid || procPid <= 0) return false;
  try {
    process.kill(procPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同一 TELEGRAM_BOT_TOKEN 只允许一个 polling 实例（避免 409 Conflict）。 */
export function acquireBotInstanceLock(): void {
  mkdirSync(dirname(BOT_PID_FILE), { recursive: true });
  if (existsSync(BOT_PID_FILE)) {
    const oldPid = Number(readFileSync(BOT_PID_FILE, "utf-8").trim());
    if (isProcessAlive(oldPid)) {
      throw new Error(
        `Bot 已在运行 (PID ${oldPid})。请先结束: kill ${oldPid} 或 ./scripts/stop_bot.sh`,
      );
    }
    unlinkSync(BOT_PID_FILE);
  }
  writeFileSync(BOT_PID_FILE, String(pid), "utf-8");
}

export function releaseBotInstanceLock(): void {
  try {
    if (!existsSync(BOT_PID_FILE)) return;
    const recorded = Number(readFileSync(BOT_PID_FILE, "utf-8").trim());
    if (recorded === pid) unlinkSync(BOT_PID_FILE);
  } catch {
    /* ignore */
  }
}

export function isTelegram409(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("response" in err)) return false;
  const code = (err as { response?: { error_code?: number } }).response?.error_code;
  return code === 409;
}
