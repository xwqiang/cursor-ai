import type { Context } from "telegraf";

const TG_MSG_LIMIT = 4096;

/**
 * Split a long HTML string into chunks that fit within Telegram's message limit.
 * Splits on paragraph boundaries (double newlines) when possible.
 */
function splitMessage(html: string): string[] {
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

export async function replyHtml(ctx: Context, html: string, messageId: number): Promise<void> {
  const chunks = splitMessage(html);

  for (let i = 0; i < chunks.length; i++) {
    const replyTo = i === 0 ? messageId : undefined;
    const opts: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyTo) opts.reply_parameters = { message_id: replyTo };

    try {
      await ctx.reply(chunks[i], opts);
    } catch {
      const plain = stripHtml(chunks[i]);
      const plainOpts: Record<string, unknown> = {};
      if (replyTo) plainOpts.reply_parameters = { message_id: replyTo };
      await ctx.reply(plain, plainOpts);
    }
  }
}
