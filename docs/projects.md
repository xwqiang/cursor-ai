# 多项目管理

Bot 支持同时管理多个项目，不同 Telegram 群可绑定不同项目。

## 快速配置

### Git 远程项目（推荐，服务器部署）

在 `.env` 设置 `PROJECT_GIT_URL`，首次 `./start.sh` 会自动 clone 到 `data/repos/<id>/` 并生成 `data/projects.json`：

```bash
cp .env.example .env
# PROJECT_GIT_URL=git@github.com:org/my-app.git
# PROJECT_GIT_BRANCH=main
./start.sh
```

宿主机需已配置 Git 凭据（SSH key 或 HTTPS credential helper）。

### 本地目录（开发机）

若本机已有 checkout，设置 `PROJECT_ROOT` 即可：

```bash
cp .env.example .env
# PROJECT_ROOT=/path/to/your/project
./start.sh
```

### 多项目

参考模板复制后编辑：

```bash
cp data/projects.json.example data/projects.json
# git 项目填写 url / branch；local 项目填写本机绝对 path
./start.sh
```

群与项目的绑定**不要手改文件**：在 Telegram 里发 `/projects` 点选即可，Bot 会自动写入 `data/chat-projects.json`。未绑定的群使用 `defaultProjectId`。

## 数据文件

| 文件 | 说明 |
|------|------|
| `data/projects.json.example` | 项目注册表模板（复制为 `projects.json`） |
| `data/projects.json` | 项目注册表（运行时，gitignore） |
| `data/chat-projects.json` | 群→项目绑定（Bot 自动维护，gitignore） |
| `data/repos/<id>/` | Git 项目克隆目录 |

以上文件均在 `.gitignore` 中，不会提交到仓库。

## projects.json 格式

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "my-app",
      "kind": "local",
      "path": "/path/to/my-app"
    },
    {
      "id": "api-service",
      "name": "api-service",
      "kind": "git",
      "url": "git@github.com:org/api.git",
      "branch": "main",
      "mcpServers": ["mysql", "ssh-mcp"]
    }
  ],
  "defaultProjectId": "my-app"
}
```

| 字段 | 说明 |
|------|------|
| `id` | 稳定标识，同时用作 cache slug 和 `data/repos/<id>/` 目录名 |
| `kind` | `local`（本地路径）或 `git`（远程仓库） |
| `mcpServers` | 可选；限定该项目加载的 MCP server 名（不设则加载 mcp.json 全部） |
| `defaultProjectId` | 未选项目的群默认使用此项目 |

## 项目操作

### 通过 Bot 命令

```
/projects                         — 查看项目列表（inline 按钮切换）
/project use <id>                 — 切换当前群的项目
/project add local /path/to/dir   — 注册本地项目（admin）
/project add git <url> [branch]   — 注册 Git 项目（admin）
/project remove <id>              — 删除项目注册（admin，不删文件）
/project sync <id>                — 强制 Git pull + 缓存重建（admin）
```

### 手动编辑

直接编辑 `data/projects.json` 后重启 Bot。

## Git 仓库

### 认证

Bot 依赖宿主机已有的 Git 凭据：

- **SSH**：`git@github.com:...` + `ssh-agent` 或 `~/.ssh/`
- **HTTPS**：系统 `credential.helper` 或环境变量

Bot 不存储密钥或 token。

### 同步流程

1. 注册 Git 项目时不会立即 clone
2. 首次 `use` 或首次 Agent 调用时触发 `git clone --single-branch --depth 1`
3. 每次激活项目会 `git fetch && git pull --ff-only`
4. `--ff-only` 失败（有冲突）时向群返回错误，需人工到 `data/repos/<id>/` 处理后 `/project sync`

### 项目配置

MCP、rules、skills、commands 均从项目目录 `<projectRoot>/.cursor/` 读取。每个项目应维护各自的 `.cursor/mcp.json`（可提交到 Git 仓库）。

`/project sync` 对 Git 项目执行 pull，并安装 bot 内置 skills 到项目。

## 多群场景

- 群 A → `my-app`：问答和定时任务都在 my-app 项目上下文
- 群 B → `api-service`：独立的上下文
- 切换项目后会话自动重置（`/new` 效果）
- 定时任务在创建时绑定当前群的项目，之后不随群切换变化
