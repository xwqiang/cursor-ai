# cursor-tg-bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 Telegram 群里运行的 AI 助手：基于 [Cursor SDK](https://cursor.com/docs) 与 [MCP](https://modelcontextprotocol.io/)，让群成员用自然语言查询代码、执行命令、（管理员）修改代码并生成 diff review。支持**多项目切换**（本地目录或远程 Git 仓库）和按群配置的**每日定时任务**。

> 仓库名 `cursor-ai`，npm 包名 `cursor-tg-bot`。

---

## 特性

- **群内问答**：多轮会话、引用消息上下文、`/advanced` 高级模型单轮推理
- **MCP 工具链**：从目标项目的 `.cursor/mcp.json` 加载，可接 MySQL、SSH、Redis、浏览器等任意 MCP server
- **多项目管理**：每个 Telegram 群可绑定不同项目，支持 `local` 与 `git` 两种来源
- **定时任务**：自然语言创建每日 cron 任务，到点自动执行 Agent 并推送结果
- **权限分级**：普通成员只读；`TG_ADMIN_IDS` 管理员可改代码，自动生成 HTML diff review 附件
- **零 IDE 依赖**：Bot 进程自行拉起 MCP 子进程，不依赖 Cursor IDE 是否打开

---

## 快速开始

### 前置条件

- Node.js 20+
- [Cursor API Key](https://cursor.com/settings)
- Telegram Bot Token（[BotFather](https://t.me/BotFather) 创建）
- 一个要托管的目标项目目录（含 `.cursor/mcp.json` 可选）

### 安装与配置

```bash
git clone git@github.com:xwqiang/cursor-ai.git
cd cursor-ai
npm install
cp .env.example .env
# 编辑 .env：填入 CURSOR_API_KEY、TELEGRAM_BOT_TOKEN、PROJECT_ROOT
```

### 启动

```bash
./start.sh --project /path/to/your/project
```

或在 `.env` 中设置 `PROJECT_ROOT` 后直接：

```bash
./start.sh
```

`start.sh` 会将内置 skills 安装到目标项目，再以目标项目为工作目录启动 Bot。MCP、rules 均从目标项目 `.cursor/` 目录读取。

> **BotFather**：需关闭隐私模式（`/setprivacy` → Disable），否则收不到群内消息。

---

## 群内用法

### 问答（多轮会话）

Bot 直接响应群内所有消息。

| 操作 | 说明 |
|------|------|
| 直接发消息 | 普通提问，使用默认模型（`CURSOR_MODEL`），同群共享多轮上下文 |
| 引用消息后提问 | 将被引用内容作为上下文一并传给 AI |
| `/new` | 清空当前群默认会话与高级会话的上下文 |
| `/advanced <问题>` | 使用高级模型（`CURSOR_ADVANCED_MODEL`）单轮问答，适合复杂推理 |

### 定时任务

按群创建每日自动执行的 Agent 任务，到点将结果推送到对应群组。

| 命令 | 说明 |
|------|------|
| `/task <描述>` | 用自然语言创建任务（AI 解析时间/标题/执行内容，弹出草稿确认） |
| `/task 09:00 <描述>` | 指定每日 `HH:mm`，跳过确认直接创建 |
| `/tasks` | 查看本群任务列表（可点按钮取消） |
| `/taskinfo <id>` | 查看任务详情 |
| `/deltask <id>` | 删除任务 |
| `/runtask <id>` | 立即执行一次（结果仍发到任务所属群） |
| `/alltasks` | 查看所有群任务（仅 `TG_ADMIN_IDS` 管理员） |

**创建流程（自然语言路径）**

1. 发送 `/task 每天上午检查昨日错误日志`
2. Bot 展示**任务草稿**（标题、时间、执行描述），可点「确认创建 / 调整描述 / 取消」，或切换「高级模型」
3. 点「调整描述」后，**回复草稿消息**说明要改的地方（支持多轮，复用同一解析 Agent）
4. 确认后任务写入 `data/tasks.db`，进程重启后自动恢复调度

单次执行超时 15 分钟，失败自动重试 1 次；执行结果以「定时汇报」消息发到任务所在群。

### 多项目管理

每个群可绑定不同项目，切换后会话自动重置。支持本地项目和远程 Git 仓库。

| 命令 | 权限 | 说明 |
|------|------|------|
| `/projects` | 全员 | 查看项目列表（inline 按钮，点击切换） |
| `/project use <id>` | 全员 | 切换当前群绑定的项目 |
| `/project add local <path>` | admin | 注册本地项目 |
| `/project add git <url> [branch]` | admin | 注册 Git 仓库（默认 `main` 分支） |
| `/project remove <id>` | admin | 删除项目注册（不删文件） |
| `/project sync <id>` | admin | 强制 Git pull + 缓存重建 |

项目配置存储在 `data/projects.json`（首次启动自动生成），群绑定存储在 `data/chat-projects.json`。详见 [docs/projects.md](docs/projects.md)。

---

## 架构

```
群内消息
  │
  ├── /task、/tasks、/new、/projects … ──→ 对应命令处理
  │
  └── 普通文本消息
        │
        ├── ProjectManager 按群解析项目上下文（cwd + MCP）
        │
        ├── SessionManager 多轮会话
        │     · 默认 / 高级各一套，按 chatId 隔离
        │     · 空闲 30 分钟或累计 30 轮后重建
        │     · 切换项目后自动重置
        │
        └── Cursor Agent（+ MCP）→ 回复

定时调度（TaskScheduler）
  │
  ├── 启动时从 data/tasks.db 加载任务
  ├── 每个任务关联 project_id
  ├── croner 按 cron 每日触发
  └── 按任务项目解析上下文 → Agent 执行 → 推送 HTML 到目标群
```

Bot 加入的所有群均可使用；每个群的会话与定时任务互不干扰。

### AI 能力

回答时 AI 可通过本地工具链 + MCP 工具获取真实数据：

| 能力 | 说明 |
|------|------|
| 读代码 | `Read` / `Grep` / `Glob` 检索项目源码、README、配置 |
| 执行命令 | Shell 命令（`git`、`npm`、`curl` 等） |
| 改代码 | `Write` / `StrReplace`（仅 **admin** 权限，自动创建新分支 + HTML diff review 附件） |
| MCP 扩展 | 在目标项目 `.cursor/mcp.json` 中配置任意 MCP server（数据库、SSH、Redis、浏览器等） |

MCP 从目标项目 `.cursor/mcp.json` 加载（支持 `${PROJECT_ROOT}` 路径展开）。详见 [docs/mcp-setup.md](docs/mcp-setup.md)。

### admin 与 viewer 权限

每条提问会附带权限标注传给 AI：

- **viewer**（默认）：只读，可查询、问答；请求改代码时 AI 会礼貌拒绝
- **admin**（`TG_ADMIN_IDS` 中的用户）：可改代码；AI 会自动新建分支、提交，并按仓库内自带的 `pr-review-canvas` 技能（`.cursor/skills/pr-review-canvas/`，`start.sh` 会同步到目标项目）整理 diff，生成自包含 HTML（`.cursor-tg-bot/code-review.html`）后以**文件附件**发到群里，同时在文字回复中说明改了什么

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `CURSOR_API_KEY` | ✅ | — | Cursor SDK API Key |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot Token（BotFather 获取） |
| `PROJECT_ROOT` | ✅ | — | 目标项目根目录（或启动时 `--project` 指定） |
| `PROJECT_NAME` | ❌ | 目录名 | 项目名称，注入系统提示 |
| `TG_ADMIN_IDS` | ❌ | — | 管理员 Telegram 用户 ID（逗号分隔）；admin 可改代码、`/alltasks` |
| `CURSOR_MODEL` | ❌ | `auto` | 默认 AI 模型（问答与任务解析） |
| `CURSOR_ADVANCED_MODEL` | ❌ | `claude-opus-4-6` | 高级模型（`/advanced` 与任务草稿中的高级选项） |
| `TG_DEBUG` | ❌ | `true` | 打印收发日志 |
| `TG_MCP_HINTS` | ❌ | 内置默认 | MCP 使用提示（JSON 格式，注入系统提示） |
| `TG_MCP_STARTUP_PROBE` | ❌ | `true` | 启动时粗测各 MCP 子进程能否拉起 |
| `MCP_CONFIG_PATH` | ❌ | `~/.cursor/mcp.json` | MCP 配置文件路径（仅作参考，Bot 以项目 mcp.json 为准） |

完整示例见 [.env.example](.env.example)。

---

## 内置 Skills

`pr-review-canvas` 以**项目 Skill** 形式随仓库提供：`.cursor/skills/pr-review-canvas/SKILL.md`。

`start.sh` 启动时会把该目录复制到**目标项目** `PROJECT_ROOT/.cursor/skills/`（供 Cursor SDK `settingSources: ["project"]` 下的 Agent `Read`）。

因此换机器、新环境只要拉取本仓库并 `npm install`，不必再在本机安装同名 skill。

> **Skill vs Plugin**：Cursor **Skill** 是仓库里的 `SKILL.md` 指令包；**Plugin** 是 Cursor 市场/扩展的另一套机制。本 Bot 用的是 Skill，不是 Plugin。

---

## 目录结构

```text
├── .cursor/skills/pr-review-canvas/  # 内置 diff review 技能（随 start.sh 安装到目标项目）
├── start.sh                            # 入口：同步配置 + 启动 Bot
├── scripts/
│   ├── install-project-skills.mjs      # 安装内置 skills 到目标项目
│   ├── materialize-mcp.mjs             # 离线工具：合并/展开 mcp.json（可选）
│   └── stop_bot.sh                     # 按 PID 停止 Bot
├── data/                               # 运行时数据（gitignore，首次启动自动创建）
│   ├── tasks.db                        # 定时任务持久化（SQLite）
│   ├── projects.json                   # 项目注册表
│   ├── chat-projects.json              # 群→项目绑定
│   └── repos/                          # Git 项目克隆目录
├── docs/
│   ├── mcp-setup.md                    # MCP 配置说明
│   └── projects.md                     # 多项目管理说明
└── src/
    ├── main.ts                         # 进程入口
    ├── bot.ts                          # Telegraf：问答、命令、项目切换、定时任务
    ├── config/                         # 路径解析、env、日志
    ├── bot/                            # 单实例锁、409 判断
    ├── mcp/                            # MCP 配置加载、合并、探针
    ├── project/                        # 多项目管理：registry、git-sync、skills-install
    ├── prompt/                         # 系统提示与用户消息构造
    ├── telegram/                       # HTML 回复、getMe
    ├── agent/                          # Cursor SDK 会话管理与流式日志
    └── scheduler/                      # 定时任务：解析、草稿、调度、SQLite 存储
```

---

## 故障排查

### Telegram 409 Conflict

报错 `terminated by other getUpdates request` 表示同一 Bot Token 有两个进程在轮询（常见：锁屏唤醒后重启，旧进程仍在）。

```bash
./scripts/stop_bot.sh          # 按 .run/cursor-tg-bot.pid 停止旧进程
./start.sh --project ...       # 再启动
```

手动排查：

```bash
ps aux | grep cursor-tg-bot
pgrep -fl "tsx.*main"
```

确认没有在其他终端或机器用同一 `TELEGRAM_BOT_TOKEN` 运行 Bot。

### Bot 无响应

1. 确认 Bot 已加入目标群，且已关闭隐私模式。
2. 查看 Bot 进程日志，确认 `[startup]` 行正常输出（含 `scheduler: N task(s) loaded`）。
3. 发送 `你好` 查看 `[recv]` 是否打印（`TG_DEBUG=true` 时）。
4. 确认 `CURSOR_API_KEY` 有效且未过期。

### MCP 工具不可用

参考 [docs/mcp-setup.md](docs/mcp-setup.md)，确认 MCP 子进程能正常启动。启动时默认会自动探测，若需关闭可设 `TG_MCP_STARTUP_PROBE=false`。

### 定时任务未执行

1. 用 `/tasks` 确认任务仍在列表中。
2. 查看启动日志中 `scheduler: task=… next_in=…min` 是否正常。
3. 用 `/runtask <id>` 手动触发，确认 Agent 与 MCP 可用。
4. 检查本机时间与进程是否持续运行。

---

## 许可证

[MIT](LICENSE)
