import { CursorAgentError } from "@cursor/sdk";
import { basename, dirname, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pid } from "node:process";
import { Telegraf, type Context } from "telegraf";
import type { Message } from "telegraf/types";
import { SessionManager } from "./agent/session-manager.js";
import {
  acquireBotInstanceLock,
  isTelegram409,
  releaseBotInstanceLock,
} from "./bot/instance-lock.js";
import { optionalBool, optionalEnv, parseIdSet, requiredEnv } from "./config/env.js";
import { log } from "./config/logger.js";
import { BOT_ROOT } from "./config/paths.js";
import { toSdkMcpServers } from "./mcp/normalize.js";
import { probeMcpServers } from "./mcp/probe.js";
import { ProjectManager } from "./project/manager.js";
import { DraftManager, type DraftTombstone } from "./scheduler/draft-manager.js";
import { createParserAgent, runParserTurn } from "./scheduler/task-ai-parser.js";
import { TaskScheduler } from "./scheduler/task-scheduler.js";
import type { ScheduledTask } from "./scheduler/types.js";
import { fetchBotInfo } from "./telegram/bot-info.js";
import { replyHtml } from "./telegram/reply.js";
import { sendReviewHtml } from "./telegram/send-review.js";

const STALE_SECONDS = 10 * 60;
const INBOX_DIR_REL = ".cursor-tg-bot/inbox";
const TYPING_INTERVAL_MS = 4_000;

// ─── Time helpers ────────────────────────────────────────────────────────────

/** Escape user-supplied text for use inside Telegram HTML messages. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert "HH:mm" to a 5-field daily cron expression ("M H * * *").
 * Returns null if the input is not a valid clock time.
 */
function hhmmToCron(s: string): string | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${min} ${h} * * *`;
}

/**
 * Convert a daily cron expression ("M H * * *") to a human-readable time "HH:mm".
 * Falls back to the raw expression if it cannot be interpreted.
 */
function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const min = Number(parts[0]);
    const hour = Number(parts[1]);
    if (Number.isFinite(hour) && Number.isFinite(min)) {
      return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return cron;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * If args begins with "HH:mm prompt…", return the cron-converted time and the rest.
 * All other natural-language time descriptions go through the AI path.
 */
function splitTimeAndPrompt(args: string): { time: string; prompt: string } | null {
  const tokens = args.split(/\s+/);
  if (tokens.length < 2) return null;
  const cron = hhmmToCron(tokens[0]);
  if (cron) return { time: cron, prompt: tokens.slice(1).join(" ") };
  return null;
}

/** Inline keyboard shown on a draft confirmation message. */
function draftKeyboard(chatId: string, userId: number, useAdvanced: boolean) {
  const modelBtn = useAdvanced
    ? { text: "🔬 高级模型 ✓", callback_data: `ta:${chatId}:${userId}` }
    : { text: "🔬 切换高级模型", callback_data: `ta:${chatId}:${userId}` };
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认创建", callback_data: `tc:${chatId}:${userId}` },
        { text: "✏️ 调整描述", callback_data: `tm:${chatId}:${userId}` },
        { text: "❌ 取消", callback_data: `tx:${chatId}:${userId}` },
      ],
      [modelBtn],
    ],
  };
}

/** HTML body of a draft confirmation message. `time` is a cron expression. */
function draftHtml(
  title: string,
  time: string,
  prompt: string,
  useAdvanced = false,
  awaitingFeedback = false,
): string {
  const modelLine = useAdvanced ? "\n<b>模型:</b> 🔬 高级" : "";
  const footer = awaitingFeedback
    ? "\n\n<i>请直接回复此消息，告诉我要修改的地方。</i>"
    : "\n\n确认后创建，或点 <b>调整描述</b> 告诉我要改哪里（回复此消息即可）。";
  return (
    `<b>任务草稿</b>\n\n` +
    `<b>标题:</b> ${escapeHtml(title)}\n` +
    `<b>时间:</b> 每天 ${cronToHuman(time)}` +
    modelLine + "\n" +
    `<b>执行描述:</b>\n${escapeHtml(prompt)}` +
    footer
  );
}

/** Build an inline keyboard for the task list. One "取消" button per task row. */
function taskListKeyboard(tasks: ScheduledTask[]) {
  return {
    inline_keyboard: tasks.map((t) => [
      { text: `取消  ${t.id}  ${cronToHuman(t.time)}`, callback_data: `rm:${t.id}` },
    ]),
  };
}

function taskRowHtml(t: ScheduledTask): string {
  const last = t.lastRunAt
    ? new Date(t.lastRunAt).toLocaleString("zh-CN", { hour12: false })
    : "从未";
  const raw = t.title ?? (t.prompt.length > 40 ? t.prompt.slice(0, 40) + "…" : t.prompt);
  const label = escapeHtml(raw);
  const modelTag = t.model ? " 🔬" : "";
  return `• <code>${t.id}</code>  每天 ${cronToHuman(t.time)}${modelTag}  <b>${label}</b>\n  上次执行: ${last}`;
}

function taskListHtml(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) {
    return "当前群没有定时任务。\n用 <code>/task 每日内容描述</code> 创建一个。";
  }
  return `<b>定时任务列表</b> (${tasks.length} 条)\n\n${tasks.map(taskRowHtml).join("\n\n")}`;
}

function allTasksHtml(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return "当前没有任何定时任务。";
  const groups = new Map<string, ScheduledTask[]>();
  for (const t of tasks) {
    const list = groups.get(t.chatId) ?? [];
    list.push(t);
    groups.set(t.chatId, list);
  }
  const sections: string[] = [`<b>全部定时任务</b> (共 ${tasks.length} 条)\n`];
  for (const [chatId, chatTasks] of groups) {
    const chatName = chatTasks[0].chatTitle ?? chatId;
    sections.push(`<b>${chatName}</b>`);
    sections.push(...chatTasks.map(taskRowHtml));
    sections.push("");
  }
  return sections.join("\n");
}

type IncomingAttachment = {
  kind: "photo" | "document";
  path: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
};

// ─── Bot entry point ─────────────────────────────────────────────────────────

export async function runBot(): Promise<void> {
  const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
  acquireBotInstanceLock();
  const debug = optionalBool("TG_DEBUG", true);
  const bot = new Telegraf(botToken, { handlerTimeout: Infinity });

  const projectManager = new ProjectManager();
  const defaultProject = await projectManager.prepareDefaultProject();
  const projectRoot = defaultProject.root;
  const projectName = defaultProject.name;
  const sdkMcp = toSdkMcpServers(defaultProject.mcpServers);
  log.startup(`project=${projectName}  root=${projectRoot}`);
  log.startup(`mcp_servers=[${Object.keys(sdkMcp).join(", ")}]`);
  log.startup("Bot 使用 Cursor SDK 本地子进程，与 Cursor IDE 里 MCP 面板是两套连接");
  if (optionalBool("TG_MCP_STARTUP_PROBE", true)) {
    await probeMcpServers(sdkMcp);
  }
  const botInfo = await fetchBotInfo(botToken);
  const sessions = new SessionManager(projectManager);
  const adminIds = parseIdSet("TG_ADMIN_IDS");
  log.startup(`admin_ids=[${[...adminIds].join(", ")}]`);
  log.startup(`projects: ${projectManager.listProjects().map(p => p.id).join(", ")}`);

  const scheduler = new TaskScheduler(projectManager);
  scheduler.init(bot);

  const drafts = new DraftManager();
  const apiKey = requiredEnv("CURSOR_API_KEY");
  const model = optionalEnv("CURSOR_MODEL", "auto");
  const advancedModel = optionalEnv("CURSOR_ADVANCED_MODEL", "claude-opus-4-5");

  async function downloadTelegramFile(
    fileId: string,
    outPath: string,
  ): Promise<void> {
    const link = await bot.telegram.getFileLink(fileId);
    const res = await fetch(String(link));
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
  }

  /**
   * Resurrect an expired draft into a live session.
   * @param tomb  - Preserved task state from tombstone
   * @param feedback - Optional new user input; if provided, runs a refinement turn
   * @param editFn  - Function to update the loading indicator message in place
   */
  async function resurrectDraft(
    tomb: DraftTombstone,
    chatId: string,
    userId: number,
    feedback: string | undefined,
    editFn: (html: string, extra: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    let parserAgent;
    try {
      const parserCtx = await projectManager.getContext(chatId);
      parserAgent = await createParserAgent(apiKey, model, parserCtx.root);

      let parsed = tomb.parsed;
      if (feedback) {
        parsed = await runParserTurn(parserAgent, tomb.description, {
          current: tomb.parsed,
          feedback,
        });
      }

      const useAdvanced = tomb.useAdvanced;
      drafts.store({
        chatId,
        chatTitle: tomb.chatTitle,
        userId,
        confirmMsgId: 0, // placeholder — updated after editFn reveals the real msgId
        description: tomb.description,
        parsed,
        awaitingFeedback: false,
        agent: parserAgent,
        useAdvanced,
      });
      drafts.clearTombstone(chatId, tomb.confirmMsgId);

      // Edit the loading-indicator message to become the new confirmation
      await editFn(
        `<i>草稿已超时，会话已重新创建。</i>\n\n` + draftHtml(parsed.title, parsed.time, parsed.prompt, useAdvanced),
        { parse_mode: "HTML", reply_markup: draftKeyboard(chatId, userId, useAdvanced) },
      );

      // The message that editFn updated IS the new confirmation message.
      // We can't know its ID here, but getByUser still works for the callback path.
      // For the reply-detection path we update confirmMsgId after editFn when possible.
    } catch (err) {
      if (parserAgent) void parserAgent[Symbol.asyncDispose]().catch(() => undefined);
      drafts.remove(chatId, userId); // clean up half-stored draft if any
      await editFn(
        `会话恢复失败: ${String(err)}\n请重新发送 /task 创建新任务。`,
        { parse_mode: "HTML" },
      );
    }
  }

  // ─── /task ─────────────────────────────────────────────────────────────────
  bot.command("task", async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const chatTitle =
      "title" in ctx.chat ? (ctx.chat.title as string) : (ctx.from.username ?? String(ctx.from.id));

    const args = ctx.message.text.replace(/^\/task(?:@\w+)?\s*/i, "").trim();
    if (!args) {
      await ctx.reply(
        "用法: <code>/task 每天帮我查一下昨天支付失败的订单</code>\n" +
          "也可以直接指定时间跳过确认: <code>/task 09:00 查询昨日异常</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    // Fast path: explicit "HH:mm prompt" — create directly, no confirmation
    const explicit = splitTimeAndPrompt(args);
    if (explicit) {
      const task = scheduler.addTask(
        chatId, explicit.time, explicit.prompt, ctx.from.id, undefined, chatTitle,
      );
      await ctx.reply(
        `已创建定时任务 <code>${task.id}</code>\n` +
          `<b>时间:</b> 每天 ${cronToHuman(explicit.time)}\n<b>内容:</b> ${escapeHtml(explicit.prompt)}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // AI path: create one parser agent → parse → show draft for confirmation
    const thinking = await ctx.reply("🤔 正在分析任务描述，稍等…");
    let parserAgent;
    try {
      const taskCtx = await projectManager.getContext(chatId);
      parserAgent = await createParserAgent(apiKey, model, taskCtx.root);
      const parsed = await runParserTurn(parserAgent, args);
      await ctx.telegram.deleteMessage(chatId, thinking.message_id).catch(() => undefined);

      const confirmMsg = await ctx.reply(
        draftHtml(parsed.title, parsed.time, parsed.prompt, false),
        { parse_mode: "HTML", reply_markup: draftKeyboard(chatId, ctx.from.id, false) },
      );
      // Agent is stored in the draft — it stays alive until confirm/cancel/expiry
      drafts.store({
        chatId,
        chatTitle,
        userId: ctx.from.id,
        confirmMsgId: confirmMsg.message_id,
        description: args,
        parsed,
        awaitingFeedback: false,
        agent: parserAgent,
        useAdvanced: false,
      });
    } catch (err) {
      // Dispose agent if draft was never stored
      if (parserAgent) void parserAgent[Symbol.asyncDispose]().catch(() => undefined);
      await ctx.telegram
        .editMessageText(
          chatId, thinking.message_id, undefined,
          `任务解析失败: ${String(err)}\n\n请手动指定时间:\n<code>/task 09:00 ${args}</code>`,
          { parse_mode: "HTML" },
        )
        .catch(() => undefined);
    }
  });

  // ─── /tasks ─────────────────────────────────────────────────────────────────
  bot.command("tasks", async (ctx) => {
    if (!ctx.chat) return;
    const tasks = scheduler.listForChat(String(ctx.chat.id));
    await ctx.reply(taskListHtml(tasks), {
      parse_mode: "HTML",
      reply_markup: tasks.length > 0 ? taskListKeyboard(tasks) : undefined,
    });
  });

  // ─── /alltasks (admin) ──────────────────────────────────────────────────────
  bot.command("alltasks", async (ctx) => {
    if (!adminIds.has(ctx.from.id)) {
      await ctx.reply("仅管理员可使用此命令。");
      return;
    }
    await ctx.reply(allTasksHtml(scheduler.listAll()), { parse_mode: "HTML" });
  });

  // ─── Inline button: ta:<chatId>:<userId> — toggle advanced model ─────────────
  bot.action(/^ta:(-?\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const userId = Number(ctx.match[2]);
    if (ctx.from.id !== userId) { await ctx.answerCbQuery("只有任务创建者可以操作"); return; }
    const draft = drafts.getByUser(chatId, userId);
    if (!draft) { await ctx.answerCbQuery("草稿已过期，请重新发送 /task"); return; }
    const useAdvanced = !draft.useAdvanced;
    drafts.update(draft, { useAdvanced });
    await ctx.answerCbQuery(useAdvanced ? "已切换为高级模型" : "已切换为普通模型");
    await ctx.editMessageText(
      draftHtml(draft.parsed.title, draft.parsed.time, draft.parsed.prompt, useAdvanced, draft.awaitingFeedback),
      { parse_mode: "HTML", reply_markup: draftKeyboard(chatId, userId, useAdvanced) },
    ).catch(() => undefined);
  });

  // ─── Inline buttons: draft confirm / modify / cancel ───────────────────────
  // Pattern: tc|tm|tx : <chatId> : <userId>
  bot.action(/^t([cmx]):(-?\d+):(\d+)$/, async (ctx) => {
    const action = ctx.match[1] as "c" | "m" | "x";
    const chatId = ctx.match[2];
    const userId = Number(ctx.match[3]);

    if (ctx.from.id !== userId) {
      await ctx.answerCbQuery("只有任务创建者可以操作");
      return;
    }

    const draft = drafts.getByUser(chatId, userId);

    // ── Live draft ────────────────────────────────────────────────────────────
    if (draft) {
      if (action === "x") {
        drafts.remove(chatId, userId);
        await ctx.answerCbQuery("已取消");
        await ctx.editMessageText("已取消任务创建。", { parse_mode: "HTML" }).catch(() => undefined);

      } else if (action === "c") {
        const advModel = draft.useAdvanced ? advancedModel : undefined;
        const task = scheduler.addTask(
          chatId, draft.parsed.time, draft.parsed.prompt,
          userId, draft.parsed.title, draft.chatTitle, advModel,
        );
        drafts.remove(chatId, userId);
        await ctx.answerCbQuery(`已创建 ${task.id}`);
        const modelNote = draft.useAdvanced ? "\n<b>模型:</b> 🔬 高级" : "";
        await ctx.editMessageText(
          `✅ <b>任务已创建</b>  <code>${task.id}</code>\n` +
            `<b>标题:</b> ${escapeHtml(draft.parsed.title)}\n` +
            `<b>时间:</b> 每天 ${cronToHuman(draft.parsed.time)}` +
            modelNote + "\n" +
            `<b>执行描述:</b>\n${escapeHtml(draft.parsed.prompt)}`,
          { parse_mode: "HTML" },
        ).catch(() => undefined);
        log.startup(`task confirmed  id=${task.id}  chat=${chatId}  model=${task.model ?? "default"}`);

      } else {
        drafts.update(draft, { awaitingFeedback: true });
        await ctx.answerCbQuery("请回复此消息说明要修改的地方");
        await ctx.editMessageText(
          draftHtml(draft.parsed.title, draft.parsed.time, draft.parsed.prompt, draft.useAdvanced, true),
          { parse_mode: "HTML", reply_markup: draftKeyboard(chatId, userId, draft.useAdvanced) },
        ).catch(() => undefined);
      }
      return;
    }

    // ── Expired draft: check tombstone ────────────────────────────────────────
    const msgId = ctx.callbackQuery.message?.message_id ?? 0;
    const tomb = drafts.getExpiredDraft(chatId, msgId);

    if (!tomb) {
      // No tombstone either — truly gone
      await ctx.answerCbQuery("草稿已过期且无法恢复，请重新发送 /task");
      await ctx.editMessageText(
        "<i>草稿已过期（超过 1 小时）。\n请重新发送 /task 创建新任务。</i>",
        { parse_mode: "HTML" },
      ).catch(() => undefined);
      return;
    }

    if (action === "x") {
      // Cancel — just clean up, no resurrection needed
      drafts.clearTombstone(chatId, msgId);
      await ctx.answerCbQuery("已取消");
      await ctx.editMessageText("已取消任务创建。", { parse_mode: "HTML" }).catch(() => undefined);
      return;
    }

    if (action === "c") {
      // Confirm on expired draft — task params are preserved, create directly
      await ctx.answerCbQuery("草稿已超时，任务信息已保留，正在创建…");
      const advModel = tomb.useAdvanced ? advancedModel : undefined;
      const task = scheduler.addTask(
        chatId, tomb.parsed.time, tomb.parsed.prompt,
        userId, tomb.parsed.title, tomb.chatTitle, advModel,
      );
      drafts.clearTombstone(chatId, msgId);
      await ctx.editMessageText(
        `✅ <b>任务已创建</b>  <code>${task.id}</code>\n` +
          `<b>标题:</b> ${escapeHtml(tomb.parsed.title)}\n` +
          `<b>时间:</b> 每天 ${cronToHuman(tomb.parsed.time)}\n` +
          `<b>执行描述:</b>\n${escapeHtml(tomb.parsed.prompt)}\n` +
          `<i>（草稿已超时，使用保留的任务信息创建）</i>`,
        { parse_mode: "HTML" },
      ).catch(() => undefined);
      log.startup(`task confirmed from tombstone  id=${task.id}  chat=${chatId}`);
      return;
    }

    // Modify on expired draft — resurrect session in place
    await ctx.answerCbQuery("草稿已超时，正在为你重新创建会话…");
    await ctx.editMessageText(
      `<i>⏳ 草稿已超时，正在恢复会话，保留参数如下：\n\n` +
        `标题: ${tomb.parsed.title}\n时间: ${cronToHuman(tomb.parsed.time)}</i>`,
      { parse_mode: "HTML" },
    ).catch(() => undefined);

    await resurrectDraft(tomb, chatId, userId, undefined, ctx.editMessageText.bind(ctx));
  });

  // ─── Inline button: rm:<taskId> (task list cancel) ─────────────────────────
  bot.action(/^rm:([a-f0-9]{6})$/, async (ctx) => {
    const taskId = ctx.match[1];
    const chatId = String(ctx.callbackQuery.message?.chat.id ?? "");
    const removed = scheduler.removeTask(chatId, taskId);
    if (!removed) { await ctx.answerCbQuery("任务不存在或已被取消"); return; }
    await ctx.answerCbQuery(`已取消 ${taskId}`);
    const remaining = scheduler.listForChat(chatId);
    await ctx.editMessageText(taskListHtml(remaining), {
      parse_mode: "HTML",
      reply_markup: remaining.length > 0 ? taskListKeyboard(remaining) : undefined,
    }).catch(() => undefined);
  });

  // ─── /deltask <id> — delete a scheduled task by ID ──────────────────────────
  bot.command("deltask", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const taskId = ctx.message.text.replace(/^\/deltask(?:@\w+)?\s*/i, "").trim();
    if (!taskId) {
      await ctx.reply("用法: <code>/deltask 任务ID</code>（ID 可从 /tasks 获取）", {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const chatId = String(ctx.chat.id);
    const isAdmin = adminIds.has(ctx.from.id);
    // Admin can delete across chats; regular users only within their own chat
    const removed = isAdmin
      ? scheduler.removeTaskById(taskId)
      : scheduler.removeTask(chatId, taskId);
    if (!removed) {
      await ctx.reply(`❌ 任务 <code>${escapeHtml(taskId)}</code> 不存在或无权限删除`, {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    await ctx.reply(`✅ 任务 <code>${escapeHtml(taskId)}</code> 已删除`, {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  // ─── /taskinfo <id> — show task details ─────────────────────────────────────
  bot.command("taskinfo", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const taskId = ctx.message.text.replace(/^\/taskinfo(?:@\w+)?\s*/i, "").trim();
    if (!taskId) {
      await ctx.reply("用法: <code>/taskinfo 任务ID</code>", {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const task = scheduler.getTask(taskId);
    const chatId = String(ctx.chat.id);
    const isAdmin = adminIds.has(ctx.from.id);
    if (!task || (!isAdmin && task.chatId !== chatId)) {
      await ctx.reply(`❌ 任务 <code>${escapeHtml(taskId)}</code> 不存在或无权限查看`, {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const lastRun = task.lastRunAt
      ? new Date(task.lastRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "从未执行";
    const created = new Date(task.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const html =
      `<b>📋 任务详情</b>\n\n` +
      `<b>ID</b>: <code>${escapeHtml(task.id)}</code>\n` +
      `<b>标题</b>: ${escapeHtml(task.title ?? "—")}\n` +
      `<b>执行时间</b>: <code>${escapeHtml(task.time)}</code> (${cronToHuman(task.time)})\n` +
      `<b>模型</b>: ${task.model ? `🔬 高级 (<code>${escapeHtml(task.model)}</code>)` : "默认"}\n` +
      `<b>所属群组</b>: ${escapeHtml(task.chatTitle ?? task.chatId)}\n` +
      `<b>创建时间</b>: ${created}\n` +
      `<b>上次执行</b>: ${lastRun}\n\n` +
      `<b>Prompt</b>:\n<pre>${escapeHtml(task.prompt)}</pre>`;
    await ctx.reply(html, {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  // ─── /runtask <id> — trigger task immediately ────────────────────────────────
  bot.command("runtask", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const taskId = ctx.message.text.replace(/^\/runtask(?:@\w+)?\s*/i, "").trim();
    if (!taskId) {
      await ctx.reply("用法: <code>/runtask 任务ID</code>", {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const chatId = String(ctx.chat.id);
    const isAdmin = adminIds.has(ctx.from.id);
    const task = scheduler.getTask(taskId);
    if (!task || (!isAdmin && task.chatId !== chatId)) {
      await ctx.reply(`❌ 任务 <code>${escapeHtml(taskId)}</code> 不存在或无权限执行`, {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    await scheduler.runNow(taskId);
    await ctx.reply(
      `⚡ 任务 <code>${escapeHtml(taskId)}</code>（${escapeHtml(task.title ?? taskId)}）已触发，结果将发送至目标群组。`,
      { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
    );
  });

  // ─── /start — welcome card ──────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const currentProject = projectManager.getProject(projectManager.getProjectIdForChat(chatId));
    const currentName = currentProject?.name ?? projectName;
    const welcome =
      `<b>👋 你好！我是 ${escapeHtml(currentName)} 项目助手</b>\n\n` +
      `📂 当前项目: <code>${escapeHtml(currentName)}</code>\n\n` +
      `直接在群里发消息即可提问，我会自动回复。\n` +
      `支持查代码、查数据库、查日志、查缓存等操作。\n\n` +
      `<i>发送 /help 查看完整功能列表</i>`;
    await ctx.reply(welcome, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 查看任务", callback_data: "help:tasks" },
            { text: "❓ 帮助", callback_data: "help:show" },
          ],
        ],
      },
    });
  });

  // ─── /help — command menu ──────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    if (!ctx.chat) return;
    const isAdmin = ctx.from ? adminIds.has(ctx.from.id) : false;
    const helpText =
      `<b>📖 功能菜单</b>\n\n` +
      `<b>问答</b>\n` +
      `直接发消息 — AI 自动回复\n` +
      `/advanced &lt;问题&gt; — 使用高级模型\n` +
      `/new — 清空上下文，开始新会话\n\n` +
      `<b>项目</b>\n` +
      `/projects — 查看/切换项目\n\n` +
      `<b>定时任务</b>\n` +
      `/task &lt;描述&gt; — 创建定时任务\n` +
      `/tasks — 查看本群任务列表\n` +
      (isAdmin
        ? `\n<b>管理员</b>\n` +
          `/project add local|git … — 添加项目\n` +
          `/project remove|sync &lt;id&gt; — 管理项目\n` +
          `/alltasks — 查看所有群任务\n` +
          `/deltask &lt;id&gt; — 删除任务\n` +
          `/taskinfo &lt;id&gt; — 查看任务详情\n` +
          `/runtask &lt;id&gt; — 立即执行任务\n`
        : "");
    await ctx.reply(helpText, {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  // ─── Inline button: help callbacks ────────────────────────────────────────
  bot.action("help:show", async (ctx) => {
    await ctx.answerCbQuery();
    const helpText =
      `<b>📖 功能菜单</b>\n\n` +
      `<b>问答</b>\n` +
      `直接发消息 — AI 自动回复\n` +
      `/advanced &lt;问题&gt; — 使用高级模型\n` +
      `/new — 清空上下文，开始新会话\n\n` +
      `<b>定时任务</b>\n` +
      `/task &lt;描述&gt; — 创建定时任务\n` +
      `/tasks — 查看本群任务列表`;
    await ctx.editMessageText(helpText, { parse_mode: "HTML" }).catch(() => undefined);
  });

  bot.action("help:tasks", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.callbackQuery.message?.chat.id ?? "");
    const tasks = scheduler.listForChat(chatId);
    await ctx.editMessageText(taskListHtml(tasks), {
      parse_mode: "HTML",
      reply_markup: tasks.length > 0 ? taskListKeyboard(tasks) : undefined,
    }).catch(() => undefined);
  });

  // ─── /projects & /project — project switching ──────────────────────────────
  bot.command(["projects", "project"], async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const chatId = String(ctx.chat.id);
    const args = ctx.message.text.replace(/^\/projects?(?:@\w+)?\s*/i, "").trim();

    // /projects or /project (no args) — list projects with inline buttons
    if (!args) {
      const projects = projectManager.listProjects();
      const currentId = projectManager.getProjectIdForChat(chatId);
      const buttons = projects.map((p) => [{
        text: p.id === currentId ? `✅ ${p.name}（当前）` : p.name,
        callback_data: `proj:use:${p.id}`,
      }]);
      await ctx.reply("<b>📂 项目列表</b>\n\n点击切换当前群绑定的项目：", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    const parts = args.split(/\s+/);
    const sub = parts[0];

    // /project use <id>
    if (sub === "use" && parts[1]) {
      const targetId = parts[1];
      const project = projectManager.getProject(targetId);
      if (!project) {
        await ctx.reply(`❌ 项目 <code>${escapeHtml(targetId)}</code> 不存在`, {
          parse_mode: "HTML",
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      try {
        await projectManager.ensureReady(project);
        projectManager.bindChat(chatId, targetId);
        await sessions.reset(chatId, false);
        await sessions.reset(chatId, true);
        await ctx.reply(
          `✅ 已切换到项目 <b>${escapeHtml(project.name)}</b>\n会话已重置。`,
          { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
        );
      } catch (e) {
        await ctx.reply(`❌ 切换失败: ${String(e)}`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
      return;
    }

    // /project add local <path> (admin)
    if (sub === "add" && parts[1] === "local" && parts[2]) {
      if (!adminIds.has(ctx.from.id)) {
        await ctx.reply("仅管理员可以添加项目。", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      try {
        const project = projectManager.addLocal(parts[2]);
        await ctx.reply(
          `✅ 已注册本地项目 <b>${escapeHtml(project.name)}</b>\n路径: <code>${escapeHtml(parts[2])}</code>`,
          { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
        );
      } catch (e) {
        await ctx.reply(`❌ 添加失败: ${String(e)}`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
      return;
    }

    // /project add git <url> [branch] (admin)
    if (sub === "add" && parts[1] === "git" && parts[2]) {
      if (!adminIds.has(ctx.from.id)) {
        await ctx.reply("仅管理员可以添加项目。", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      try {
        const branch = parts[3] ?? "main";
        const project = projectManager.addGit(parts[2], branch);
        await ctx.reply(
          `✅ 已注册 Git 项目 <b>${escapeHtml(project.name)}</b>\nURL: <code>${escapeHtml(parts[2])}</code>\n分支: <code>${escapeHtml(branch)}</code>`,
          { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
        );
      } catch (e) {
        await ctx.reply(`❌ 添加失败: ${String(e)}`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
      return;
    }

    // /project remove <id> (admin)
    if (sub === "remove" && parts[1]) {
      if (!adminIds.has(ctx.from.id)) {
        await ctx.reply("仅管理员可以删除项目。", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      try {
        const removed = projectManager.removeProject(parts[1]);
        if (!removed) {
          await ctx.reply(`❌ 项目 <code>${escapeHtml(parts[1])}</code> 不存在`, {
            parse_mode: "HTML",
            reply_parameters: { message_id: ctx.message.message_id },
          });
          return;
        }
        await ctx.reply(
          `✅ 项目 <code>${escapeHtml(parts[1])}</code> 已从注册表中移除\n<i>data/repos/ 下的文件未删除，可手动清理</i>`,
          { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
        );
      } catch (e) {
        await ctx.reply(`❌ 删除失败: ${String(e)}`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
      return;
    }

    // /project sync <id> (admin)
    if (sub === "sync" && parts[1]) {
      if (!adminIds.has(ctx.from.id)) {
        await ctx.reply("仅管理员可以同步项目。", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      const project = projectManager.getProject(parts[1]);
      if (!project) {
        await ctx.reply(`❌ 项目 <code>${escapeHtml(parts[1])}</code> 不存在`, {
          parse_mode: "HTML",
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      const syncMsg = await ctx.reply(
        `⏳ 正在同步 <b>${escapeHtml(project.name)}</b>…`,
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
      try {
        await projectManager.syncProject(project);
        await ctx.telegram.editMessageText(
          chatId, syncMsg.message_id, undefined,
          `✅ 项目 <b>${escapeHtml(project.name)}</b> 同步完成`,
          { parse_mode: "HTML" },
        ).catch(() => undefined);
      } catch (e) {
        await ctx.telegram.editMessageText(
          chatId, syncMsg.message_id, undefined,
          `❌ 同步失败: ${String(e)}`,
          { parse_mode: "HTML" },
        ).catch(() => undefined);
      }
      return;
    }

    await ctx.reply(
      "用法:\n" +
      "<code>/projects</code> — 查看项目列表\n" +
      "<code>/project use &lt;id&gt;</code> — 切换项目\n" +
      "<code>/project add local &lt;path&gt;</code> — 添加本地项目\n" +
      "<code>/project add git &lt;url&gt; [branch]</code> — 添加 Git 项目\n" +
      "<code>/project remove &lt;id&gt;</code> — 删除项目\n" +
      "<code>/project sync &lt;id&gt;</code> — 同步项目（Git pull + 安装 skills）",
      { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
    );
  });

  // ─── Inline button: proj:use:<id> — project switching ─────────────────────
  bot.action(/^proj:use:(.+)$/, async (ctx) => {
    const targetId = ctx.match[1];
    const chatId = String(ctx.callbackQuery.message?.chat.id ?? "");
    const project = projectManager.getProject(targetId);
    if (!project) {
      await ctx.answerCbQuery("项目不存在");
      return;
    }
    try {
      await projectManager.ensureReady(project);
      projectManager.bindChat(chatId, targetId);
      await sessions.reset(chatId, false);
      await sessions.reset(chatId, true);
      await ctx.answerCbQuery(`已切换到 ${project.name}`);
      // Update the project list with new current marker
      const projects = projectManager.listProjects();
      const buttons = projects.map((p) => [{
        text: p.id === targetId ? `✅ ${p.name}（当前）` : p.name,
        callback_data: `proj:use:${p.id}`,
      }]);
      await ctx.editMessageText(
        `<b>📂 项目列表</b>\n\n已切换到 <b>${escapeHtml(project.name)}</b>，会话已重置。`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } },
      ).catch(() => undefined);
    } catch (e) {
      await ctx.answerCbQuery(`切换失败: ${String(e)}`);
    }
  });

  // ─── Inline button: retry / new session on error ──────────────────────────
  bot.action(/^err:new:(-?\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await sessions.reset(chatId, false);
    await sessions.reset(chatId, true);
    await ctx.answerCbQuery("已清空会话");
    await ctx.editMessageText("✅ 已开始新会话，上下文已清空。", { parse_mode: "HTML" }).catch(() => undefined);
  });

  // ─── /new — reset session ────────────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    await sessions.reset(chatId, false);
    await sessions.reset(chatId, true);
    await ctx.reply("✅ 已开始新会话，上下文已清空。", {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  // ─── /advanced — single-turn advanced model Q&A ──────────────────────────────
  bot.command("advanced", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const chatId = String(ctx.chat.id);
    const question = ctx.message.text.replace(/^\/advanced(?:@\w+)?\s*/i, "").trim();
    if (!question) {
      await ctx.reply(
        "用法: <code>/advanced@botname 你的问题</code>",
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
      return;
    }
    const isAdmin = adminIds.has(ctx.from.id);
    await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [
      { type: "emoji", emoji: "🤔" },
    ]).catch(() => undefined);
    void ctx.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => undefined);
    const typingTimer = setInterval(() => {
      void ctx.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => undefined);
    }, TYPING_INTERVAL_MS);
    try {
      const { text: answer, reviewPath, attachPaths } = await sessions.ask(
        chatId, question, isAdmin, undefined, true,
      );
      clearInterval(typingTimer);
      await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [
        { type: "emoji", emoji: "👍" },
      ]).catch(() => undefined);
      await replyHtml(ctx, answer, ctx.message.message_id);
      if (reviewPath) {
        await sendReviewHtml(ctx, reviewPath, ctx.message.message_id).catch((e: unknown) => {
          log.warn(`send review html: ${String(e)}`);
        });
      }
      if (attachPaths && attachPaths.length > 0) {
        for (const p of attachPaths) {
          await ctx
            .replyWithDocument(
              { source: createReadStream(p), filename: basename(p) },
              { reply_parameters: { message_id: ctx.message.message_id } },
            )
            .catch((e: unknown) => log.warn(`send attachment: ${String(e)}`));
        }
      }
    } catch (err) {
      clearInterval(typingTimer);
      await ctx.telegram.setMessageReaction(ctx.chat.id, ctx.message.message_id, [
        { type: "emoji", emoji: "👎" },
      ]).catch(() => undefined);
      const errMsg = err instanceof CursorAgentError
        ? `Agent 错误: ${err.message}`
        : String(err);
      await ctx.reply(`❌ ${errMsg}`, {
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 新会话", callback_data: `err:new:${chatId}` },
          ]],
        },
      });
    }
  });

  // ─── Message handler: draft feedback reply + direct Q&A ─────────────────────
  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg || !ctx.chat) return;

    const age = Math.floor(Date.now() / 1000) - msg.date;
    if (age > STALE_SECONDS) return;

    const attachments: IncomingAttachment[] = [];
    const chatId = String(ctx.chat.id);
    const userId = ctx.from?.id ?? 0;
    const msgId = "message_id" in msg ? msg.message_id : 0;

    try {
      if ("photo" in msg && Array.isArray(msg.photo) && msg.photo.length > 0) {
        const best = msg.photo[msg.photo.length - 1];
        const outDir = resolve(BOT_ROOT, INBOX_DIR_REL, chatId);
        const outPath = resolve(outDir, `${msgId}_photo.jpg`);
        if (debug) log.recv(`attachment photo  chat=${chatId} from=${userId} msg=${msgId} fileId=${best.file_id}`);
        await downloadTelegramFile(best.file_id, outPath);
        attachments.push({
          kind: "photo",
          path: outPath,
          sizeBytes: best.file_size,
        });
        if (debug) log.recv(`attachment saved  kind=photo  path=${outPath}`);
      }

      if ("document" in msg && msg.document) {
        const doc = msg.document;
        const rawName = doc.file_name ?? "document";
        const safeName = rawName.replace(/[\\/\0]/g, "_");
        const outDir = resolve(BOT_ROOT, INBOX_DIR_REL, chatId);
        const outPath = resolve(outDir, `${msgId}_${safeName}`);
        if (debug) log.recv(`attachment document  chat=${chatId} from=${userId} msg=${msgId} fileId=${doc.file_id} name=${rawName}`);
        await downloadTelegramFile(doc.file_id, outPath);
        attachments.push({
          kind: "document",
          path: outPath,
          filename: rawName,
          mimeType: doc.mime_type,
          sizeBytes: doc.file_size,
        });
        if (debug) log.recv(`attachment saved  kind=document  path=${outPath}`);
      }
    } catch (e) {
      log.warn(`download attachment failed: ${String(e)}`);
    }

    const text = (
      "text" in msg ? msg.text : "caption" in msg ? (msg as Message.CaptionableMessage).caption : ""
    )?.trim();
    const normalizedText = text || (attachments.length > 0 ? "请分析我发送的附件。" : "");
    if (!normalizedText) return;

    if (normalizedText.startsWith("/")) return;

    // ── Draft refinement: user replied to the bot's confirmation message ──────
    if ("reply_to_message" in msg && msg.reply_to_message) {
      const replyToId = (msg.reply_to_message as Message).message_id;
      const draft = drafts.getByMsg(chatId, replyToId);

      // Draft expired — check tombstone and resurrect if possible
      if (!draft) {
        const tomb = drafts.getExpiredDraft(chatId, replyToId);
        if (tomb && tomb.userId === userId) {
          const notice = await ctx.reply(
            `<i>⏳ 草稿已超时，正在用保留的任务信息 + 你的新描述重新生成…</i>`,
            { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } },
          );
          // Silence the old confirmation message's buttons in the background
          ctx.telegram
            .editMessageReplyMarkup(chatId, replyToId, undefined, undefined)
            .catch(() => undefined);

          await resurrectDraft(
            tomb, chatId, userId, normalizedText,
            async (html, extra) => {
              await ctx.telegram
                .editMessageText(chatId, notice.message_id, undefined, html, extra)
                .catch(() => undefined);
            },
          );
          return;
        }
      }

      if (draft && draft.awaitingFeedback && draft.userId === userId) {
        const thinking = await ctx.reply("🤔 正在调整，稍等…", {
          reply_parameters: { message_id: msg.message_id },
        });
        try {
          // Reuse the same parser agent — true multi-turn conversation, no subprocess restart
          const updated = await runParserTurn(
            draft.agent,
            draft.description,
            { current: draft.parsed, feedback: normalizedText },
          );
          drafts.update(draft, { parsed: updated, awaitingFeedback: false });
          await ctx.telegram.deleteMessage(chatId, thinking.message_id).catch(() => undefined);
          await ctx.telegram
            .editMessageText(
              chatId, draft.confirmMsgId, undefined,
              draftHtml(updated.title, updated.time, updated.prompt, draft.useAdvanced),
              { parse_mode: "HTML", reply_markup: draftKeyboard(chatId, userId, draft.useAdvanced) },
            )
            .catch(() => undefined);
        } catch (err) {
          await ctx.telegram
            .editMessageText(
              chatId, thinking.message_id, undefined,
              `调整失败: ${String(err)}`,
              { parse_mode: "HTML" },
            )
            .catch(() => undefined);
          drafts.update(draft, { awaitingFeedback: false });
        }
        return;
      }
    }

    // ── Q&A: process all non-command messages directly ─────────────────────
    if (debug) {
      log.recv(
        `route  chat=${chatId} from=${userId} msg=${msgId} attachments=${attachments.length}`,
      );
    }

    // Skip messages from bots (including self)
    if (ctx.from?.is_bot) return;

    const question = normalizedText;
    if (debug) log.recv(`chat=${chatId}  from=${userId}  q=${question.slice(0, 80)}`);

    let replyContext: string | undefined;
    if ("reply_to_message" in msg && msg.reply_to_message) {
      const replied = msg.reply_to_message as Message;
      const repliedText =
        ("text" in replied ? replied.text : undefined) ??
        ("caption" in replied ? (replied as Message.CaptionableMessage).caption : undefined) ??
        "";
      if (repliedText) {
        replyContext =
          repliedText.length > 2000 ? repliedText.slice(0, 2000) + "…(截断)" : repliedText;
        if (debug) log.recv(`reply_context=${replyContext.slice(0, 120)}`);
      }
    }

    const isAdmin = adminIds.has(userId);
    void ctx.telegram.setMessageReaction(ctx.chat.id, msg.message_id, [
      { type: "emoji", emoji: "🤔" },
    ]).catch(() => undefined);

    // Typing heartbeat: send "typing" action every 4s while agent is processing
    const chatIdNum = ctx.chat.id;
    void ctx.telegram.sendChatAction(chatIdNum, "typing").catch(() => undefined);
    const typingTimer = setInterval(() => {
      void ctx.telegram.sendChatAction(chatIdNum, "typing").catch(() => undefined);
    }, TYPING_INTERVAL_MS);

    try {
      const startedAt = Date.now();
      if (debug) {
        log.recv(
          `ask start  chat=${chatId} from=${userId} msg=${msgId} admin=${isAdmin} attachments=${attachments.length}`,
        );
      }
      const { text: answer, reviewPath, attachPaths } = await sessions.ask(
        chatId, question, isAdmin, replyContext, false, attachments.length > 0 ? attachments : undefined,
      );
      clearInterval(typingTimer);
      if (debug) {
        log.recv(
          `ask done  chat=${chatId} msg=${msgId} ms=${Date.now() - startedAt} answerLen=${answer.length} review=${Boolean(reviewPath)} attach=${attachPaths?.length ?? 0}`,
        );
      }
      void ctx.telegram.setMessageReaction(ctx.chat.id, msg.message_id, [
        { type: "emoji", emoji: "👍" },
      ]).catch(() => undefined);
      try {
        await replyHtml(ctx, answer, msg.message_id);
      } catch (e) {
        log.warn(`replyHtml failed  chat=${chatId} msg=${msgId} err=${String(e)}`);
        await ctx.reply(answer, { reply_parameters: { message_id: msg.message_id } }).catch(() => undefined);
      }
      if (reviewPath) {
        await sendReviewHtml(ctx, reviewPath, msg.message_id).catch((e: unknown) => {
          log.warn(`send review html: ${String(e)}`);
        });
      }
      if (attachPaths && attachPaths.length > 0) {
        for (const p of attachPaths) {
          await ctx
            .replyWithDocument(
              { source: createReadStream(p), filename: basename(p) },
              { reply_parameters: { message_id: msg.message_id } },
            )
            .catch((e: unknown) => log.warn(`send attachment: ${String(e)}`));
        }
      }
    } catch (error) {
      clearInterval(typingTimer);
      log.warn(`ask failed  chat=${chatId} msg=${msgId} err=${String(error)}`);
      void ctx.telegram.setMessageReaction(ctx.chat.id, msg.message_id, [
        { type: "emoji", emoji: "👎" },
      ]).catch(() => undefined);
      const errMsg =
        error instanceof CursorAgentError
          ? `Cursor SDK 错误: ${error.message}`
          : `回答失败: ${String(error)}`;
      await ctx.reply(`❌ ${errMsg}`, {
        reply_parameters: { message_id: msg.message_id },
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 新会话", callback_data: `err:new:${chatId}` },
          ]],
        },
      });
    }
  });

  bot.catch((err: unknown) => {
    log.error(`unhandled bot error: ${String(err)}`);
  });

  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    log.warn(`deleteWebhook: ${String(err)}`);
  }

  try {
    await bot.launch();
  } catch (err) {
    releaseBotInstanceLock();
    if (isTelegram409(err)) {
      throw new Error(
        "Telegram 409: 已有另一个进程在用同一 Bot Token 轮询 getUpdates。" +
          "请执行: ./scripts/stop_bot.sh 或 ps aux | grep cursor-tg-bot 后 kill 旧进程；" +
          "并确认没有在其他电脑/终端重复启动。",
        { cause: err },
      );
    }
    throw err;
  }

  log.startup(`✓ bot started  @${botInfo.username}  pid=${pid}`);

  const BOT_COMMANDS = [
    { command: "help", description: "查看功能菜单" },
    { command: "projects", description: "查看/切换项目" },
    { command: "new", description: "清空上下文，开始新会话" },
    { command: "task", description: "创建定时任务" },
    { command: "tasks", description: "查看本群定时任务" },
    { command: "advanced", description: "用高级模型回答（后跟问题）" },
  ] as const;
  await Promise.all([
    bot.telegram.setMyCommands(BOT_COMMANDS).catch((e: unknown) => log.warn(`setMyCommands(default): ${String(e)}`)),
    bot.telegram
      .setMyCommands(BOT_COMMANDS, { scope: { type: "all_group_chats" } })
      .catch((e: unknown) => log.warn(`setMyCommands(group): ${String(e)}`)),
  ]);

  const stop = async (): Promise<void> => {
    scheduler.dispose();
    await sessions.disposeAll();
    await bot.stop();
    releaseBotInstanceLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
