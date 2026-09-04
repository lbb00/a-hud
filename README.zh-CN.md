# Agent HUD

[English](README.md) | 简体中文

一套共享 HUD、一套 UI、一个独立数据 Provider，同时支持 Codex、
Claude Code、Cursor CLI、Antigravity CLI 和 pi。

```text
宿主状态 + Hooks + Git → @agent-hud/provider → UI Adapter → HUD Renderer
```

Provider 位于 [`packages/provider`](packages/provider)，共享 UI 插件位于
[`plugins/agent-hud`](plugins/agent-hud)。数据收集和展示策略严格分层，
各宿主共享同一套视觉语义，但不会伪造宿主没有提供的数据。

## HUD 效果

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00 | %+50% 9d
$5.32 | →~3t
agent-hud |  main*↑2 | +128/-17 | /workspace/agent-hud
```

三行各管一件事：第一行是会话现在的状态，第二行是要不要现在动手的判断，
第三行是你在哪。

**第一行 · 会话状态**

| 片段 | 是什么 |
| --- | --- |
| `Sonnet 5` | 当前模型。Anthropic 状态页报故障时，模型名本身会变色示警 |
| `H` | 思考强度，取值 `L` `M` `H` `XH` `MAX` |
| `90k/45% 26t` | 上下文已用 token、占窗口的比例、真实助手轮次（不含子 agent） |
| `*19:04` | 前缀缓存到这个时刻过期；已经过期显示 `*cold` |
| `#15%/70%` | 5 小时额度和 7 天额度的已用比例 |
| `↻13:10/Fri19:00` | 上面两个额度各自的重置时刻，顺序一一对应 |
| `%+50% 9d` | 优惠时段。绿色表示正在进行，后面是还剩多久；`%+50% ↑3h` 表示 3 小时后开始 |

**第二行 · 决策支持**

| 片段 | 是什么 |
| --- | --- |
| `$5.32` | 本次会话的估算成本，由客户端算出 |
| `→~3t` | 大约还有几轮就会触发强制压缩；`→full` 表示已经进入这个区间 |
| `↓~12t` | 主动压缩大约几轮后回本。它和上一个互斥，同时只会出现一个 |

**第三行 · 位置**

| 片段 | 是什么 |
| --- | --- |
| `agent-hud` | 项目名，整个 HUD 的视觉锚点 |
| `main*↑2` | 分支；`*` 是有未提交改动，`↑2` `↓1` 是相对上游领先和落后的提交数 |
| `+128/-17` | 本次会话改动的行数 |
| `/workspace/agent-hud` | 工作目录，窄屏时从左边省略，保留后半段 |

颜色只表示风险等级，亮度用于信息层级；唯一的例外是绿色，只用在正在进行的
优惠时段上。模型、上下文、缓存、额度、Git、
成本和活动信息会根据终端宽度自动收缩；缺失字段直接省略，不使用猜测值占位。
每个字段的完整定义和告警阈值见
[HUD 设计契约](plugins/agent-hud/docs/hud-design.md)。

## 宿主支持

| 宿主 | 原生展示面 | 活动信息 |
| --- | --- | --- |
| Claude Code | 完整三行 HUD | 原生 statusline |
| Codex | 原生 footer，不展示不可用的 5h 额度 | 可选 companion |
| Cursor CLI | 完整三行 HUD，不展示不可用的额度 | 原生 hooks |
| Antigravity CLI | 完整三行 HUD，包含额度和 VCS | 原生 hooks |
| pi | 在 pi 自带 footer 里插一段优惠时段和厂商故障提示 | 原生扩展 |

所有配置修改均为原子写入，只修改选中宿主的相关字段，并在覆盖已有配置前创建
带时间戳的备份。

## 安装与配置

Codex 和 Claude Code 通过本仓库的插件市场清单（`.claude-plugin/marketplace.json`）
安装；Cursor CLI、Antigravity CLI 和 pi 没有自己的插件管理机制，直接用内置 CLI 配置。

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

### pi

pi 自带的 footer 已经有 token、成本、上下文占比和分支，所以这里只在旁边插一段，
不接管整行。这一段只放 pi 自己算不出来的两件事：当前模型打的那个 API 有没有开着的
优惠时段，以及那家厂商的状态页有没有在报故障（报故障时显示 `!Anthropic`）。两件事
都属于 API 而不属于 pi，所以和其他打同一个接口的宿主共用同一份数据：

```bash
node plugins/agent-hud/dist/cli.js setup pi
```

它会写入 `~/.pi/agent/extensions/agent-hud.ts`，内容只有一行，指向构建出来的扩展；
这一段显示当前是否处于优惠时段。其余信息不搬过来：按 API 计费时套餐额度没有意义，
压缩剩余量的算法绑的是 Claude Code 的压缩阈值，搬到 pi 会算错。

`setup all` 会配置全部五个宿主；`setup both` 只配置 Claude Code 和 Codex。
追加 `--dry-run` 可以只查看拟写入内容，不修改任何文件。

## 优惠时段

厂商的限时活动（错峰额外用量、周末加量等）不会出现在任何宿主的状态数据里。时段表放在仓库的 [`packages/provider/promotions.json`](packages/provider/promotions.json)，改一次所有人生效，不用每个人各配一遍。这份表故意是空的：写一条没核实过的时段比不显示更糟，所以条目走 PR 提交。

运行时按三处读这张表。一是从仓库抓取后缓存到 `~/.agent-hud/promotions-cache.json`，最多六小时刷新一次，由独立的后台进程完成，状态栏不会等它。二是随包发布的内置副本，在第一次抓取之前和没网的时候顶上。三是你自己的 `~/.agent-hud/config.json`，叠在最上层，和共享表冲突时你的配置赢。

抓取只是一次普通的 GET，取那一个静态 JSON 文件，不携带任何会话数据；`AGENT_HUD_NO_REMOTE=1` 可以关掉它，内置副本和你自己的配置照常工作。

你自己的配置可以新增时段、按 id 藏掉共享表里的某几条，或者用 `"shared": false` 整体不用共享表：

```json
{
  "disabled": ["some-shared-window-id"],
  "promotions": [
    {
      "id": "claude-offpeak",
      "label": "50%",
      "platforms": ["claude"],
      "days": ["sat", "sun"],
      "start": "15:00",
      "end": "23:00",
      "from": "2026-09-01",
      "until": "2026-12-31"
    }
  ]
}
```

钟点按 UTC 解释，官方公告上的时间可以照抄，HUD 展示时换算成你本地的时区。如果你更愿意直接写本地时间，给这条窗口加上 `"timezone": "Asia/Shanghai"`；两种写法在夏令时切换当天的边界都是对的。时区名写错时，被丢掉的只有这一条窗口，不会把它的钟点当成 UTC 显示出一个错误时间。

必填的只有 `start` 和 `end`；`end` 不晚于 `start` 表示跨零点。`days` 可以写 `0`（周日）到 `6`，也可以写三字母缩写；`platforms` 限定只对某些宿主生效；`from` 和 `until` 圈定活动起止日期；`"enabled": false` 可以临时关掉一条而不用删。本地条目的 `id` 和共享表某条相同时，本地那条取代它。用来限定范围的字段（`platforms`、`days`、`from`、`until`、`timezone`）写错时，这一条窗口整条被丢掉，不会退化成"不限制"而在所有宿主、所有日子都显示。

有些优惠属于某个 API，而不属于某个宿主。DeepSeek 按钟点给 `api.deepseek.com` 上的请求计价，不管是哪个程序发的；同样的模型经别人转售就不算。这类时段用 `endpoints` 而不是 `platforms`：

```json
{
  "id": "vendor-offpeak",
  "label": "50%",
  "endpoints": ["api.example.com"],
  "start": "16:30",
  "end": "00:30"
}
```

上面的钟点是示意，不要照抄。厂商会改：DeepSeek 那个 16:30–00:30 UTC 的折扣已经随 V3/R1 的模型别名一起退役，现在改成按高峰和非高峰计价。这正是共享表放在仓库里、并且发布时是空的原因——如果编进运行时，一个退役的时段要发一次版才能删掉。

比对的是 base URL 里的主机名，所以 `https://api.deepseek.com/v1` 和 `api.deepseek.com` 是同一件事。这样写的时段，只在能说清当前模型走哪个接口的宿主上显示。pi 读取所选模型的 `baseUrl`；Claude Code 读取继承到的 `ANTHROPIC_BASE_URL` 和云厂商设置，只有这些设置都不存在时才默认 `api.anthropic.com`。其他地方一律不显示，因为说不清的程序不该替你认领这个折扣。

配好之后，HUD 第一行在时段内显示绿色的 `%50% 1h20`，时段外显示不着色的 `%50% ↑2h13`——先是标签，然后是还能用多久，或者还有多久开始。绿色是这个 HUD 里唯一不表示警告的颜色，只给这一项用，因为它是唯一"现在动手就有好处"的信号。

`agent-hud promotions` 会打印两处来源的路径、共享表是什么时候从哪里抓来的、解析出来的每条时段、本次使用的平台和接口筛选条件，以及当前哪一条生效。

## 数据边界

- 只保存时间、模型、工作目录、工具名、短目标、代理类型和计划标签等必要事实。
- 不保存 prompt、命令输出、工具响应或完整 transcript。
- Codex、Cursor 和 Antigravity 的内部 transcript 不属于稳定契约，不会被解析。
- 本地事件与缓存写入 `~/.agent-hud`，目录和文件权限会修复为
  `0700/0600`。
- 共享优惠时段表通过一次普通 GET 从 GitHub 抓取，只取那个静态 JSON，不携带任何
  会话数据；`AGENT_HUD_NO_REMOTE=1` 可关闭。
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
