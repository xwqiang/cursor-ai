import type { McpServerConfig } from "@cursor/sdk";
import type { McpServerEntry } from "./types.js";

/** SDK 子进程常不加载 login shell，需显式 PATH 才能找到 npx/node。 */
const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

const ENV_PLACEHOLDER = /^\$\{env:([^}]+)\}$/;

function resolveEnvString(value: string): string {
  const m = value.match(ENV_PLACEHOLDER);
  if (!m) return value;
  return process.env[m[1]!]?.trim() ?? value;
}

function resolveEntryEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = resolveEnvString(v);
  }
  return out;
}

/** 将 mcp.json 条目转为 Cursor SDK 的 McpServerConfig（stdio）。 */
export function toSdkMcpServers(
  servers: Record<string, McpServerEntry>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    out[name] = {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      env: {
        PATH: DEFAULT_PATH,
        ...resolveEntryEnv(entry.env),
      },
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    };
  }
  return out;
}
