import { Agent } from "@cursor/sdk";
import { Cron } from "croner";
import { randomBytes } from "node:crypto";
import type { Telegraf } from "telegraf";
import { withAgentSlot } from "../agent/agent-limits.js";
import { streamAndCollect } from "../agent/stream.js";
import { optionalBool, optionalEnv, requiredEnv } from "../config/env.js";
import { log } from "../config/logger.js";
import { toSdkMcpServers } from "../mcp/normalize.js";
import type { ProjectManager } from "../project/manager.js";
import { buildTaskFullPrompt } from "../prompt/system.js";
import { sendHtmlMessage } from "../telegram/reply.js";
import { TaskStore } from "./task-store.js";
import type { ScheduledTask } from "./types.js";

const EXECUTION_TIMEOUT_MS = 15 * 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private jobs = new Map<string, Cron>();
  private running = new Set<string>();
  private store: TaskStore;
  private monitorTimer?: NodeJS.Timeout;
  private readonly debug: boolean;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly projectManager: ProjectManager;
  private bot!: Telegraf;

  constructor(projectManager: ProjectManager) {
    this.apiKey = requiredEnv("CURSOR_API_KEY");
    this.model = optionalEnv("CURSOR_MODEL", "auto");
    this.projectManager = projectManager;
    this.store = new TaskStore();
    this.debug = optionalBool("TG_DEBUG", false);
  }

  init(bot: Telegraf): void {
    this.bot = bot;
    this.tasks = this.store.getAll();
    for (const task of this.tasks) {
      this.scheduleNext(task);
    }
    log.startup(`scheduler: ${this.tasks.length} task(s) loaded from DB`);
    this.startMonitor();
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  addTask(
    chatId: string,
    time: string,
    prompt: string,
    userId: number,
    title?: string,
    chatTitle?: string,
    model?: string,
    projectId?: string,
  ): ScheduledTask {
    const id = randomBytes(3).toString("hex");
    const projId = projectId ?? this.projectManager.getProjectIdForChat(chatId);
    const task: ScheduledTask = {
      id,
      chatId,
      chatTitle,
      prompt,
      title,
      time,
      createdAt: Date.now(),
      createdBy: userId,
      model,
      projectId: projId,
    };
    this.store.insert(task);
    this.tasks.push(task);
    this.scheduleNext(task);
    return task;
  }

  removeTask(chatId: string, taskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === taskId && t.chatId === chatId);
    if (idx === -1) return false;
    return this._remove(idx, taskId);
  }

  removeTaskById(taskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    return this._remove(idx, taskId);
  }

  private _remove(idx: number, taskId: string): boolean {
    this.store.delete(taskId);
    this.tasks.splice(idx, 1);
    const job = this.jobs.get(taskId);
    if (job) {
      job.stop();
      this.jobs.delete(taskId);
    }
    return true;
  }

  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === taskId);
  }

  listAll(): ScheduledTask[] {
    return [...this.tasks];
  }

  listForChat(chatId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.chatId === chatId);
  }

  async runNow(taskId: string): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    void this.run(task);
    return true;
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
    this.store.close();
  }

  // ─── Scheduling ─────────────────────────────────────────────────────────────

  private scheduleNext(task: ScheduledTask): void {
    const existing = this.jobs.get(task.id);
    if (existing) existing.stop();

    let job: Cron;
    try {
      job = new Cron(task.time, () => void this.run(task));
    } catch {
      log.error(`scheduler: invalid cron "${task.time}" for task=${task.id}, falling back to 09:00`);
      job = new Cron("0 9 * * *", () => void this.run(task));
    }

    const next = job.nextRun();
    const mins = next ? Math.round((next.getTime() - Date.now()) / 60_000) : -1;
    log.startup(
      `scheduler: task=${task.id} cron="${task.time}" project=${task.projectId ?? "default"} next_in=${mins}min`,
    );

    this.jobs.set(task.id, job);
  }

  private startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      try {
        const now = Date.now();
        for (const t of this.tasks) {
          const job = this.jobs.get(t.id);
          if (!job) {
            log.warn(`scheduler: monitor task=${t.id} missing_job`);
            continue;
          }
          const next = job.nextRun();
          const ms = job.msToNext();
          const nextInMin = ms === null ? "null" : String(Math.round(ms / 60_000));
          if (next == null || ms == null) {
            log.warn(`scheduler: monitor task=${t.id} next=null ms_to_next=null`);
          } else if (ms < -5_000 || (next.getTime() < now - 5_000)) {
            log.warn(
              `scheduler: monitor task=${t.id} next_in=${nextInMin}min (IN_PAST)`,
            );
          } else if (ms > 26 * 60 * 60_000) {
            log.warn(
              `scheduler: monitor task=${t.id} next_in=${nextInMin}min (FAR_FUTURE)`,
            );
          } else if (this.debug) {
            log.startup(
              `scheduler: monitor task=${t.id} next_in=${nextInMin}min`,
            );
          }
        }
      } catch (err) {
        log.warn(`scheduler: monitor error: ${String(err)}`);
      }
    }, 60_000);
  }

  // ─── Execution ──────────────────────────────────────────────────────────────

  private async run(task: ScheduledTask): Promise<void> {
    if (this.running.has(task.id)) {
      log.warn(`scheduler: task=${task.id} already running, skip overlap`);
      return;
    }
    this.running.add(task.id);

    log.startup(`scheduler: running task=${task.id} chat=${task.chatId} project=${task.projectId ?? "default"}`);

    const now = Date.now();
    task.lastRunAt = now;
    this.store.setLastRun(task.id, now);

    try {
      const result = await this.executeWithRetry(task);
      const header = `<b>定时汇报</b> · <code>${task.id}</code> · 每天 ${task.time}\n\n`;
      await this.sendToChat(task.chatId, header + (result || "任务执行完成，无输出。"));
    } catch (err) {
      log.error(`scheduler: task=${task.id} error: ${String(err)}`);
      await this.sendToChat(
        task.chatId,
        `<b>定时任务</b> <code>${task.id}</code> 执行失败\n<code>${String(err)}</code>`,
      );
    } finally {
      this.running.delete(task.id);
    }
  }

  private async executeWithRetry(task: ScheduledTask): Promise<string> {
    try {
      return await this.executeWithAgent(task);
    } catch (err) {
      log.warn(`scheduler: task=${task.id} failed, retrying once — ${String(err)}`);
      return await this.executeWithAgent(task);
    }
  }

  private async executeWithAgent(task: ScheduledTask): Promise<string> {
    // Resolve project context for this task
    const projectId = task.projectId ?? this.projectManager.defaultProjectId;
    const ctx = await this.projectManager.getContextByProjectId(projectId);
    const root = ctx.root;
    const mcpServers = toSdkMcpServers(ctx.mcpServers);
    const mcpNames = Object.keys(mcpServers);

    const modelId = task.model ?? this.model;
    const agentOpts: Parameters<typeof Agent.create>[0] = {
      apiKey: this.apiKey,
      model: { id: modelId },
      local: { cwd: root, settingSources: ["project"] },
    };
    if (mcpNames.length > 0) {
      (agentOpts as Record<string, unknown>).mcpServers = mcpServers;
    }

    return withAgentSlot(async () => {
      const agent = await Agent.create(agentOpts);
      try {
        const run = await agent.send(buildTaskFullPrompt(mcpNames, root, task.prompt));
        return await withTimeout(
          streamAndCollect(run as never, `task:${task.id}`),
          EXECUTION_TIMEOUT_MS,
          `task:${task.id}`,
        );
      } finally {
        await agent[Symbol.asyncDispose]().catch(() => undefined);
      }
    });
  }

  private async sendToChat(chatId: string, html: string): Promise<void> {
    try {
      await sendHtmlMessage(this.bot.telegram, chatId, html);
    } catch (err) {
      log.error(`scheduler: sendMessage failed chat=${chatId}: ${String(err)}`);
    }
  }
}
