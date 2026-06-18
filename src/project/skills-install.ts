import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { BOT_ROOT } from "../config/paths.js";
import { log } from "../config/logger.js";

const INSTALL_SCRIPT = resolve(BOT_ROOT, "scripts", "install-project-skills.mjs");

export function installProjectSkills(projectRoot: string): void {
  log.startup(`install-project-skills  root=${projectRoot}`);
  execFileSync("node", [INSTALL_SCRIPT, projectRoot, BOT_ROOT], {
    stdio: "inherit",
    timeout: 30_000,
  });
}
