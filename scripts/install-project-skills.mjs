#!/usr/bin/env node
/**
 * Install bot-bundled skills into a target project.
 * Usage: node install-project-skills.mjs <PROJECT_ROOT> [BOT_ROOT]
 */
import fs from "node:fs";
import path from "node:path";

const [projectRoot, botRootArg] = process.argv.slice(2);
if (!projectRoot) {
  console.error("usage: install-project-skills.mjs <PROJECT_ROOT> [BOT_ROOT]");
  process.exit(1);
}

const BOT_ROOT = botRootArg || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const botSkills = path.join(BOT_ROOT, ".cursor", "skills");
if (!fs.existsSync(botSkills)) {
  process.exit(0);
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirRecursive(botSkills, path.join(projectRoot, ".cursor", "skills"));
console.log("  project skills: installed from cursor-tg-bot (.cursor/skills/)");
