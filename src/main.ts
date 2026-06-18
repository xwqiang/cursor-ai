import { installConnectErrorGuard } from "./agent/connect-error.js";
import { releaseBotInstanceLock } from "./bot/instance-lock.js";
import { runBot } from "./bot.js";

installConnectErrorGuard();

void runBot().catch((err: unknown) => {
  releaseBotInstanceLock();
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
