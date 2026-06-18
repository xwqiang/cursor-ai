import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BOT_ROOT } from "../config/paths.js";
import type { ScheduledTask } from "./types.js";

const DATA_DIR = resolve(BOT_ROOT, "data");
const DB_PATH = resolve(DATA_DIR, "tasks.db");

// ─── Row ↔ ScheduledTask mapping ─────────────────────────────────────────────

interface TaskRow {
  id: string;
  chat_id: string;
  chat_title: string | null;
  prompt: string;
  title: string | null;
  time: string;
  created_at: number;
  created_by: number;
  last_run_at: number | null;
  deleted: number;
  deleted_at: number | null;
  model: string | null;
  project_id: string | null;
}

function rowToTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    chatId: r.chat_id,
    chatTitle: r.chat_title ?? undefined,
    prompt: r.prompt,
    title: r.title ?? undefined,
    time: r.time,
    createdAt: r.created_at,
    createdBy: r.created_by,
    lastRunAt: r.last_run_at ?? undefined,
    model: r.model ?? undefined,
    projectId: r.project_id ?? undefined,
  };
}

// ─── TaskStore ────────────────────────────────────────────────────────────────

export class TaskStore {
  private readonly db: Database.Database;

  constructor() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT    PRIMARY KEY,
        chat_id     TEXT    NOT NULL,
        chat_title  TEXT,
        prompt      TEXT    NOT NULL,
        title       TEXT,
        time        TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        created_by  INTEGER NOT NULL,
        last_run_at INTEGER,
        deleted     INTEGER NOT NULL DEFAULT 0,
        deleted_at  INTEGER
      )
    `);
    for (const col of [
      "model TEXT",
      "deleted INTEGER NOT NULL DEFAULT 0",
      "deleted_at INTEGER",
      "project_id TEXT",
    ]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already exists */ }
    }
    this.db.exec(
      "UPDATE tasks SET deleted = 1 WHERE deleted_at IS NOT NULL AND deleted = 0",
    );
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  getAll(): ScheduledTask[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE deleted = 0 ORDER BY created_at")
        .all() as TaskRow[]
    ).map(rowToTask);
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  insert(task: ScheduledTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, chat_id, chat_title, prompt, title, time, created_at, created_by, last_run_at, model, project_id)
         VALUES
           (@id, @chatId, @chatTitle, @prompt, @title, @time, @createdAt, @createdBy, @lastRunAt, @model, @projectId)`,
      )
      .run({
        id: task.id,
        chatId: task.chatId,
        chatTitle: task.chatTitle ?? null,
        prompt: task.prompt,
        title: task.title ?? null,
        time: task.time,
        createdAt: task.createdAt,
        createdBy: task.createdBy,
        lastRunAt: task.lastRunAt ?? null,
        model: task.model ?? null,
        projectId: task.projectId ?? null,
      });
  }

  setLastRun(id: string, ts: number): void {
    this.db.prepare("UPDATE tasks SET last_run_at = ? WHERE id = ?").run(ts, id);
  }

  delete(id: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE tasks SET deleted = 1, deleted_at = ? WHERE id = ? AND deleted = 0",
      )
      .run(Date.now(), id);
    return info.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
