import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { Context } from "telegraf";

export async function sendReviewHtml(
  ctx: Context,
  reviewPath: string,
  replyToMessageId: number,
  branchHint?: string,
): Promise<void> {
  const name = basename(reviewPath);
  const caption = branchHint
    ? `📄 代码变更 review（${branchHint}）`
    : "📄 代码变更 review（按 pr-review-canvas 整理）";

  await ctx.replyWithDocument(
    { source: createReadStream(reviewPath), filename: name },
    {
      caption,
      reply_parameters: { message_id: replyToMessageId },
    },
  );
}
