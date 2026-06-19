import type { Context, Telegraf } from "telegraf";

const TG_MSG_LIMIT = 4096;

/**
 * Split a long HTML string into chunks that fit within Telegram's message limit.
 * Splits on paragraph boundaries (double newlines) when possible.
 */
export function splitHtmlMessage(html: string): string[] {
  if (html.length <= TG_MSG_LIMIT) return [html];

  const chunks: string[] = [];
  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n\n", TG_MSG_LIMIT);
    if (splitIdx < TG_MSG_LIMIT * 0.3) {
      splitIdx = remaining.lastIndexOf("\n", TG_MSG_LIMIT);
    }
    if (splitIdx < TG_MSG_LIMIT * 0.3) {
      splitIdx = TG_MSG_LIMIT;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type TelegramApi = Telegraf["telegram"];

/** Send HTML to a chat, splitting long messages and falling back to plain text. */
export async function sendHtmlMessage(
  telegram: TelegramApi,
  chatId: string,
  html: string,
  replyToMessageId?: number,
): Promise<void> {
  const chunks = splitHtmlMessage(html);

  for (let i = 0; i < chunks.length; i++) {
    const replyTo = i === 0 ? replyToMessageId : undefined;
    const opts: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyTo) opts.reply_parameters = { message_id: replyTo };

    try {
      await telegram.sendMessage(chatId, chunks[i], opts);
    } catch {
      const plain = stripHtml(chunks[i]);
      const plainOpts: Record<string, unknown> = {};
      if (replyTo) plainOpts.reply_parameters = { message_id: replyTo };
      await telegram.sendMessage(chatId, plain, plainOpts);
    }
  }
}

export async function replyHtml(ctx: Context, html: string, messageId: number): Promise<void> {
  if (!ctx.chat) return;
  await sendHtmlMessage(ctx.telegram, String(ctx.chat.id), html, messageId);
}
