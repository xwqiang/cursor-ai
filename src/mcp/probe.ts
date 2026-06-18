import { spawn } from "node:child_process";
import type { McpServerConfig } from "@cursor/sdk";
import { log } from "../config/logger.js";

const PROBE_MS = 6_000;

function probeOne(name: string, cfg: McpServerConfig): Promise<{ name: string; ok: boolean; detail: string }> {
  if (cfg.type && cfg.type !== "stdio") {
    return Promise.resolve({ name, ok: true, detail: `skip non-stdio (${cfg.type})` });
  }
  if (!("command" in cfg)) {
    return Promise.resolve({ name, ok: false, detail: "missing command" });
  }

  return new Promise((resolve) => {
    const child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...cfg.env },
      cwd: "cwd" in cfg && cfg.cwd ? cfg.cwd : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      const alive = child.exitCode === null && child.signalCode === null;
      if (alive) {
        child.kill("SIGTERM");
        resolve({ name, ok: true, detail: "process stayed up (stdio server likely ok)" });
      } else {
        resolve({
          name,
          ok: false,
          detail: stderr.trim().slice(0, 200) || `exited code=${child.exitCode}`,
        });
      }
    }, PROBE_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ name, ok: false, detail: err.message });
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        resolve({
          name,
          ok: false,
          detail: stderr.trim().slice(0, 200) || `exit ${code}`,
        });
      }
    });
  });
}

/** 启动时粗测 MCP 子进程能否拉起（非 MySQL 连通性测试）。 */
export async function probeMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const names = Object.keys(servers);
  if (names.length === 0) return;

  log.probeStart(names.length);
  const results = await Promise.all(
    names.map((name) => probeOne(name, servers[name]!)),
  );
  for (const r of results) {
    log.probe(r.ok, r.name, r.detail);
  }
}
