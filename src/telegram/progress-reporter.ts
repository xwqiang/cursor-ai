import type { Telegraf } from "telegraf";
import type { StreamProgressHooks } from "../agent/stream.js";

type TelegramApi = Telegraf["telegram"];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortenToolName(name: string): string {
  const base = name.split(/[/:@]/).pop()?.trim() || name;
  const known: Record<string, string> = {
    read: "Read",
    read_file: "Read",
    write: "Write",
    write_file: "Write",
    strreplace: "StrReplace",
    grep: "Grep",
    glob: "Glob",
    shell: "Shell",
    run_terminal_cmd: "Shell",
  };
  const key = base.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return known[key] ?? (base.length > 24 ? `${base.slice(0, 21)}…` : base);
}

/** Live Telegram status message updated from agent stream events. */
export class TelegramProgressReporter implements StreamProgressHooks {
  private messageId?: number;
  private lastEditAt = 0;
  private editTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private phase = "准备中…";
  private readonly toolSteps: string[] = [];
  private sawText = false;

  constructor(
    private readonly telegram: TelegramApi,
    private readonly chatId: string,
    private readonly replyToMessageId: number,
    private readonly minIntervalMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.disposed) return;
    const msg = await this.telegram.sendMessage(this.chatId, this.renderHtml(), {
      parse_mode: "HTML",
      reply_parameters: { message_id: this.replyToMessageId },
    });
    this.messageId = msg.message_id;
  }

  async finish(): Promise<void> {
    await this.dispose();
  }

  onThinking(): void {
    this.phase = "思考中…";
    this.scheduleEdit();
  }

  onToolStart(name: string): void {
    const label = shortenToolName(name);
    const last = this.toolSteps[this.toolSteps.length - 1];
    if (last !== label) {
      this.toolSteps.push(label);
      if (this.toolSteps.length > 5) this.toolSteps.shift();
    }
    this.phase = "调用工具";
    this.scheduleEdit();
  }

  onToolDone(_name: string): void {
    /* tool chain already updated on start */
  }

  onText(): void {
    if (this.sawText) return;
    this.sawText = true;
    this.phase = "生成回复…";
    this.scheduleEdit();
  }

  onTurnEnd(): void {
    this.phase = "整理结果…";
    this.scheduleEdit();
  }

  private renderHtml(): string {
    const chain =
      this.toolSteps.length > 0
        ? `\n🔧 <code>${escapeHtml(this.toolSteps.join(" → "))}</code>`
        : "";
    return `<i>⏳ ${escapeHtml(this.phase)}</i>${chain}`;
  }

  private scheduleEdit(): void {
    if (this.disposed || !this.messageId) return;
    if (this.editTimer) return;

    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, this.minIntervalMs - elapsed);

    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.flushEdit();
    }, delay);
  }

  private async flushEdit(): Promise<void> {
    if (this.disposed || !this.messageId) return;
    this.lastEditAt = Date.now();
    try {
      await this.telegram.editMessageText(
        this.chatId,
        this.messageId,
        undefined,
        this.renderHtml(),
        { parse_mode: "HTML" },
      );
    } catch {
      /* rate limit or identical content — ignore */
    }
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
    if (this.messageId) {
      await this.telegram.deleteMessage(this.chatId, this.messageId).catch(() => undefined);
      this.messageId = undefined;
    }
  }
}

export interface AgentProgressReporter {
  start(): Promise<void>;
  finish(): Promise<void>;
  hooks: StreamProgressHooks;
}

export function createTelegramProgressReporter(
  telegram: TelegramApi,
  chatId: string,
  replyToMessageId: number,
  minIntervalMs: number,
): AgentProgressReporter {
  const reporter = new TelegramProgressReporter(
    telegram,
    chatId,
    replyToMessageId,
    minIntervalMs,
  );
  return {
    start: () => reporter.start(),
    finish: () => reporter.finish(),
    hooks: reporter,
  };
}
