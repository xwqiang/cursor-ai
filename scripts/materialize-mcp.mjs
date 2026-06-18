#!/usr/bin/env node
/**
 * Merge global + project mcp.json and materialize paths for PROJECT_ROOT.
 * Project-agnostic: no repo-specific server names or venv layout.
 *
 * Usage: node materialize-mcp.mjs <PROJECT_ROOT> <globalMcp.json> <projectMcp.json> <out.json>
 */
import fs from "node:fs";
import path from "node:path";

const [root, globalPath, projectPath, outPath] = process.argv.slice(2);
if (!root || !outPath) {
  console.error("usage: materialize-mcp.mjs <PROJECT_ROOT> <global.json> <project.json> <out.json>");
  process.exit(1);
}

const PLACEHOLDER_TOKENS = ["${PROJECT_ROOT}", "${projectRoot}", "${workspaceFolder}"];

function expandString(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const token of PLACEHOLDER_TOKENS) {
    out = out.split(token).join(root);
  }
  return out;
}

function deepExpand(value) {
  if (typeof value === "string") return expandString(value);
  if (Array.isArray(value)) return value.map(deepExpand);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepExpand(v);
    }
    return out;
  }
  return value;
}

/** Relative filesystem command (e.g. .venv/bin/python); not PATH lookups like npx or gitnexus. */
function resolveRelativeCommand(command, projectRoot) {
  if (typeof command !== "string" || !command.includes("/") || path.isAbsolute(command)) {
    return command;
  }
  return path.join(projectRoot, command);
}

function loadMcpServers(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
  } catch {
    return {};
  }
}

function materializeEntry(entry) {
  const out = deepExpand(entry);
  if (out.command) {
    out.command = resolveRelativeCommand(out.command, root);
  }
  return out;
}

const merged = { ...loadMcpServers(globalPath), ...loadMcpServers(projectPath) };
const mcpServers = {};
for (const [name, entry] of Object.entries(merged)) {
  mcpServers[name] = materializeEntry(entry);
}

fs.writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2));
const names = Object.keys(mcpServers);
console.log(`  mcp: ${names.length} servers [${names.join(", ")}]`);
