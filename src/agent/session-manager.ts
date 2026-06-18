import { Agent } from "@cursor/sdk";
import { requiredEnv, optionalEnv } from "../config/env.js";
import { log } from "../config/logger.js";
import { toSdkMcpServers } from "../mcp/normalize.js";
import type { McpServerEntry } from "../mcp/types.js";
import type { ProjectManager } from "../project/manager.js";
import { extractReviewResult } from "../review/extract.js";
import { buildSystemPrompt, buildUserMessage } from "../prompt/system.js";
import { streamAndCollect } from "./stream.js";

export interface AskResult {
  text: string;
  reviewPath?: string;
  attachPaths?: string[];
}

interface ChatSession {
  agent: Awaited<ReturnType<typeof Agent.create>>;
  timer: ReturnType<typeof setTimeout>;
  turns: number;
  projectId: string;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_TURNS = 30;

export class SessionManager {
  private sessions = new Map<string, ChatSession>();
  private advancedSessions = new Map<string, ChatSession>();
  private readonly apiKey: string;
  private readonly model: string;
  private readonly advancedModel: string;
  private readonly projectManager: ProjectManager;

  constructor(projectManager: ProjectManager) {
    this.apiKey = requiredEnv("CURSOR_API_KEY");
    this.model = optionalEnv("CURSOR_MODEL", "auto");
    this.advancedModel = optionalEnv("CURSOR_ADVANCED_MODEL", "claude-opus-4-6");
    this.projectManager = projectManager;
  }

  private async createSession(chatId: string, useAdvanced: boolean): Promise<ChatSession> {
    const store = useAdvanced ? this.advancedSessions : this.sessions;
    await this.disposeSessionFrom(store, chatId, useAdvanced);

    const ctx = await this.projectManager.getContext(chatId);
    const mcpServers = toSdkMcpServers(ctx.mcpServers);
    const mcpNames = Object.keys(mcpServers);
    const systemPrompt = buildSystemPrompt(mcpNames, ctx.name);

    const modelId = useAdvanced ? this.advancedModel : this.model;
    const opts: Record<string, unknown> = {
      apiKey: this.apiKey,
      model: { id: modelId },
      local: { cwd: ctx.root, settingSources: ["project"] },
    };
    if (mcpNames.length > 0) opts.mcpServers = mcpServers;

    const agent = await Agent.create(opts as Parameters<typeof Agent.create>[0]);

    const run = await agent.send(systemPrompt);
    await run.wait();
    const tag = useAdvanced ? "advanced" : "default";
    log.session(`new ${tag} session  chat=${chatId}  project=${ctx.id}  model=${modelId}`);

    const session: ChatSession = {
      agent,
      timer: this.resetTimer(store, chatId, useAdvanced),
      turns: 0,
      projectId: ctx.id,
    };
    store.set(chatId, session);
    return session;
  }

  private resetTimer(
    store: Map<string, ChatSession>,
    chatId: string,
    useAdvanced: boolean,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      log.session(`idle timeout  chat=${chatId}`);
      void this.disposeSessionFrom(store, chatId, useAdvanced).catch((err) => {
        log.warn(`dispose after idle timeout failed  chat=${chatId}  err=${String(err)}`);
      });
    }, SESSION_IDLE_MS);
  }

  private async disposeSessionFrom(
    store: Map<string, ChatSession>,
    chatId: string,
    useAdvanced: boolean,
  ): Promise<void> {
    const old = store.get(chatId);
    if (!old) return;
    clearTimeout(old.timer);
    store.delete(chatId);
    try {
      await old.agent[Symbol.asyncDispose]();
    } catch {
      /* ignore */
    }
    const tag = useAdvanced ? "advanced" : "default";
    log.session(`disposed ${tag}  chat=${chatId}  turns=${old.turns}`);
  }

  async ask(
    chatId: string,
    question: string,
    isAdmin: boolean,
    replyContext?: string,
    useAdvanced = false,
    attachments?: {
      kind: "photo" | "document";
      path: string;
      filename?: string;
      mimeType?: string;
      sizeBytes?: number;
    }[],
  ): Promise<AskResult> {
    const store = useAdvanced ? this.advancedSessions : this.sessions;
    let session = store.get(chatId);

    const currentProjectId = this.projectManager.getProjectIdForChat(chatId);
    if (
      !session ||
      session.turns >= SESSION_MAX_TURNS ||
      session.projectId !== currentProjectId
    ) {
      session = await this.createSession(chatId, useAdvanced);
    }

    clearTimeout(session.timer);
    session.timer = this.resetTimer(store, chatId, useAdvanced);
    session.turns++;

    const message = buildUserMessage(question, isAdmin, replyContext, attachments);
    const ctx = await this.projectManager.getContext(chatId);
    const startedAt = Date.now();

    try {
      const run = await session.agent.send(message);
      const raw = await streamAndCollect(run as never, "bot");
      const body = raw || "抱歉，我暂时无法回答这个问题。";
      const { text, reviewPath, attachPaths } = extractReviewResult(body, ctx.root, startedAt);
      if (!isAdmin) return { text, attachPaths };
      return { text, reviewPath, attachPaths };
    } catch (err) {
      await this.disposeSessionFrom(store, chatId, useAdvanced);
      throw err;
    }
  }

  async reset(chatId: string, useAdvanced: boolean): Promise<void> {
    const store = useAdvanced ? this.advancedSessions : this.sessions;
    await this.disposeSessionFrom(store, chatId, useAdvanced);
    log.session(`manual reset  chat=${chatId}  advanced=${useAdvanced}`);
  }

  async disposeAll(): Promise<void> {
    for (const chatId of this.sessions.keys()) {
      await this.disposeSessionFrom(this.sessions, chatId, false);
    }
    for (const chatId of this.advancedSessions.keys()) {
      await this.disposeSessionFrom(this.advancedSessions, chatId, true);
    }
  }
}
