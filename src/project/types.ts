import type { McpServerEntry } from "../mcp/types.js";

export interface LocalProject {
  id: string;
  name: string;
  kind: "local";
  path: string;
  mcpServers?: string[];
}

export interface GitProject {
  id: string;
  name: string;
  kind: "git";
  url: string;
  branch: string;
  mcpServers?: string[];
}

export type Project = LocalProject | GitProject;

export interface ProjectsConfig {
  projects: Project[];
  defaultProjectId: string;
}

export interface ProjectContext {
  id: string;
  name: string;
  root: string;
  mcpServers: Record<string, McpServerEntry>;
}
