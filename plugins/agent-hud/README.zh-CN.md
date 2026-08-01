# Agent HUD

[English](README.md) | 简体中文

一套本地 HUD 核心，同时支持 Codex、Claude Code、Cursor CLI 和
Antigravity CLI。

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00
$5.32 | →~3t
agent-hud |  main*↑2 | +128/-17 | /workspace/agent-hud
```

UI 契约继承已有 shell HUD：颜色只表达风险，亮度负责层级；上下文压力、缓存新鲜度、
额度节奏、compact 建议和窄终端行为保持统一语义。

## 两层实现，四个宿主

- `@agent-hud/provider` 收集并规范化原始事实，负责 I/O、事件状态、Git 和派生遥测，
  不包含颜色、字符或布局策略。
- UI 插件把事实适配成统一展示模型，再由纯 renderer 输出 ANSI 文本。

各宿主只展示自身真实提供的数据：

- Claude Code：在原生 statusline 中运行完整三行 renderer。
- Cursor CLI：使用相同 renderer 和原生生命周期 hooks；没有额度数据时直接省略。
- Antigravity CLI：使用相同 renderer，并接入原生额度、VCS、生命周期和后台任务事实。
- Codex：原生 footer 展示模型、上下文、额度、Git 和进度；可选 companion 展示工具、
  子代理和计划活动。

实现不会读取 Codex、Cursor 或 Antigravity 的内部 transcript。

## 常用命令

从 workspace 根目录运行：

```bash
npm test
node plugins/agent-hud/dist/cli.js demo
node plugins/agent-hud/dist/cli.js setup claude
node plugins/agent-hud/dist/cli.js setup codex --preset balanced
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
node plugins/agent-hud/dist/cli.js setup both
node plugins/agent-hud/dist/cli.js setup all
node plugins/agent-hud/dist/cli.js watch --cwd "$PWD"
node plugins/agent-hud/dist/cli.js watch --once --json
```

配置写入是原子的；修改已有文件前会创建时间戳备份。使用 `--dry-run` 可只查看结果。
完整命令和参数契约见 [CLI reference](docs/cli.md)。

## 目录结构

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
.cursor-plugin/plugin.json
plugin.json
hooks/hooks.json
skills/agent-hud/SKILL.md
commands/setup.md
src/
dist/
docs/
```

Codex 与 Claude Code 共用打包后的 hook manifest；Cursor 与 Antigravity 使用各自的
原生 hook schema，由幂等 setup patcher 写入配置。

## 隐私与降级

事件保存在 `~/.agent-hud`，只记录时间、模型、工作目录、工具名、短目标、代理类型和
计划标签。不会保存 prompt、命令输出或工具响应。私有目录和文件权限会修复为
`0700/0600`，事件与缓存维护有数量、时间和并发边界。

Hook 失败不会中断会话。唯一的网络读取是带缓存的服务状态检查；刷新失败时保留上一次
有效结果。
