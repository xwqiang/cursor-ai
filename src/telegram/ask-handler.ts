import { basename } from "node:path";
import { createReadStream } from "node:fs";
import type { Context } from "telegraf";
import { formatAgentError } from "../agent/connect-error.js";
import type { SessionManager } from "../agent/session-manager.js";
import { log } from "../config/logger.js";
import { replyHtml } from "./reply.js";
import { sendReviewHtml } from "./send-review.js";

const TYPING_INTERVAL_MS = 4_000;

type IncomingAttachment = {
  kind: "photo" | "document";
  path: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type AgentAskParams = {
  chatId: string;
  messageId: number;
  isAdmin: boolean;
  question: string;
  replyContext?: string;
  useAdvanced: boolean;
  attachments?: IncomingAttachment[];
  /** Dispose advanced session after this turn (/advanced single-turn mode). */
  resetAdvancedAfter?: boolean;
  debug?: boolean;
  userId?: number;
  msgId?: number;
};

export async function handleAgentAsk(
  ctx: Context,
  sessions: SessionManager,
  params: AgentAskParams,
): Promise<void> {
  const {
    chatId,
    messageId,
    isAdmin,
    question,
    replyContext,
    useAdvanced,
    attachments,
    resetAdvancedAfter,
    debug,
    userId,
    msgId,
  } = params;

  if (!ctx.chat) return;
  const chat = ctx.chat;

  void ctx.telegram
    .setMessageReaction(chat.id, messageId, [{ type: "emoji", emoji: "🤔" }])
    .catch(() => undefined);

  void ctx.telegram.sendChatAction(chat.id, "typing").catch(() => undefined);
  const typingTimer = setInterval(() => {
    void ctx.telegram.sendChatAction(chat.id, "typing").catch(() => undefined);
  }, TYPING_INTERVAL_MS);

  let queueNoticeId: number | undefined;

  const notifyQueued = (position: number): void => {
    void ctx
      .reply(`⏳ 上一条还在处理，你的消息已排队（第 ${position} 位）`, {
        reply_parameters: { message_id: messageId },
      })
      .then((m) => {
        queueNoticeId = m.message_id;
      })
      .catch(() => undefined);
  };

  try {
    const startedAt = Date.now();
    if (debug) {
      log.recv(
        `ask start  chat=${chatId} from=${userId ?? "?"} msg=${msgId ?? "?"} admin=${isAdmin} advanced=${useAdvanced} attachments=${attachments?.length ?? 0}`,
      );
    }

    const { text: answer, reviewPath, attachPaths } = await sessions.ask(
      chatId,
      question,
      isAdmin,
      replyContext,
      useAdvanced,
      attachments,
      notifyQueued,
    );

    if (queueNoticeId) {
      await ctx.telegram.deleteMessage(chatId, queueNoticeId).catch(() => undefined);
    }

    if (resetAdvancedAfter) {
      await sessions.reset(chatId, true);
    }

    clearInterval(typingTimer);

    if (debug) {
      log.recv(
        `ask done  chat=${chatId} msg=${msgId ?? "?"} ms=${Date.now() - startedAt} answerLen=${answer.length} review=${Boolean(reviewPath)} attach=${attachPaths?.length ?? 0}`,
      );
    }

    void ctx.telegram
      .setMessageReaction(chat.id, messageId, [{ type: "emoji", emoji: "👍" }])
      .catch(() => undefined);

    try {
      await replyHtml(ctx, answer, messageId);
    } catch (e) {
      log.warn(`replyHtml failed  chat=${chatId} msg=${msgId ?? "?"} err=${String(e)}`);
      await ctx
        .reply(answer, { reply_parameters: { message_id: messageId } })
        .catch(() => undefined);
    }

    if (reviewPath) {
      await sendReviewHtml(ctx, reviewPath, messageId).catch((e: unknown) => {
        log.warn(`send review html: ${String(e)}`);
      });
    }

    if (attachPaths && attachPaths.length > 0) {
      for (const p of attachPaths) {
        await ctx
          .replyWithDocument(
            { source: createReadStream(p), filename: basename(p) },
            { reply_parameters: { message_id: messageId } },
          )
          .catch((e: unknown) => log.warn(`send attachment: ${String(e)}`));
      }
    }
  } catch (error) {
    clearInterval(typingTimer);

    if (queueNoticeId) {
      await ctx.telegram.deleteMessage(chatId, queueNoticeId).catch(() => undefined);
    }

    if (resetAdvancedAfter) {
      await sessions.reset(chatId, true).catch(() => undefined);
    }

    log.warn(`ask failed  chat=${chatId} msg=${msgId ?? "?"} err=${String(error)}`);

    void ctx.telegram
      .setMessageReaction(chat.id, messageId, [{ type: "emoji", emoji: "👎" }])
      .catch(() => undefined);

    await ctx.reply(`❌ ${formatAgentError(error)}`, {
      reply_parameters: { message_id: messageId },
      reply_markup: {
        inline_keyboard: [[{ text: "🔄 新会话", callback_data: `err:new:${chatId}` }]],
      },
    });
  }
}
