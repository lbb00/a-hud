# @agent-hud/provider

[English](README.md) | 简体中文

Agent HUD 的宿主无关数据层，负责事实收集、规范化和本地状态，不负责 UI。

## 职责

- 规范化 Claude Code、Codex、Cursor 和 Antigravity 的 hook 事件；
- 折叠工具、子代理、计划和会话生命周期；
- 读取 Git 分支、dirty、ahead/behind 等原始事实；
- 派生 Claude Code 的 turn、缓存、compact 和成本事实；
- 读取并缓存服务健康状态；
- 管理 `~/.agent-hud` 下的私有事件与缓存文件。

Provider 不决定颜色、字符、字段顺序、告警阈值或响应式布局。缺失或不完整的数据源会
产生部分事实，不会阻塞宿主。

## 公共 API

包根路径是唯一公共导入入口：

```ts
import {
  deriveClaudeTelemetry,
  getGitStatus,
  loadState,
  normalizeAntigravityStatus,
  normalizeClaudeStatus,
  normalizeCursorStatus,
  recordHook,
} from "@agent-hud/provider";
```

| 领域 | 导出 |
| --- | --- |
| 宿主规范化 | `normalizeClaudeStatus`、`normalizeCursorStatus`、`normalizeAntigravityStatus` |
| Hook 状态 | `normalizeHookEvent`、`recordHook`、`loadState`、`foldEvents` |
| Claude 遥测 | `deriveClaudeTelemetry`、`contextPercent`、`extractEffort`、`compactBreakEvenTurns` |
| 健康状态 | `refreshAnthropicHealth`、`spawnHealthRefresh` |
| Git | `getGitStatus` |
| 安全本地 I/O | `resolveDataDir`、`eventFileFor`、`appendJsonLine`、`readTail`、`readJsonStdin` |

相关输入、事件、状态、活动和额度结构均从包根导出 TypeScript 类型，声明文件随包发布。

## 典型流程

```ts
import {
  deriveClaudeTelemetry,
  loadState,
  normalizeClaudeStatus,
  type ClaudeStatusInput,
} from "@agent-hud/provider";

export async function collect(input: ClaudeStatusInput) {
  const state = await loadState({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.workspace?.current_dir || input.cwd,
    platform: "claude",
  });
  const derived = await deriveClaudeTelemetry(input);
  return normalizeClaudeStatus(input, state, derived);
}
```

消费者必须把返回字段视为可空或部分可用，因为不同宿主可能不提供额度、transcript 或
VCS 等能力。

## 隐私

持久化数据保存在本地。事件只包含受限的结构化事实，不保存 prompt、命令输出或工具
响应。标准输入限制为 256 KiB；文本和路径会移除终端控制字符；私有文件采用原子写入并
修复权限。
