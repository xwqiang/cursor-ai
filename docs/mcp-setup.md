# MCP 配置说明

## Cursor IDE 与 Telegram Bot 是两套 MCP

| | Cursor IDE | Telegram Bot (`cursor-tg-bot`) |
|---|------------|--------------------------------|
| 配置来源 | `~/.cursor/mcp.json` + 可选 `<PROJECT_ROOT>/.cursor/mcp.json` | 项目 `<PROJECT_ROOT>/.cursor/mcp.json`（全部加载） |
| 谁拉起子进程 | IDE 内置 MCP 宿主 | **Cursor SDK** `Agent.create({ mcpServers })` |
| 项目根目录 | 工作区路径 / `${workspaceFolder}`（仅 IDE） | 当前激活项目的根目录 |

Bot **不绑定某个业务仓库**：`PROJECT_ROOT` 指向哪套代码，就对哪套加载 MCP。各项目的 server 定义在各自的 `.cursor/mcp.json` 里。

## Bot 加载与占位符

`src/mcp/loader.ts` 读取项目 `.cursor/mcp.json` 时：

1. 将字符串中的 **`${PROJECT_ROOT}`**、**`${projectRoot}`**、**`${workspaceFolder}`** 替换为当前项目根目录
2. 若 **`command` 为相对路径**（含 `/` 且非绝对路径，如 `.venv/bin/python`），解析为 `$PROJECT_ROOT/...`
3. **不**按服务名或模块名注入任何项目专属字段

各项目若需 Python 包 `scripts.*`，请在**该项目**的 `.cursor/mcp.json` 里自行写例如：

```json
"env": { "PYTHONPATH": "${PROJECT_ROOT}" },
"cwd": "${PROJECT_ROOT}"
```

传给 SDK 时另见 `src/mcp/normalize.ts`（补 `PATH` 等）。启动前粗测：

```bash
TG_MCP_STARTUP_PROBE=true ./start.sh
```

## 常见本机修复

| 类型 | 说明 |
|------|------|
| `npx` / `node` | SDK 子进程常无 login shell，需 `PATH` 含 Homebrew（`normalize.ts` 默认补一段） |
| 相对路径 `command` | Bot 合并后变为 `$PROJECT_ROOT/...`；IDE 需绝对路径或 IDE 支持的变量 |
| `${workspaceFolder}` | **仅 Cursor IDE** 展开；Bot 请用 **`${PROJECT_ROOT}`** |

## 示例 mcp.json

在目标项目根目录创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"]
    },
    "redis": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-redis"],
      "env": {
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

Python 类 MCP 可使用项目内虚拟环境：

```json
{
  "mcpServers": {
    "my-tool": {
      "command": ".venv/bin/python",
      "args": ["-m", "my_mcp_server"],
      "cwd": "${PROJECT_ROOT}",
      "env": { "PYTHONPATH": "${PROJECT_ROOT}" }
    }
  }
}
```

## 生效方式

1. 修改目标项目 `<PROJECT_ROOT>/.cursor/mcp.json` 后重启 Bot，看 `[mcp] loaded N servers from ...` 与 `[startup] mcp_servers=[...]`。
2. Cursor IDE：**Settings → MCP → Restart**。
3. 可选：`data/projects.json` 中项目的 `mcpServers` 字段进一步限定加载范围。

## 按项目限定 MCP（可选）

在 `data/projects.json` 为某个项目设置 `mcpServers` 数组，只加载列出的 server 名：

```json
{
  "id": "api-service",
  "kind": "git",
  "mcpServers": ["ssh-mcp", "redis"]
}
```

不设则加载该项目 `.cursor/mcp.json` 中的全部 server。
