import { basename, resolve } from "node:path";
import { loadMcpServers } from "../mcp/loader.js";
import type { McpServerEntry } from "../mcp/types.js";
import { ChatBinding } from "./chat-binding.js";
import { ensureCloned, pullLatest, resolveGitRoot } from "./git-sync.js";
import { ProjectRegistry } from "./registry.js";
import { installProjectSkills } from "./skills-install.js";
import type { GitProject, LocalProject, Project, ProjectContext } from "./types.js";

export class ProjectManager {
  private readonly registry: ProjectRegistry;
  private readonly binding: ChatBinding;
  private readonly readyProjects = new Set<string>();

  constructor(projectRoot: string) {
    this.registry = new ProjectRegistry();
    this.registry.initDefault(projectRoot);
    this.binding = new ChatBinding();
    this.readyProjects.add(this.registry.defaultProjectId);
  }

  get defaultProjectId(): string {
    return this.registry.defaultProjectId;
  }

  listProjects(): Project[] {
    return this.registry.list();
  }

  getProject(id: string): Project | undefined {
    return this.registry.get(id);
  }

  getProjectIdForChat(chatId: string): string {
    return this.binding.get(chatId) ?? this.registry.defaultProjectId;
  }

  bindChat(chatId: string, projectId: string): void {
    const project = this.registry.get(projectId);
    if (!project) throw new Error(`项目 "${projectId}" 不存在`);
    this.binding.set(chatId, projectId);
  }

  addLocal(path: string, id?: string, name?: string): Project {
    const projId = id ?? basename(path);
    const project: LocalProject = {
      id: projId,
      name: name ?? projId,
      kind: "local",
      path,
    };
    this.registry.add(project);
    return project;
  }

  addGit(url: string, branch = "main", id?: string, name?: string): Project {
    const slug = id ?? url.replace(/.*\//, "").replace(/\.git$/, "");
    const project: GitProject = {
      id: slug,
      name: name ?? slug,
      kind: "git",
      url,
      branch,
    };
    this.registry.add(project);
    return project;
  }

  removeProject(id: string): boolean {
    return this.registry.remove(id);
  }

  resolveRoot(project: Project): string {
    if (project.kind === "local") return project.path;
    return resolveGitRoot(project);
  }

  async ensureReady(project: Project): Promise<string> {
    if (project.kind === "git") {
      await ensureCloned(project);
    }
    const root = this.resolveRoot(project);
    if (!this.readyProjects.has(project.id)) {
      installProjectSkills(root);
      this.readyProjects.add(project.id);
    }
    return root;
  }

  async syncProject(project: Project): Promise<void> {
    if (project.kind === "git") {
      await pullLatest(project);
    }
    installProjectSkills(this.resolveRoot(project));
    this.readyProjects.add(project.id);
  }

  async getContext(chatId: string): Promise<ProjectContext> {
    return this.getContextByProjectId(this.getProjectIdForChat(chatId));
  }

  async getContextByProjectId(projectId: string): Promise<ProjectContext> {
    const project = this.registry.get(projectId);
    if (!project) {
      throw new Error(`项目 "${projectId}" 未注册（可能已被删除）`);
    }
    const root = await this.ensureReady(project);
    const mcpServers = this.loadProjectMcp(project, root);
    return {
      id: project.id,
      name: project.name,
      root,
      mcpServers,
    };
  }

  private loadProjectMcp(
    project: Project,
    root: string,
  ): Record<string, McpServerEntry> {
    const all = loadMcpServers(root);
    if (!project.mcpServers || project.mcpServers.length === 0) return all;
    const filtered: Record<string, McpServerEntry> = {};
    for (const name of project.mcpServers) {
      if (all[name]) filtered[name] = all[name];
    }
    return filtered;
  }
}
