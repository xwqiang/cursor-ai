export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type McpConfigFile = { mcpServers?: Record<string, McpServerEntry> };
