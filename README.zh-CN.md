# Agent HUD

[English](README.md) | 简体中文

一套共享 HUD、一套 UI、一个独立数据 Provider，同时支持 Codex、
Claude Code、Cursor CLI 和 Antigravity CLI。

```text
宿主状态 + Hooks + Git → @agent-hud/provider → UI Adapter → HUD Renderer
```

Provider 位于 [`packages/provider`](packages/provider)，共享 UI 插件位于
[`plugins/agent-hud`](plugins/agent-hud)。数据收集和展示策略严格分层，
四个宿主共享同一套视觉语义，但不会伪造宿主没有提供的数据。

## HUD 效果

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00
$5.32 | →~3t
agent-hud |  main*↑2 | +128/-17 | /workspace/agent-hud
```

颜色只表示风险等级，亮度用于信息层级。模型、上下文、缓存、额度、Git、
成本和活动信息会根据终端宽度自动收缩；缺失字段直接省略，不使用猜测值占位。

## 宿主支持

| 宿主 | 原生展示面 | 活动信息 |
| --- | --- | --- |
| Claude Code | 完整三行 HUD | 原生 statusline |
| Codex | 原生 footer，不展示不可用的 5h 额度 | 可选 companion |
| Cursor CLI | 完整三行 HUD，不展示不可用的额度 | 原生 hooks |
| Antigravity CLI | 完整三行 HUD，包含额度和 VCS | 原生 hooks |

所有配置修改均为原子写入，只修改选中宿主的相关字段，并在覆盖已有配置前创建
带时间戳的备份。

## 安装与配置

Codex 和 Claude Code 通过本仓库的插件市场清单（`.claude-plugin/marketplace.json`）
安装；Cursor CLI 和 Antigravity CLI 没有自己的插件管理机制，直接用内置 CLI 配置。

### Codex

```bash
codex plugin marketplace add /absolute/path/to/agent-hud
codex plugin add agent-hud@agent-hud
```

随后让 Codex 执行：`使用 balanced 预设配置 Agent HUD。`

Codex 的原生 footer 负责模型、上下文、额度、Git 和任务进度。若需要实时查看工具、
子代理和计划活动，可在独立终端或 pane 中运行：

```bash
node plugins/agent-hud/dist/cli.js watch --cwd "$PWD"
```

### Claude Code

在 Claude Code 中执行：

```text
/plugin marketplace add /absolute/path/to/agent-hud
/plugin install agent-hud@agent-hud
/reload-plugins
/agent-hud:setup
```

配置完成后重启 Claude Code，使其重新加载 statusline。

### Cursor CLI 与 Antigravity CLI

```bash
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
```

`setup all` 会配置全部四个宿主；`setup both` 只配置 Claude Code 和 Codex。
追加 `--dry-run` 可以只查看拟写入内容，不修改任何文件。

## 数据边界

- 只保存时间、模型、工作目录、工具名、短目标、代理类型和计划标签等必要事实。
- 不保存 prompt、命令输出、工具响应或完整 transcript。
- Codex、Cursor 和 Antigravity 的内部 transcript 不属于稳定契约，不会被解析。
- 本地事件与缓存写入 `~/.agent-hud`，目录和文件权限会修复为
  `0700/0600`。
- Hook 与辅助遥测失败时静默降级，不能阻塞宿主会话。

## 开发

开发环境使用 Node.js 20.19+ 或 22.12+，npm 11.16+；发布产物保持
Node.js 18 运行兼容。

```bash
npm ci
npm run check
npm run package:lint
npm run package:smoke
npm run release:check
```

`release:check` 会执行源码 lint、文档结构与链接检查、TypeScript 构建、全部测试、
包契约检查，以及两个真实 tarball 的隔离安装与运行验证。

## 中文文档

- [架构说明](docs/architecture.zh-CN.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [Provider 说明](packages/provider/README.zh-CN.md)
- [插件说明](plugins/agent-hud/README.zh-CN.md)

## 项目策略

- [开源就绪清单](docs/open-source-readiness.md)
- [安全策略](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [变更记录](CHANGELOG.md)
- [发布流程](docs/releasing.md)
- [MIT 许可证](LICENSE)
