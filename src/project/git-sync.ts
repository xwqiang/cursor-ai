import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { BOT_ROOT } from "../config/paths.js";
import { log } from "../config/logger.js";
import type { GitProject } from "./types.js";

const REPOS_DIR = resolve(BOT_ROOT, "data", "repos");

export function repoDir(projectId: string): string {
  return resolve(REPOS_DIR, projectId);
}

export function resolveGitRoot(project: GitProject): string {
  return repoDir(project.id);
}

export async function ensureCloned(project: GitProject): Promise<string> {
  const dir = repoDir(project.id);
  if (!existsSync(dir)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    log.startup(`git clone  ${project.url} → ${dir}`);
    execFileSync("git", [
      "clone",
      "--branch", project.branch,
      "--single-branch",
      "--depth", "1",
      project.url,
      dir,
    ], { stdio: "inherit", timeout: 120_000 });
  }
  return dir;
}

export async function pullLatest(project: GitProject): Promise<void> {
  const dir = repoDir(project.id);
  if (!existsSync(dir)) {
    await ensureCloned(project);
    return;
  }
  log.startup(`git pull  ${project.id} (${project.branch})`);
  execFileSync("git", ["-C", dir, "fetch", "origin"], { stdio: "inherit", timeout: 60_000 });
  execFileSync("git", ["-C", dir, "checkout", project.branch], { stdio: "inherit", timeout: 10_000 });
  execFileSync("git", ["-C", dir, "pull", "--ff-only"], { stdio: "inherit", timeout: 60_000 });
}
