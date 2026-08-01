# Agent HUD 架构

[English](architecture.md) | 简体中文

Agent HUD 由一个数据包和一个 UI 插件组成，依赖方向严格单向：

```text
宿主状态 JSON ─────┐
四套原生 Hook API ┼─> @agent-hud/provider ─> UI Adapter ─> Renderer
Git / Claude 指标 ─┘       原始事实             策略          ANSI 文本
```

## Provider 边界

`packages/provider` 负责 I/O、宿主 schema 规范化、持久化本地状态和原始派生指标。
公共模型使用 `ProviderState`、`ToolActivity`、`GitStatus`、
`ClaudeSessionFacts` 和 `HostSessionFacts` 等中性名称。

只有宿主规范化函数可以读取 `context_window`、`rate_limits`、`quota` 等嵌套
宿主字段。UI 接收的是完整、扁平的事实集合。

内部按生命周期职责拆分：

- `store.ts` 负责事件持久化和状态折叠；
- `hooks/normalize.ts` 负责宿主 hook 规范化；
- `telemetry.ts` 组合 Claude 指标；
- `telemetry/transcript.ts` 负责增量 transcript 证据；
- `telemetry/health.ts` 负责健康状态缓存和刷新；
- `telemetry/config.ts` 负责共享收集默认值。

Provider 可以表达“缓存到期时间是 T”“compact 约剩 N 轮”“额度使用 P，重置时间
R”，但不能决定“显示黄色”“优先展示哪个建议”或“窄于 60 列隐藏第二行”。这些都
属于 UI 策略。

## UI 插件边界

`plugins/agent-hud` 是宿主适配和展示层：

- `adapter.ts` 把原始事实映射到展示模型，并解决展示优先级；
- `design.ts` 保存设计 token、阈值和设计理由；
- `render.ts` 是纯 ANSI/文本 renderer；
- `setup.ts` 适配各宿主的配置表面；
- `cli.ts` 组合两层并生成自包含运行入口。

Claude Code、Cursor 和 Antigravity 支持完整三行 renderer。Cursor 没有额度事实时
省略额度；Antigravity 使用原生额度、VCS、生命周期和后台任务事实。Codex 只允许
预定义 footer 字段，因此使用相同层级组织原生 footer，并省略不可用的 5h 字段。
工具、子代理和计划活动由可选 companion 展示。

## 打包规则

Provider 可以独立构建和测试。插件将其声明为 workspace 开发依赖，再将 Provider 和
运行依赖打进 `dist/*.js`。安装后的插件不依赖源码 workspace，也不需要运行时
`node_modules/@agent-hud/provider`。

维护中的源码、测试、fixture 和文档每个文件不得超过 500 行。生成产物、依赖和
lockfile 不计入该职责边界。

## 不变量

- 数据层不得包含颜色、字符、布局或展示优先级。
- UI 不得直接读取嵌套宿主状态 schema。
- 不解析 Codex、Cursor 或 Antigravity 的内部 transcript。
- 缺失事实必须省略，不能从文本推断。
- Hook、缓存和辅助遥测失败不能阻塞宿主。
- 配置修改必须保留无关字段，并在覆盖前备份。
