export interface BotInfo {
  id: number;
  username: string;
}

export async function fetchBotInfo(botToken: string): Promise<BotInfo> {
  const base = `https://api.telegram.org/bot${botToken}`;

  const meJson = (await (await fetch(`${base}/getMe`)).json()) as {
    ok?: boolean;
    result?: { id?: number; username?: string; can_read_all_group_messages?: boolean };
  };
  if (!meJson.ok || !meJson.result?.id) throw new Error("Telegram getMe failed");

  const { id: botId, username, can_read_all_group_messages: canReadAll } = meJson.result;
  const botUsername = username ?? "unknown";
  process.stdout.write(
    `[startup] bot=@${botUsername} can_read_all_group_messages=${String(Boolean(canReadAll))}\n`,
  );
  if (!canReadAll) {
    process.stdout.write(
      "[warn] 隐私模式可能仍开启，群内 @消息 可能收不到。请在 BotFather 执行 /setprivacy -> Disable\n",
    );
  }

  return { id: botId, username: botUsername };
}
