import type { ParserAgent, TaskParseResult } from "./task-ai-parser.js";

const DRAFT_TTL_MS = 15 * 60_000;    // 15 min — confirmation window
const TOMBSTONE_TTL_MS = 60 * 60_000; // 60 min — preserve state for session resurrection

export interface TaskDraft {
  chatId: string;
  chatTitle: string;
  userId: number;
  /** message_id of the bot's confirmation message */
  confirmMsgId: number;
  /** The latest working description (updated with each refinement) */
  description: string;
  parsed: TaskParseResult;
  awaitingFeedback: boolean;
  expiresAt: number;
  /** Parser agent — alive for the draft's lifetime, disposed on remove */
  agent: ParserAgent;
  /** Use the advanced model when executing this task */
  useAdvanced: boolean;
}

/**
 * Preserved state of an expired draft.
 * Enough to recreate a session without asking the user to start over.
 */
export interface DraftTombstone {
  expiredAt: number;
  description: string;
  parsed: TaskParseResult;
  chatTitle: string;
  userId: number;
  confirmMsgId: number;
  useAdvanced: boolean;
}

export class DraftManager {
  private byUser = new Map<string, TaskDraft>();
  private byMsg = new Map<string, TaskDraft>();
  /** chatId:msgId → tombstone, kept for TOMBSTONE_TTL_MS after expiry */
  private tombstones = new Map<string, DraftTombstone>();

  store(draft: Omit<TaskDraft, "expiresAt">): TaskDraft {
    const full: TaskDraft = { ...draft, expiresAt: Date.now() + DRAFT_TTL_MS };
    const uk = ukey(full.chatId, full.userId);
    const mk = mkey(full.chatId, full.confirmMsgId);

    const old = this.byUser.get(uk);
    if (old) {
      this.byMsg.delete(mkey(old.chatId, old.confirmMsgId));
      void old.agent[Symbol.asyncDispose]().catch(() => undefined);
    }

    this.byUser.set(uk, full);
    this.byMsg.set(mk, full);
    return full;
  }

  getByUser(chatId: string, userId: number): TaskDraft | undefined {
    return this.check(this.byUser.get(ukey(chatId, userId)));
  }

  getByMsg(chatId: string, msgId: number): TaskDraft | undefined {
    return this.check(this.byMsg.get(mkey(chatId, msgId)));
  }

  update(draft: TaskDraft, changes: Partial<Omit<TaskDraft, "agent">>): void {
    const oldMk = mkey(draft.chatId, draft.confirmMsgId);
    Object.assign(draft, changes);
    if (changes.confirmMsgId !== undefined) {
      this.byMsg.delete(oldMk);
      this.byMsg.set(mkey(draft.chatId, draft.confirmMsgId), draft);
    }
    draft.expiresAt = Date.now() + DRAFT_TTL_MS;
  }

  remove(chatId: string, userId: number): void {
    const uk = ukey(chatId, userId);
    const d = this.byUser.get(uk);
    if (!d) return;
    this.byUser.delete(uk);
    this.byMsg.delete(mkey(d.chatId, d.confirmMsgId));
    void d.agent[Symbol.asyncDispose]().catch(() => undefined);
  }

  /**
   * Returns the preserved state of an expired draft, if still within TOMBSTONE_TTL_MS.
   * Used to resurrect the session so users don't need to start over.
   */
  getExpiredDraft(chatId: string, msgId: number): DraftTombstone | undefined {
    const key = mkey(chatId, msgId);
    const t = this.tombstones.get(key);
    if (!t) return undefined;
    if (Date.now() - t.expiredAt > TOMBSTONE_TTL_MS) {
      this.tombstones.delete(key);
      return undefined;
    }
    return t;
  }

  /** Remove tombstone once the session has been successfully resurrected. */
  clearTombstone(chatId: string, msgId: number): void {
    this.tombstones.delete(mkey(chatId, msgId));
  }

  private check(d: TaskDraft | undefined): TaskDraft | undefined {
    if (!d) return undefined;
    if (d.expiresAt < Date.now()) {
      // Preserve full state in tombstone before disposing
      this.tombstones.set(mkey(d.chatId, d.confirmMsgId), {
        expiredAt: Date.now(),
        description: d.description,
        parsed: { ...d.parsed },
        chatTitle: d.chatTitle,
        userId: d.userId,
        confirmMsgId: d.confirmMsgId,
        useAdvanced: d.useAdvanced,
      });
      this.remove(d.chatId, d.userId);
      return undefined;
    }
    return d;
  }
}

const ukey = (chatId: string, userId: number) => `${chatId}:${userId}`;
const mkey = (chatId: string, msgId: number) => `${chatId}:${msgId}`;
