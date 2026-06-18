import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { McpConfigFile, McpServerEntry } from "./types.js";

const PLACEHOLDER_TOKENS = ["${PROJECT_ROOT}", "${projectRoot}", "${workspaceFolder}"];

function expandString(value: string, projectRoot: string): string {
  let out = value;
  for (const token of PLACEHOLDER_TOKENS) {
    out = out.split(token).join(projectRoot);
  }
  return out;
}

function deepExpand<T>(value: T, projectRoot: string): T {
  if (typeof value === "string") return expandString(value, projectRoot) as T;
  if (Array.isArray(value)) return value.map((v) => deepExpand(v, projectRoot)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepExpand(v, projectRoot);
    }
    return out as T;
  }
  return value;
}

function resolveRelativeCommand(command: string, projectRoot: string): string {
  if (!command.includes("/") || isAbsolute(command)) return command;
  return join(projectRoot, command);
}

function loadMcpFromFile(path: string): Record<string, McpServerEntry> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as McpConfigFile;
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

function materializeEntry(entry: McpServerEntry, projectRoot: string): McpServerEntry {
  const out = deepExpand({ ...entry }, projectRoot);
  if (out.command) {
    out.command = resolveRelativeCommand(out.command, projectRoot);
  }
  return out;
}

/** Load MCP from <projectRoot>/.cursor/mcp.json with path materialization. */
export function loadMcpServers(projectRoot: string): Record<string, McpServerEntry> {
  const projectMcp = resolve(projectRoot, ".cursor", "mcp.json");
  const merged = loadMcpFromFile(projectMcp);

  const all: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(merged)) {
    all[name] = materializeEntry(entry, projectRoot);
  }

  process.stdout.write(
    `[mcp] loaded ${Object.keys(all).length} servers from ${projectMcp}\n`,
  );

  return all;
}
