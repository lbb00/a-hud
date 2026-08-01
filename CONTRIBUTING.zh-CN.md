# 参与 Agent HUD 开发

[English](CONTRIBUTING.md) | 简体中文

所有改动都应维护一个共享数据模型和一套跨 Codex、Claude Code、Cursor CLI、
Antigravity CLI 的视觉契约。

## 开始之前

- 使用 Node.js 20.19+ 或 22.12+，npm 11.16+。
- 提交问题前先搜索已有 issue。
- 一个 pull request 只处理一个行为、缺陷或文档主题。
- 大型行为改动或 Provider 边界调整应先讨论兼容契约。

## 本地环境

```bash
npm ci
npm run check
npm run package:lint
npm run package:smoke
```

`npm run check` 包含 Oxlint、文档结构/链接检查、TypeScript 构建、Provider 测试、
renderer 测试、shell 差异测试和包边界测试。

`npm run package:lint` 检查包清单、ESM 解析和 TypeScript 声明；
`npm run package:smoke` 会创建两个真实 tarball，在隔离消费者中安装并执行 CLI 与
Provider 导入。

## 架构边界

修改数据收集或展示前，请阅读[中文架构说明](docs/architecture.zh-CN.md)。

- `packages/provider` 只负责原始事实、宿主规范化、本地持久化和生命周期。
- `plugins/agent-hud/src/adapter.ts` 负责事实到展示模型的优先级。
- `plugins/agent-hud/src/design.ts` 负责设计 token。
- `plugins/agent-hud/src/render.ts` 是纯 renderer。
- 宿主集成只使用受支持的 payload 与 hooks。
- 不解析 Codex、Cursor 或 Antigravity 的内部 transcript。
- 维护文件不得超过 500 行，应按职责拆分并保留稳定公共 facade。

原 shell HUD fixture 及注释是兼容证据。UI 改动必须更新聚焦测试，并说明有意的契约
变化，不能静默改写原有语义。

## 测试

为公开行为添加最窄、最直接的测试：

- Provider 事实或生命周期：`packages/provider/test`；
- 展示策略或 ANSI 输出：`plugins/agent-hud/test`；
- 宿主配置：`plugins/agent-hud/test/setup.test.mjs`；
- shell 一致性：`plugins/agent-hud/test/legacy-differential.test.mjs`；
- 打包或仓库契约：package/structure 测试与 `npm run package:smoke`。

提交前执行：

```bash
npm run release:check
node plugins/agent-hud/dist/cli.js setup codex --dry-run
node plugins/agent-hud/dist/cli.js setup claude --dry-run
node plugins/agent-hud/dist/cli.js setup cursor --dry-run
node plugins/agent-hud/dist/cli.js setup antigravity --dry-run
```

Dry-run 可能包含本地路径和宿主配置，附到 issue 或 pull request 前必须脱敏。

## 代码与提交

- 生产代码使用 TypeScript ESM，编译后保留的相对 import 必须带 `.js` 扩展名。
- 数据缺失时返回部分事实，不能阻塞宿主会话。
- 修改配置时保留无关字段并创建备份。
- 注释应解释设计意图、兼容约束和拒绝方案。
- 注释和文档只描述 Agent HUD 自身，不引用其他 HUD 或状态栏项目。
- Commit 使用清晰的英文 Conventional Commit，例如：
  `fix(provider): preserve lifecycle state after a stale hook`。

## Pull request

Pull request 应包含：

- 用户可见或架构层面的改动原因；
- 受影响的宿主和包边界；
- 新增或更新的测试；
- 完整验证命令；
- UI 改动的终端截图或录屏；
- 对路径、prompt、transcript 和凭据的脱敏确认；
- 用户可见改动对应的 Changelog 条目。

提交贡献即表示同意按照 MIT License 授权。
