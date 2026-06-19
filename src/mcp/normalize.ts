import type { McpServerConfig } from "@cursor/sdk";
import type { McpServerEntry } from "./types.js";

/** SDK 子进程常不加载 login shell，需显式 PATH 才能找到 npx/node。 */
function defaultMcpPath(): string {
  const extra = process.env.TG_MCP_PATH?.trim();
  const base = process.env.PATH?.trim() || "/usr/local/bin:/usr/bin:/bin";
  if (!extra) return base;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of [...extra.split(":"), ...base.split(":")]) {
    if (segment && !seen.has(segment)) {
      seen.add(segment);
      out.push(segment);
    }
  }
  return out.join(":");
}

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
        PATH: defaultMcpPath(),
        ...resolveEntryEnv(entry.env),
      },
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    };
  }
  return out;
}
