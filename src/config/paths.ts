import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** cursor-tg-bot 仓库根目录（含 package.json、.env） */
export const BOT_ROOT = resolve(__dirname, "..", "..");

export const BOT_PID_FILE = resolve(BOT_ROOT, ".run", "cursor-tg-bot.pid");

loadDotenv({ path: resolve(BOT_ROOT, ".env"), override: true });
