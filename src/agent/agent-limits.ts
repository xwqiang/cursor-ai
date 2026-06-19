import { optionalEnv } from "../config/env.js";
import { ChatRequestQueue } from "./chat-queue.js";

export const chatRequestQueue = new ChatRequestQueue();

class Semaphore {
  private readonly max: number;
  private used = 0;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(): Promise<() => void> {
    if (this.used < this.max) {
      this.used++;
      return () => this.releaseOne();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.used++;
    return () => this.releaseOne();
  }

  private releaseOne(): void {
    this.used--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function parseMaxConcurrent(): number {
  const raw = optionalEnv("TG_AGENT_MAX_CONCURRENT", "3");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

export const agentSemaphore = new Semaphore(parseMaxConcurrent());

/** Limit concurrent Cursor Agent runs (chat Q&A + scheduled tasks:task). */
export async function withAgentSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await agentSemaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
