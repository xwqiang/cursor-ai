import { CursorAgentError } from "@cursor/sdk";
import { log } from "../config/logger.js";

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause =
    err.cause instanceof Error
      ? err.cause.message
      : err.cause != null
        ? String(err.cause)
        : "";
  return `${err.name} ${err.message} ${cause}`;
}

/** ConnectRPC / HTTP2 network failures from Cursor SDK background streams. */
export function isConnectNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ConnectError") return true;
  return /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH)\b/.test(
    errorText(err),
  );
}

export function formatAgentError(err: unknown): string {
  if (err instanceof CursorAgentError) {
    return `Cursor SDK 错误: ${err.message}`;
  }
  if (isConnectNetworkError(err)) {
    const detail = err instanceof Error ? err.message : String(err);
    return (
      "无法连接 Cursor 云端 API（网络超时或连接中断）。\n" +
      "请检查服务器能否访问 Cursor API，必要时配置 HTTPS_PROXY。\n" +
      `详情: ${detail}`
    );
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prevent ConnectRPC idle-stream ETIMEDOUT / ECONNRESET from crashing the process.
 * The SDK may emit these on background HTTP/2 reads outside the main ask() flow.
 */
export function installConnectErrorGuard(): void {
  process.on("unhandledRejection", (reason) => {
    if (!isConnectNetworkError(reason)) return;
    log.warn(`ConnectRPC 后台连接异常（已忽略）: ${errorText(reason)}`);
  });

  process.on("uncaughtException", (err) => {
    if (isConnectNetworkError(err)) {
      log.warn(`ConnectRPC 未捕获异常（已忽略）: ${errorText(err)}`);
      return;
    }
    log.error(`未捕获异常，进程退出: ${errorText(err)}`);
    process.exit(1);
  });
}
