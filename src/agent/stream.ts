import { log } from "../config/logger.js";

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export async function streamAndCollect(
  run: {
    stream: () => AsyncIterable<StreamEvent>;
    wait: () => Promise<{ status: string; id?: string; result?: unknown }>;
  },
  label: string,
): Promise<string> {
  let thinkingActive = false;
  let textBuf = "";

  for await (const event of run.stream()) {
    switch (event.type) {
      case "thinking_delta": {
        const chunk = String((event as Record<string, unknown>).text ?? "");
        if (chunk) {
          if (!thinkingActive) {
            log.thinkingStart(label);
            thinkingActive = true;
          }
          log.thinkingChunk(chunk);
        }
        break;
      }
      case "thinking_completed":
        if (thinkingActive) {
          log.thinkingEnd(label);
          thinkingActive = false;
        }
        break;
      case "text_delta": {
        const chunk = String((event as Record<string, unknown>).text ?? "");
        if (chunk) {
          textBuf += chunk;
          log.textChunk(chunk);
        }
        break;
      }
      case "tool_call_started": {
        const e = event as Record<string, unknown>;
        log.tool(label, String(e.name ?? e.toolName ?? "unknown"));
        break;
      }
      case "tool_call_completed": {
        const e = event as Record<string, unknown>;
        log.toolResult(label, String(e.result ?? e.output ?? "").slice(0, 300));
        break;
      }
      case "turn_ended":
        log.turnEnd(label);
        break;
      case "assistant": {
        const msg = (event as Record<string, unknown>).message as
          | { content?: Array<{ type: string; text?: string }> }
          | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "thinking" && block.text) {
            log.thinkingStart(label);
            log.thinkingChunk(block.text);
            log.thinkingEnd(label);
          } else if (block.type === "text" && block.text) {
            textBuf += block.text;
            log.textBlock(label, block.text);
          } else if (block.type === "tool_use") {
            log.tool(label, JSON.stringify(block).slice(0, 300));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const result = await run.wait();
  if (result.status === "error") throw new Error(`agent run failed: ${result.id ?? "unknown"}`);
  return String(result.result ?? textBuf).trim();
}
