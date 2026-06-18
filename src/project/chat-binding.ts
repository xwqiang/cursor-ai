import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BOT_ROOT } from "../config/paths.js";

const DATA_DIR = resolve(BOT_ROOT, "data");
const BINDINGS_PATH = resolve(DATA_DIR, "chat-projects.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export class ChatBinding {
  private bindings: Record<string, string>;

  constructor() {
    if (existsSync(BINDINGS_PATH)) {
      this.bindings = JSON.parse(readFileSync(BINDINGS_PATH, "utf-8")) as Record<string, string>;
    } else {
      this.bindings = {};
    }
  }

  get(chatId: string): string | undefined {
    return this.bindings[chatId];
  }

  set(chatId: string, projectId: string): void {
    this.bindings[chatId] = projectId;
    this.save();
  }

  remove(chatId: string): void {
    delete this.bindings[chatId];
    this.save();
  }

  private save(): void {
    ensureDataDir();
    writeFileSync(BINDINGS_PATH, JSON.stringify(this.bindings, null, 2));
  }
}
