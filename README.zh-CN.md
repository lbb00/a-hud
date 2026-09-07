# Agent HUD：给 AI 编码 agent 用的状态栏

[English](README.md) | 简体中文

Agent HUD 是一个开源的终端状态栏（heads-up display，HUD），支持 Claude Code、OpenAI Codex、Cursor CLI、Antigravity CLI 和 pi。它把宿主自己知道、但没有显示出来的会话信息放到屏幕上：上下文和 token 用量、额度或估算成本、Git 状态，以及 agent 此刻在做什么。pi 保留自己的 footer，只额外加一段优惠时段和厂商故障提示。

同一套 HUD 在每个宿主上长得一样，换工具不用重新学。每个宿主用自己的方式安装，配置里无关的部分不会被动。

## 目录

- [安装](#安装)
- [宿主支持](#宿主支持)
- [HUD 效果](#hud-效果)
- [优惠时段](#优惠时段)
- [常见问题](#常见问题)
- [开发](#开发)
- [更多文档](#更多文档)

## 安装

从源码构建需要 Node.js 20.19 及以上的 20.x，或 Node.js 22.12 及以上，以及 npm 11.16+。克隆仓库后在根目录构建：

```bash
git clone https://github.com/lbb00/a-hud.git agent-hud
cd agent-hud
npm ci
npm run build
```

下面命令里的 `/absolute/path/to/agent-hud` 换成这个仓库的绝对路径。`setup all` 会配置全部五个宿主；`setup both` 只配置 Claude Code 和 Codex。加 `--dry-run` 可以在改文件之前先看拟写入的内容，细节见 [CLI 参考](plugins/agent-hud/docs/cli.md)。setup 在改动任何已有文件之前都会先备份。

### Codex

```bash
codex plugin marketplace add /absolute/path/to/agent-hud
codex plugin add agent-hud@agent-hud
```

随后让 Codex 执行：`使用 balanced 预设配置 Agent HUD。`

### Claude Code

在 Claude Code 中执行：

```text
/plugin marketplace add /absolute/path/to/agent-hud
/plugin install agent-hud@agent-hud
/reload-plugins
/agent-hud:setup
```

配置完成后重启 Claude Code，让它重新加载 statusline 命令。

### Cursor CLI 与 Antigravity CLI

```bash
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
```

这两条命令会加上宿主原生的状态栏和 hooks，不会覆盖无关的设置。

### pi

```bash
node plugins/agent-hud/dist/cli.js setup pi
```

pi 自带的 footer 已经有 token、成本、上下文和分支。Agent HUD 在旁边加一段，显示当前模型所用 API 端点上正在进行或即将开始的优惠时段，以及厂商故障（例如 `!Anthropic`）。默认写入 `~/.pi/agent/extensions/agent-hud.ts`，内容只是转出构建好的扩展；pi 的目录可以用 `PI_CODING_AGENT_DIR` 改。

## 宿主支持

| 宿主 | 显示在哪 | 显示什么 |
| --- | --- | --- |
| Claude Code | 它自己的三行状态栏 | 会话、额度、缓存、估算成本、压缩预估、Git、优惠时段 |
| Codex | 它自己的 footer，可选加一个[活动伴侣窗口](plugins/agent-hud/docs/cli.md#activity-companion) | 会话和 Git；Codex 不报 5 小时额度，所以不展示不可用的 5h 额度；伴侣窗口显示工具、子 agent 和计划 |
| Cursor CLI | 它自己的状态栏和 hooks | 会话和 Git；Cursor 不报额度，所以不显示 |
| Antigravity CLI | 它自己的状态栏和 hooks | 额度和 Git，宿主提供时才显示 |
| pi | pi 自己 footer 里的一段 | 所选 API 端点上的优惠时段和厂商故障 |

## HUD 效果

Claude Code 状态栏的例子（数值是示意）：

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00 | %+50% 9d
$5.32 | →~3t
agent-hud | main*↑2 | +128/-17 | /workspace/agent-hud
```

三行各回答一个问题：这个会话在做什么、要不要现在动手、你在哪。宿主给不出的字段直接省略，不用猜测值占位。

**会话状态**

| 片段 | 含义 |
| --- | --- |
| `Sonnet 5` | 当前模型；会话走 Anthropic API 时，Anthropic 状态页报故障，模型名本身会变色示警 |
| `H` | 思考强度，取值 `L`、`M`、`H`、`XH` 或 `MAX` |
| `90k/45% 26t` | 上下文已用 token、占窗口的比例、助手轮次；子 agent 的轮次不计 |
| `*19:04` | 前缀缓存到这个时刻过期；已经过期显示 `*cold` |
| `#15%/70%` | 5 小时额度和 7 天额度的已用比例，宿主提供时才显示 |
| `↻13:10/Fri19:00` | 上面两个额度各自的重置时刻，顺序一一对应 |
| `%+50% 9d` | 优惠时段。绿色表示正在进行，后面是还剩多久；`%+50% ↑3h` 表示 3 小时后开始；只有 `%+50%` 表示正在进行且没有截止日期 |

**决策支持**

| 片段 | 含义 |
| --- | --- |
| `$5.32` | 本次会话的估算成本，由客户端算出 |
| `→~3t` | 大约还有几轮就会触发强制压缩；`→full` 表示已经到了 |
| `↓~12t` | 主动压缩大约几轮后回本；它出现时不再显示上一项 |

**位置**

| 片段 | 含义 |
| --- | --- |
| `agent-hud` | 项目名 |
| `main*↑2` | 分支；`*` 是有未提交改动，`↑2` `↓1` 是相对上游领先和落后的提交数 |
| `+128/-17` | 本次会话增删的行数 |
| `/workspace/agent-hud` | 工作目录，窄屏时从左边省略，保留后半段 |

颜色只表示风险等级，亮度用于信息层级。唯一的例外是绿色，只给正在进行的优惠时段用。每个字段的完整定义和告警阈值见 [HUD 设计契约](plugins/agent-hud/docs/hud-design.md)。

## 优惠时段

厂商会做限时活动，比如错峰折扣、周末加量，这些不会出现在任何宿主的状态数据里。Agent HUD 把它们显示成一个徽标。共享时段表放在仓库的 [`packages/provider/promotions.json`](packages/provider/promotions.json)，改一次所有人生效，不用每个人各配一遍。这份表故意是空的：写一条没核实过的时段比不显示更糟，所以条目走 PR 提交。

这张表通过三条路到你机器上，后面的覆盖前面的。一是从仓库抓取后缓存到 `~/.agent-hud/promotions-cache.json`，最多六小时刷新一次，由后台进程完成，状态栏不会等它；抓取失败时上一份好的副本继续用。二是随包发布的内置副本，在第一次抓取之前、没网的时候，以及它比缓存新的时候顶上。三是你自己的 `~/.agent-hud/config.json`，叠在最上层，和共享表冲突时你的配置赢。`AGENT_HUD_NO_REMOTE=1` 只关掉抓取，内置副本和你的配置照常工作。

下面的例子都是编的。你自己的配置可以新增时段、按 `id` 藏掉共享表里的某几条，或者用 `"shared": false` 整体不用共享表：

```json
{
  "disabled": ["example-shared-window"],
  "promotions": [
    {
      "id": "example-weekend-offpeak",
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

钟点按 UTC 解释，官方公告上的时间可以照抄，HUD 展示时换算成你本地的时区。如果你更愿意直接写本地时间，给这条窗口加上 `"timezone": "Asia/Shanghai"`。两种写法都处理夏令时切换；时区名写错时只丢掉这一条窗口，不会把它的钟点当成 UTC 显示出一个错误时间。

必填的只有 `start` 和 `end`；`end` 不晚于 `start` 表示跨零点。`days` 可以写 `0`（周日）到 `6`，也可以写三字母缩写；`platforms` 限定只对某些宿主生效；`from` 和 `until` 圈定活动起止日期；`"enabled": false` 可以临时关掉一条而不用删。本地条目的 `id` 和共享表某条相同时，本地那条取代它。用来限定范围的字段写错时，这一条窗口整条被丢掉，不会退化成"不限制"而在所有宿主、所有日子都显示。

有些优惠属于某个 API，而不属于某个宿主：厂商按钟点给自己端点上的请求计价，不管是哪个程序发的，同样的模型经别人转售就不算。这类时段用 `endpoints` 而不是 `platforms`：

```json
{
  "id": "example-api-offpeak",
  "label": "50%",
  "endpoints": ["api.example.com"],
  "start": "16:30",
  "end": "00:30"
}
```

比对的是 base URL 里的主机名，所以 `https://api.example.com/v1` 和 `api.example.com` 是同一件事。这样写的时段，只在能说清当前模型走哪个端点的宿主上显示。pi 读取所选模型的 `baseUrl`；Claude Code 读取继承到的 `ANTHROPIC_BASE_URL` 和云厂商设置，只有这些都没设时才默认 `api.anthropic.com`。其他地方一律不显示，因为说不清的程序不该替你认领这个折扣。

想看每份时段表从哪来、解析出来的每条时段、本次用了哪些筛选条件、当前哪一条生效，换成你自己的端点运行：

```bash
node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com
```

## 常见问题

### Codex 能显示和 Claude Code 一样的 HUD 吗？

不全能。Codex 有自己的 footer，Agent HUD 往里填的是 Codex 报出来的信息，比 Claude Code 状态栏少。可选的活动伴侣窗口在旁边补上工具、子 agent 和计划。

### 为什么有些字段不显示？

宿主没报这个信息，或者它不适用。比如按 API 计费时，套餐额度没有意义。Agent HUD 直接省略，不做估算。

### 为什么看不到优惠徽标？

没有时段匹配当前的时间、宿主或端点。共享表在有活动被核实之前是空的，所以要么等一条合并进去，要么在你自己的配置里写一条。想看加载了哪些时段、被哪个条件筛掉了，在仓库目录下换成你自己的端点运行：

```bash
node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com
```

### Agent HUD 会把会话数据发出去吗？

不会。Hook 事件只写在 `~/.agent-hud`，记录的是时间、模型、工作目录、工具名这类短事实，不保存 prompt、命令输出和 transcript；Codex、Cursor 和 Antigravity 的内部 transcript 不属于稳定契约，不会被解析。对外只有两个普通 GET：一个取仓库里那个静态 JSON 的共享时段表，一个取当前 API 所属厂商的状态页。两个都不带会话数据。`AGENT_HUD_NO_REMOTE=1` 只停掉时段表抓取，状态页检查不受影响。

## 开发

开发环境和[安装](#安装)要求的 Node.js 与 npm 相同；发布产物仍可在 Node.js 18 上运行。在仓库根目录：

```bash
npm ci
npm run check
npm run lint:fix
npm run build
```

`npm run check` 会跑 lint、文档链接检查和全部测试。数据 [provider](packages/provider) 和 [UI 插件](plugins/agent-hud) 是两个独立的包，两者的边界见[架构说明](docs/architecture.zh-CN.md)。

## 更多文档

- [CLI 参考](plugins/agent-hud/docs/cli.md)
- [架构说明](docs/architecture.zh-CN.md)
- [Provider 说明](packages/provider/README.zh-CN.md)
- [插件说明](plugins/agent-hud/README.zh-CN.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [开源就绪清单](docs/open-source-readiness.md)
- [安全策略](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [变更记录](CHANGELOG.md)
- [发布流程](docs/releasing.md)
- [MIT 许可证](LICENSE)
