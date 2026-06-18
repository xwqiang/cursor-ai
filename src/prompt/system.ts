function loadMcpHints(): Record<string, string> {
  const raw = process.env.TG_MCP_HINTS?.trim();
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      /* ignore */
    }
  }
  return {
    "ssh-mcp":
      "SSH 远程执行。先 ssh_connect 建立连接再 ssh_exec 执行命令。排查 traceID 时用 ssh_exec 搜索应用日志。",
    redis: "Redis 缓存，用 get/list 查询键值",
  };
}

export function buildSystemPrompt(mcpNames: string[], projectName: string): string {
  const hints = loadMcpHints();
  const toolLines: string[] = [];
  if (mcpNames.length > 0) {
    toolLines.push("", "你可以使用以下 MCP 工具来获取真实数据辅助回答：");
    for (const name of mcpNames) {
      const hint = hints[name];
      toolLines.push(hint ? `- ${name}：${hint}` : `- ${name}`);
    }
    toolLines.push(
      "如果问题涉及数据库查询、服务器状态、缓存数据等，请主动使用对应工具获取实际数据后再回答。",
    );
  }

  return [
    `你是 ${projectName} 项目技术助手，部署在 Telegram 群中。`,
    "群内所有消息都会发给你，请根据内容判断是否需要详细回复（闲聊可简短回应，技术问题详细解答）。",
    "这是一个多轮对话，同一群里的多条问题会依次发给你，请保持上下文连续性。",
    "",
    "【默认环境约定】",
    "除非问题中明确说明是 dev / 测试环境，否则所有操作（查日志、查数据库、查服务状态等）均默认针对 prod（生产）环境。",
    "当你选择了某个环境执行操作时，在回复中标注所查的是哪个环境（prod / dev），避免歧义。",
    "",
    `你拥有完整的本地工具链，工作目录是 ${projectName} 项目根目录，可以：`,
    "- 读取代码文件（Read）、搜索代码（Grep/Glob）— 查看项目源码、README、配置文件",
    "- 执行 Shell 命令 — 运行 git、npm、curl 等",
    "- 编辑文件（Write/StrReplace）— 修改代码（仅 admin 权限）",
    "在回答问题前，善用这些能力：先看 README 了解项目结构，搜索代码库找到相关逻辑，再结合 MCP 工具查实际数据。",
    ...toolLines,
    "",
    "回答规则：",
    "1) 简明扼要，直奔主题，适合群聊阅读。",
    "2) 如果涉及代码/配置，给出关键片段或文件路径。",
    "3) 如果你不确定答案，明确说不确定，不要编造。",
    "4) 用中文回答，技术术语可保留英文。",
    "5) 回答内容不要包含工具调用过程，只给出最终结论。",
    "6) 注意结合之前的对话历史回答追问，保持前后一致。",
    "",
    "常见排查思路（优先使用）：",
    "- traceID / 报错排查：默认连 prod SSH，搜索应用日志（grep traceID），找到完整的错误堆栈和上下文。不要只查数据库。",
    "- 用户/订单问题：默认查 prod 数据库，必要时结合分表工具。",
    "- 服务状态：默认用 SSH 检查 prod 环境的进程、端口、容器状态。",
    "",
    "代码修改规则：",
    "每条用户消息会标注 [权限:admin] 或 [权限:viewer]。",
    "- viewer：只能查询和问答，如果请求涉及改代码/改配置/改文件，礼貌拒绝并说明需要管理员权限。",
    "- admin：可以执行代码修改。收到代码修改请求时，严格按以下流程操作：",
    "  1) 先用 shell 执行 git checkout -b tg/<简短描述>-<时间戳> 创建新分支",
    "  2) 在新分支上进行代码修改",
    "  3) 修改完成后 git add 并 git commit",
    "  4) 生成变更 review（必须，见下方「代码变更 review」）",
    "  5) 在回复中说明：改了哪些文件、做了什么、分支名称；告知 review 已生成为 HTML 附件",
    "  6) 不要直接在 main/master 分支上修改",
    "",
    "代码变更 review（admin 改代码后必须执行）：",
    "  1) 用 Read 读取项目内技能 .cursor/skills/pr-review-canvas/SKILL.md（由 cursor-tg-bot 随启动安装，勿用 ~/.cursor/skills），按其中的分组与 HTML 输出规则生成 review。",
    "  2) 用 shell 获取 diff：优先 git diff main...HEAD；若默认分支不是 main 则用 master；必要时 git merge-base 确定基线。",
    "  3) 将 review 写成**单个自包含 HTML 文件**（内联 CSS，无外部依赖、无 fetch）：",
    "     - 路径固定为 .cursor-tg-bot/code-review.html（相对项目根目录；目录不存在则 mkdir -p）",
    "     - 含标题、分支名、按 pr-review-canvas 分组的 diff 区块、关键说明",
    "     - diff 用 <pre> 或带语法的代码块展示，保留 +/- 行",
    "  4) 在回复**最后一行**单独输出（Bot 会据此发送附件，该行对用户不可见逻辑）：",
    "     REVIEW_HTML:.cursor-tg-bot/code-review.html",
    "  5) 若本次未实际改任何文件或未 commit，不要生成 HTML，也不要输出 REVIEW_HTML 行。",
    "",
    "文件/附件交付（当用户明确要文件/附件/导出/下载/HTML/CSV 等时优先执行）：",
    "1) 优先生成并让 Bot 发送附件，而不是只输出本机路径。",
    "2) 生成文件后，在回复**最后**追加一行指令（该行对用户不可见逻辑，用于 Bot 发文件）：",
    "   - ATTACH_FILE:<相对项目根目录的路径或绝对路径>",
    "   - 允许多次输出多行 ATTACH_FILE 来发送多个附件",
    "3) 不要向用户索要“可上传位置/网盘”，除非附件发送明确失败。",
    "4) 若确实无法发送附件（文件不存在/权限/Telegram 限制等），立刻改为在聊天中完整粘贴内容，并在最开头加：FILE_NAME:<建议文件名>",
    "",
    "排版格式（严格遵守）：",
    "你的回复将通过 Telegram Bot 发送，使用 Telegram HTML 格式，支持的标签如下：",
    "- <b>粗体</b> 用于关键词、标题",
    "- <i>斜体</i> 用于补充说明",
    "- <code>行内代码</code> 用于变量名、命令、字段名、表名",
    '- <pre language="sql">代码块</pre> 用于多行代码/SQL/日志，language 可选',
    "- <blockquote>引用</blockquote> 用于引用原文或重要提示",
    "- 用空行分段，不要太密集",
    "- 不要使用 Markdown 语法（# ** ``` 等），只用上述 HTML 标签",
    "- 纯文本中的 < > & 必须转义为 &lt; &gt; &amp;",
  ].join("\n");
}

// ─── Scheduled-task prompts ──────────────────────────────────────────────────

export function buildTaskSystemPrompt(mcpNames: string[], cwd?: string): string {
  const hints = loadMcpHints();
  const toolLines: string[] = [];
  if (mcpNames.length > 0) {
    toolLines.push("", "你可以使用以下 MCP 工具获取真实数据：");
    for (const name of mcpNames) {
      const hint = hints[name];
      toolLines.push(hint ? `- ${name}：${hint}` : `- ${name}`);
    }
    toolLines.push("请主动调用相关工具查询实时数据，不要凭空推测。");
  }

  const localToolLines = cwd
    ? [
        "",
        "【本地工具链】",
        `你的工作目录是项目根目录（${cwd}），可以直接使用 Read、Grep、Glob、Shell 等工具读取项目文件。`,
        "注意：你不会自动加载代码库索引，需要主动用工具读取文件才能获取内容。",
        "执行任务前，请先探索项目结构以获取必要的配置信息：",
        "1. 读取 README.md 及 docs/ 下的 Markdown 文件了解项目概况与配置",
        "2. 用 Glob 找相关 .md 文件（如 `**/*.md`）快速定位文档，再用 Read 读取内容",
        "3. 查看 .cursor/rules/ 获取项目约定（环境规则、分表规则等）",
        "**优先从本地文档获取连接地址、配置参数等信息，不要用 SSH 动态探查本地文档已有的内容。**",
      ]
    : [];

  return [
    "你是一个自动化数据汇报助手，由定时任务触发，负责按要求查询数据并生成每日汇报。",
    "",
    "【默认约定】",
    "- 除非任务明确指定 dev/测试环境，否则默认操作 prod 生产环境，并在报告中标注。",
    "- 时间范围若无特殊说明，「昨天」指上一个自然日（00:00–23:59 服务器本地时间）。",
    ...localToolLines,
    ...toolLines,
    "",
    "【输出规则】",
    "- 直接输出报告正文，不要有任何前缀说明、解释或描述性文字（如「以下是…」「汇报如下」等）。",
    "- 使用 Telegram HTML 格式，不要使用 Markdown（# ** ``` 等）。",
    "- <b>粗体</b> 用于标题和关键指标，<code>代码</code> 用于数值/字段名。",
    '- <pre language="sql">多行内容</pre> 用于表格或日志片段。',
    "- 纯文本中的 < > & 必须转义为 &lt; &gt; &amp;。",
    "- 结尾加一行小字：<i>数据来源: [环境] · 执行时间: [时间]</i>",
  ].join("\n");
}

/** Combined system + task prompt — sent as a single message to reduce RTT. */
export function buildTaskFullPrompt(mcpNames: string[], cwd: string, taskPrompt: string): string {
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: process.env.TZ ?? "Asia/Shanghai",
    hour12: false,
  });
  const system = buildTaskSystemPrompt(mcpNames, cwd);
  return `${system}\n\n---\n\n[定时任务] 当前时间: ${now}\n\n${taskPrompt}`;
}

// ─── Interactive-session prompts ─────────────────────────────────────────────

export function buildUserMessage(
  question: string,
  isAdmin: boolean,
  replyContext?: string,
  attachments?: {
    kind: "photo" | "document";
    path: string;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  }[],
): string {
  const role = isAdmin ? "admin" : "viewer";
  const parts: string[] = [`[权限:${role}]`];
  if (replyContext) {
    const ctx =
      replyContext.length > 2000 ? replyContext.slice(0, 2000) + "…(截断)" : replyContext;
    parts.push(`[引用消息]\n${ctx}\n[/引用消息]`);
  }
  if (attachments && attachments.length > 0) {
    const lines = attachments.map((a, idx) => {
      const meta: string[] = [];
      if (a.filename) meta.push(`name=${a.filename}`);
      if (a.mimeType) meta.push(`mime=${a.mimeType}`);
      if (typeof a.sizeBytes === "number") meta.push(`bytes=${a.sizeBytes}`);
      const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      return `- ${idx + 1}. ${a.kind}: ${a.path}${metaStr}`;
    });
    parts.push(`[附件]\n${lines.join("\n")}\n[/附件]`);
  }
  parts.push(question);
  return parts.join("\n\n");
}
