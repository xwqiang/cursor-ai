import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { BOT_ROOT } from "../config/paths.js";
import type { GitProject, Project, ProjectsConfig } from "./types.js";

function slugFromGitUrl(url: string): string {
  return url.replace(/.*\//, "").replace(/\.git$/, "");
}

const DATA_DIR = resolve(BOT_ROOT, "data");
const PROJECTS_PATH = resolve(DATA_DIR, "projects.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function read(): ProjectsConfig {
  if (!existsSync(PROJECTS_PATH)) {
    return { projects: [], defaultProjectId: "" };
  }
  return JSON.parse(readFileSync(PROJECTS_PATH, "utf-8")) as ProjectsConfig;
}

function write(config: ProjectsConfig): void {
  ensureDataDir();
  writeFileSync(PROJECTS_PATH, JSON.stringify(config, null, 2));
}

export class ProjectRegistry {
  private config: ProjectsConfig;

  constructor() {
    this.config = read();
  }

  /** Initialize from env if no projects.json exists yet. Git URL takes priority over local path. */
  initDefaultFromEnv(): void {
    if (this.config.projects.length > 0) return;

    const gitUrl = process.env.PROJECT_GIT_URL?.trim();
    if (gitUrl) {
      const branch = process.env.PROJECT_GIT_BRANCH?.trim() || "main";
      const id = process.env.PROJECT_ID?.trim() || slugFromGitUrl(gitUrl);
      const name = process.env.PROJECT_NAME?.trim() || id;
      const project: GitProject = { id, name, kind: "git", url: gitUrl, branch };
      this.config = { projects: [project], defaultProjectId: id };
      write(this.config);
      return;
    }

    const localRoot = process.env.PROJECT_ROOT?.trim();
    if (localRoot) {
      const id = process.env.PROJECT_ID?.trim() || basename(localRoot);
      const name = process.env.PROJECT_NAME?.trim() || id;
      this.config = {
        projects: [{
          id,
          name,
          kind: "local",
          path: localRoot,
        }],
        defaultProjectId: id,
      };
      write(this.config);
    }
  }

  hasProjects(): boolean {
    return this.config.projects.length > 0 && Boolean(this.config.defaultProjectId);
  }

  get defaultProjectId(): string {
    return this.config.defaultProjectId;
  }

  list(): Project[] {
    return [...this.config.projects];
  }

  get(id: string): Project | undefined {
    return this.config.projects.find((p) => p.id === id);
  }

  add(project: Project): void {
    if (this.config.projects.some((p) => p.id === project.id)) {
      throw new Error(`项目 ID "${project.id}" 已存在`);
    }
    this.config.projects.push(project);
    write(this.config);
  }

  remove(id: string): boolean {
    if (id === this.config.defaultProjectId) {
      throw new Error("不能删除默认项目");
    }
    const idx = this.config.projects.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.config.projects.splice(idx, 1);
    write(this.config);
    return true;
  }
}
