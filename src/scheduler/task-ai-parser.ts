import { Agent } from "@cursor/sdk";
import { streamAndCollect } from "../agent/stream.js";

export type ParserAgent = Awaited<ReturnType<typeof Agent.create>>;

export interface TaskParseResult {
  /** Standard 5-field cron expression, e.g. "0 9 * * *" (daily at 09:00) */
  time: string;
  /** Detailed prompt to send to the data agent on each run */
  prompt: string;
  /** Short human-readable title, ≤ 20 chars */
  title: string;
}

export interface RefinementContext {
  current: TaskParseResult;
  feedback: string;
}

const SYSTEM_PROMPT = `你是任务规划助手。用户会用自然语言描述一个需要每天定时执行的数据查询或汇报任务。

你的职责：
1. 理解任务意图
2. 推断最佳每日执行时间，输出标准 5 字段 cron 表达式（格式：分 时 * * *）
3. 生成发给数据查询 Agent 的完整 prompt（具体说明查询范围、目标指标、输出格式）
4. 生成不超过 20 字的任务标题

时间推断规则（输出对应 cron）：
- 查昨日/日报/早报/统计 → 0 9 * * *
- 当日汇总/下班前 → 0 18 * * *
- 夜间清算/账期 → 0 2 * * *
- 用户明确说了时间（如"下午3点半"）→ 对应 cron（30 15 * * *）
- 不确定 → 0 9 * * *

重要约束：不要使用任何工具，不要读取文件或执行命令。

输出格式（严格按此模板，不要添加任何其他内容）：
TIME: <分 时 * * *>
TITLE: <任务标题>
PROMPT:
<完整的任务 prompt，可以多行>`;

/**
 * Create a parser agent and prime it with the system prompt.
 * The returned agent stays alive — caller must dispose it when done.
 */
export async function createParserAgent(
  apiKey: string,
  model: string,
  cwd: string,
): Promise<ParserAgent> {
  const agent = await Agent.create({
    apiKey,
    model: { id: model },
    local: { cwd },
  });
  const sysRun = await agent.send(SYSTEM_PROMPT);
  await sysRun.wait();
  return agent;
}

/**
 * Send one parse/refinement turn to an existing parser agent.
 * Reuses the agent's conversation context — no subprocess restart.
 */
export async function runParserTurn(
  agent: ParserAgent,
  description: string,
  refinement?: RefinementContext,
): Promise<TaskParseResult> {
  const msg = refinement ? buildRefinementMessage(description, refinement) : description;
  const run = await agent.send(msg);
  const raw = await streamAndCollect(run as never, "task-parser");
  return parsePlainResponse(raw);
}

function buildRefinementMessage(description: string, r: RefinementContext): string {
  return (
    `原始任务描述: ${description}\n\n` +
    `当前任务参数:\n` +
    `TIME: ${r.current.time}\n` +
    `TITLE: ${r.current.title}\n` +
    `PROMPT:\n${r.current.prompt}\n\n` +
    `用户调整意见: ${r.feedback}\n\n` +
    `请根据调整意见更新任务参数，以相同格式输出。`
  );
}

/**
 * Parse the plain-text response from the parser agent.
 * Expected format:
 *   TIME: 0 9 * * *
 *   TITLE: 任务标题
 *   PROMPT:
 *   具体的 prompt 内容（可以多行）
 */
function parsePlainResponse(raw: string): TaskParseResult {
  const timeMatch = raw.match(/^TIME:\s*(.+)$/m);
  const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
  // Everything from the PROMPT: line (including same-line text) through end of output
  const promptMatch = raw.match(/^PROMPT:\s*([\s\S]*)$/m);

  const time = timeMatch?.[1]?.trim() ?? "";
  const title = (titleMatch?.[1]?.trim() ?? "").slice(0, 20);
  const prompt = promptMatch?.[1]?.trim() ?? "";

  if (!time || !prompt) {
    throw new Error(
      `AI 未按格式返回 TIME/PROMPT 字段。原始内容:\n${raw.slice(0, 400)}`,
    );
  }

  // Validate: must be a 5-field cron expression
  if (!isCronExpr(time)) {
    throw new Error(
      `TIME 字段不是合法的 cron 表达式: "${time}"\n原始内容:\n${raw.slice(0, 400)}`,
    );
  }

  return {
    time,
    prompt,
    title: title || "定时任务",
  };
}

/** Loose check: 5 whitespace-separated fields, each non-empty. */
function isCronExpr(s: string): boolean {
  return /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s.trim());
}
