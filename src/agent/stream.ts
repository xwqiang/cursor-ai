import { log } from "../config/logger.js";

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface StreamProgressHooks {
  onThinking?: () => void;
  onToolStart?: (name: string) => void;
  onToolDone?: (name: string) => void;
  onText?: () => void;
  onTurnEnd?: () => void;
}

function toolNameFromEvent(event: Record<string, unknown>): string {
  return String(event.name ?? event.toolName ?? event.tool ?? "unknown");
}

export async function streamAndCollect(
  run: {
    stream: () => AsyncIterable<StreamEvent>;
    wait: () => Promise<{ status: string; id?: string; result?: unknown }>;
  },
  label: string,
  hooks?: StreamProgressHooks,
): Promise<string> {
  let thinkingActive = false;
  let textBuf = "";
  let textHookSent = false;

  const notifyText = (): void => {
    if (textHookSent) return;
    textHookSent = true;
    hooks?.onText?.();
  };

  for await (const event of run.stream()) {
    switch (event.type) {
      case "thinking_delta": {
        const chunk = String((event as Record<string, unknown>).text ?? "");
        if (chunk) {
          if (!thinkingActive) {
            log.thinkingStart(label);
            thinkingActive = true;
            hooks?.onThinking?.();
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
          notifyText();
          textBuf += chunk;
          log.textChunk(chunk);
        }
        break;
      }
      case "tool_call_started": {
        const e = event as Record<string, unknown>;
        const name = toolNameFromEvent(e);
        hooks?.onToolStart?.(name);
        log.tool(label, name);
        break;
      }
      case "tool_call_completed": {
        const e = event as Record<string, unknown>;
        const name = toolNameFromEvent(e);
        hooks?.onToolDone?.(name);
        log.toolResult(label, String(e.result ?? e.output ?? "").slice(0, 300));
        break;
      }
      case "turn_ended":
        hooks?.onTurnEnd?.();
        log.turnEnd(label);
        break;
      case "assistant": {
        const msg = (event as Record<string, unknown>).message as
          | { content?: Array<{ type: string; text?: string; name?: string }> }
          | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "thinking" && block.text) {
            log.thinkingStart(label);
            hooks?.onThinking?.();
            log.thinkingChunk(block.text);
            log.thinkingEnd(label);
          } else if (block.type === "text" && block.text) {
            notifyText();
            textBuf += block.text;
            log.textBlock(label, block.text);
          } else if (block.type === "tool_use") {
            const name = block.name ?? "tool";
            hooks?.onToolStart?.(name);
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
