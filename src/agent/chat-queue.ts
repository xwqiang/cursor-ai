/**
 * Serializes async work per key (e.g. per Telegram chat + mode).
 * Callers waiting behind in-flight work receive an optional queue position.
 */
export class ChatRequestQueue {
  private tail = new Map<string, Promise<void>>();
  private waiting = new Map<string, number>();

  async run<T>(
    key: string,
    fn: () => Promise<T>,
    onQueued?: (position: number) => void,
  ): Promise<T> {
    const ahead = this.waiting.get(key) ?? 0;
    if (ahead > 0) {
      onQueued?.(ahead);
    }
    this.waiting.set(key, ahead + 1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const prev = this.tail.get(key) ?? Promise.resolve();
    this.tail.set(
      key,
      prev
        .catch(() => undefined)
        .then(() => gate),
    );

    await prev.catch(() => undefined);

    try {
      return await fn();
    } finally {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left <= 0) this.waiting.delete(key);
      else this.waiting.set(key, left);
      release();
    }
  }
}
