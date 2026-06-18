export interface ScheduledTask {
  /** 6-char hex, e.g. "a3f7c1" */
  id: string;
  /** Telegram chat ID (string) */
  chatId: string;
  /** Human-readable chat name for display */
  chatTitle?: string;
  /** The prompt to send to the agent each run */
  prompt: string;
  /** Short task title (AI-generated or derived from prompt) */
  title?: string;
  /** Daily fire time — natural language (e.g. "上午9点") or "HH:mm" */
  time: string;
  /** Unix ms when the task was created */
  createdAt: number;
  /** Telegram user ID who created the task */
  createdBy: number;
  /** Unix ms of the last successful run */
  lastRunAt?: number;
  /** Override model ID for this task; falls back to scheduler default if absent */
  model?: string;
  /** Project ID this task belongs to; falls back to default project if absent */
  projectId?: string;
}
