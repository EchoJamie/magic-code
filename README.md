# Magic Code

本机软件工程智能体。macOS App 持有运行服务，状态栏查看工作、接回终端和停止任务；TUI 负责交代、对话与审批。

关闭终端或收起面板后，有责任的工作继续运行。退出 App 会关闭准入并收尾全部所属资源；未确认退出会保留故障界面供重试。App 退出后旧终端保留记录与草稿，按 `ctrl+r` 明确重新打开，随后仍须明确发送草稿。

## macOS App

开发目标为 macOS 26 / arm64、Xcode 与 Bun。同版 App、内置 helper、CLI 和协议一起构建：

```sh
bun install
bun run build:macos
open '.artifacts/macos/Magic Code.app'
'.artifacts/macos/Magic Code.app/Contents/Helpers/magic-runtime'
```

测试副本使用独立 bundle 身份、发现目录与隔离数据目录（按固定验证根隔离）。源码 CLI 只连接同源测试宿主；日常使用 App 内置的命令，在设置里选择安装目录后安装 `magic` 链接。登录时打开与系统通知默认关闭，通知权限仅由设置里的明确启用动作申请。

基础目录下使用 `.magic` 保存配置；已选数据实例由 App 发布。显式 `MAGIC_HOME` 与当前实例不一致会拒绝连接，切换须在 App 无在途责任时完成。握手、状态汇总与历史查看均不标读、不起执行者。

`bun run check` 检查 TypeScript；`bun run check:macos` 重建签名开发包、运行 Swift 测试与隔离 App 联验；`bun run check:all` 执行两侧检查。默认测试不弹系统通知、不启用登录项、不安装用户命令链接。开发构建采用本机 ad-hoc 签名；公开 Release 需显式 Developer ID 与公证配置，参见 `scripts/macos/build.sh`。

## 开发

- **规划材料**（外部）：Obsidian「Magic」工作区 · `Magic Code/交接/`——材料清单（读什么）· 进度台账（当前开发项）· 回报（完成或卡住写回 `<单元号>.md`）；开工第一动作＝对表。
- **工作分解**：单元 · 契约 · 并行切分 · 集成顺序——开发以此为基准。
- **`playground/`**：试跑区——给 Agent 练手的临时目录，内容不入库。

## 仓库结构

Bun workspaces 分包：**一域一包**，外加契约包、外壳、装配根与测试层。

包间只经**契约**交互——共享语言 ＋ 跨域端口的代码落点在 `packages/contracts/`。
依赖方向：**域 / 外壳 → `@magic/contracts`**（＋许可外部库）；**`app` → 全部**（装配根）；`faux` 只依赖契约。越界由 `test/scaffold.test.ts` 拦截。

| 包 | 职责 |
| --- | --- |
| `packages/contracts` | 共享语言、跨域端口与原生 wire 编解码；零外部运行时依赖 |
| `packages/records` | 记录域——库 · blob（**写权唯一**） |
| `packages/model` | 模型域——供应商适配（AI SDK 封在域内） |
| `packages/permission` | 权限域——闸门（裁决 · 询问流转 · 度量） |
| `packages/execution` | 执行域——沙箱原语 · 工作区解析 |
| `packages/tools` | 工具域——机制 · 注册 · 分发（闸门在执行路径内） |
| `packages/conversation` | 对话域——主循环 · 上下文装配 · 系统提示词 |
| `packages/control` | 控制域——命令通道 · 事件订阅 · 可序列化 |
| `packages/faux` | **测试层 · 非域**——Faux Provider ＋ 共享测试替身（任何域的测试皆可安全取用） |
| `packages/tui` | 外壳——显示组件自持；只认控制面 |
| `packages/app` | 装配根 ＋ 入口——可执行名 `magic` |
| `apps/macos` | SwiftUI/AppKit 宿主、状态栏、通知、Terminal 与设置 |

## 常用命令

```sh
bun install                     # 装依赖（prepare 顺带配置 git 钩子）

# 产品路径
magic                           # 连接所属 App，打开交互界面
magic -h                        # 显示帮助（也可用 magic --help 或 magic help）
magic --session <id>            # 只读接回已有会话（id 见 /resume），明确输入后继续
magic --model <选择>             # default / cantrip / spell / arcane

# 下面两条不是日常用法
magic --check                   # 离线只读检查配置与路径，不启动 App、模型或工具
magic --script <文件>           # 连接同一 App 跑脚本，打印事件轨迹（JSONL）与摘要

# 开发
bun run check                   # 质量闸：typecheck + test
bun run typecheck
bun test

# 界面验收（研发设施，不是产品命令）
bun run ui --help               # 它是什么、四条子命令怎么跑
bun run ui script <步骤文件>     # **要有一段自己的交互、想看屏** ⇒ 这条
```

### 界面验收工具（`bun run ui`）

当前终端验收暂只保留 **200 列 × 40 行（优先）** 与 **100 列 × 40 行（辅助）**。其他尺寸的专项测试与验收规格撤销；历史证据保留当时实际尺寸，不改写成新规格。生产布局必须依据运行时实际终端尺寸与内容占位计算，不得绑定验收列宽、行数，不得为特定规格新增分支、固定空间预算或专用功能。测试优先复用默认尺寸或共享规格，避免散落重复常量。

**要验证界面长什么样，先用它。** 它起**真 `cli.ts`**（真装配 → 真外壳 → 真模型适配链）、
按键**经真 PTY** 送进去、屏上的字**从写出的字节里读**（`@xterm/headless`）——模型那头是
环回夹具（合成假 key，一个付费请求都不发），每一次运行一套隔离的 HOME / 库 / 工作区。

**四条子命令，§要哪半取哪半**：

| 命令 | 给什么 |
| --- | --- |
| `bun run ui list` | 内置场景的名字 |
| `bun run ui run <场景>` | **判据**：开发写的那套断言过没过 |
| `bun run ui run <场景> --frames` | **帧**：同一趟故事，**一条判据都不判**——每个该判的地方取一帧、记下此刻的读数 |
| `bun run ui script <步骤文件>` | **一段你自己的交互**：一条命令跑完、自己收尾、帧与读数落盘 |
| `bun run ui serve` | 常驻控制进程（stdin/stdout 逐行 JSON），跨多次调用操作同一个实例 |

**「要跑一段自己写的看看屏」＝写一个步骤文件**（`ui script`；`--help` 里有可照抄的例子，
`packages/app/test/ui/example-steps.json` 是一份能直接跑的）。步骤文件就是一段 JSON，
每一步**就是 `serve` 认的那条命令**（`start` / `send` / `key` / `resize` / `wait` / `capture` /
`quit` / `close`）；**别在外面拿 bash ＋ FIFO 把 `serve` 包起来**——那条路已经开在这儿了。

**看帧是四项**（`AGENTS.md`）：布局 · 文案语义 · 层级 · 通读。**「判据过了」不等于「看得过去」。**

**位置**：入口 `packages/app/scripts/ui.ts`；驱动与产物那一侧 `packages/app/test/ui/`；
每次运行的现场（`run.json` · `steps.ndjson` · `raw.bin` · `frames/` · `viewer.html`）
落在 `.ui-runs/`（已忽略入库）。

### 换模型（阶段 2）

**开局**——`--model default|cantrip|spell|arcane` 选择已配置来源，缺省使用 Default。

**工作中**——`/model` 分别显示默认模型 Default、模型档位 Cantrip / Spell / Arcane、当前对象的模型选择和独立思考等级。实际供应商与型号只在映射编辑层选择。首次“使用此模型开始”设置 Default 并填充尚未配置的三档；日后修改各项互不连改，保存配置不切换已有 Agent。

配置示例（密钥也可来自 `MAGIC_DEEPSEEK_API_KEY`）：

```json
{
  "providers": { "deepseek": { "vendor": "deepseek" } },
  "modelAliases": {
    "default": { "provider": "deepseek", "model": "deepseek-chat" },
    "cantrip": { "provider": "deepseek", "model": "deepseek-chat" },
    "spell": { "provider": "deepseek", "model": "deepseek-reasoner" },
    "arcane": { "provider": "deepseek", "model": "deepseek-reasoner" }
  }
}
```

执行选择只接受小写标识；`--provider`、原始型号、旧 `defaultProvider` 和网页专用 `webFetch` 配置均拒绝。思考偏好仅归 Agent/角色选择，型号覆盖不再保存 `reasoning` 默认。型号的容量/能力覆盖位于 `providers.<连接>.modelOverrides.<型号>`。网页提炼与压缩独立使用 Cantrip，关闭思考且无工具；失败保留原始记录并报告实际原因。

换档在下一请求生效，在途使用原组合；等待或接回的成员保留已解析的组合。失败保留选择与上下文，组合改变不盲目继承旧思考设置。状态行可选显示 Default 或英文档位，容量来自实际模型。
不认得的斜杠文字**不抢**——`/usr/bin 里有什么` 这类人话照旧发给模型。

### 多会话（阶段 2）

**启动＝新会话**（空手打开一个都不建——**首条消息按下回车才开张**）。**接着来是显式的**：

```text
magic --session <id>       接回已有会话；已完成会话只读回放，下一次明确输入才装配执行者
```

**打错 id 不静默**：库里没有这个 id 就报错退场——**不照 id 开一条新的**
（那样你以为接上了，其实没有）。id 从 `/session` 列表里抄。

外壳里打 **`/session`**：

```text
/session                    列出会话（序号 · 标题 · 当前那条标着「正在用」）——↑↓ 选 · 回车切过去 · esc 收起
/session new                新建一条并切过去
/session title 关于配色      给当前这条改个名字
```

> 序号是给眼睛用的，**不是命令参数**——没有「按序号切」那条命令（打 `/session 2`
> 只会回一句认得的用法）；选会话靠 ↑↓ ＋ 回车。

- **标题＝首条消息摘要**（首行 · 折叠空白 · 截到 20 字），**可改**；改过的存进库、没改过的现算。
- **切换只读接回**：有在途执行者时订阅同一运行，否则从记录回放。下一次明确输入在该会话原工作区恢复执行；原路径不可达时明确报错。
- **恢复处置的是在途**：崩溃时那一次「有调用、没结果」的操作，重起后**不自动重跑**
  （工具没有幂等声明位，无从判定重放安不安全），一律落一条账交你裁决——重跑就在会话里说一声。
- **单活跃**：同一时刻一条活跃会话；**一轮在跑时切不动**（屏上出声，原样不动）。
- **忙时／没开成不静默**：打不开、切不动都在屏上说一句缘由。

### 外部工具（MCP）

Magic 能连**你自己配置**的本地 MCP 服务器，把它们的工具交给模型用。在 `~/.magic/config.json`
里加一段 `mcp`：

```json
{
  "mcp": {
    "servers": {
      "files": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "env": { "TOKEN": "…" }
      }
    }
  }
}
```

- **只有这里写了才连**——工作区里出现别的配置文件不算授权，Magic 不会照着它去拉起进程。
- 服务器名就是它的身份：工具在模型那边与屏上都是 **`服务器 / 工具`**，两个服务器有同名工具也分得清。
- **每次调用都要你批准**：卡片上写着是哪台服务器、哪件工具，以及它这一次的**实际参数**；
  文案是 **`外部操作 · 效果由服务器决定`**，只给 `y` 批准这一次 / `n` 拒绝。
  服务器自报「只读 / 幂等」**不作数**，也不给「总是允许」——外部效果不由本机裁定。
- **拒绝＝一次都不发出去**；超时或连接断了时说「未收到结果，远端可能已执行」，**不自动重试**；
  中断只报已停止等待，**不声称远端撤销**。
- 退出时 Magic 收掉**自己拉起的**那些服务器进程——你自己起的服务不受影响。
- App 服务启动时预检配置的外部工具并释放探针；目录查询读取已有结果。`magic --check` 保持离线，不连接外部服务器。

`env` 里的密钥只传给那个子进程——不进日志、不进记录、不进模型请求。需要登录（OAuth）的服务器
与 HTTP 接入本版还不支持。

### 脚本（`--script`）

```json
{
  "inputs": [
    "看一下工作区",
    { "switch": { "alias": "spell" } },
    "刚才那个文件还在吗"
  ],
  "decisions": ["approve", { "decision": "approve", "remember": true }]
}
```

- `inputs`：按序走的步骤——**裸字符串**＝一条交代（等它收束再走下一步）；
  **`{ "switch": { "alias"?, "reasoning"? } }`** ＝会话中途换模型（与 `/model` 同一条链）；
  **`{ "input": { "text", "skills"?, "ref"? } }`** ＝一整份结构化交代（U33：技能随这次交代
  绑定、`ref` 是提交的配对键——回执按它配对）。
- `decisions`：裁决答复按询问次序取（用尽＝批准）；对象形带 `remember` ＝**「总是允许」**
  （本会话同类不再问）。

## 质量闸与守护

- **提交前自动跑**——`.githooks/pre-commit`，经 `bun install` 的 prepare 装配 `core.hooksPath`。
- **校验对象＝暂存内容**——闸把暂存区物化到临时目录再跑，故「暂存到坏版本」会被拦下，未跟踪的本地草稿不会误拦。
- **覆盖范围＝入库目录**——仓库级守护在 `test/`，包级测试在 `packages/<pkg>/test/`；`playground/` 是试跑区，内容不参与（见 `bunfig.toml`）。
- **仓库级守护**（`test/scaffold.test.ts`）按面分：
  - **依赖纪律**——`src/**` 只许 `@magic/contracts`（＋许可外部库：模型域 → AI SDK · 外壳 → Ink / React）；**`test/**` 额外许可 `@magic/faux`**（`dependencies` 与 `peerDependencies` 同受生产面约束）。
  - **fs 直触**——只许记录域与执行域；扫描面＝**域包** `src/`（外壳 · 装配根 · 测试层不在此列——装配根读配置是设计明写的事）。
  - **blobs 落点唯一** · **契约包零运行时依赖** · **包表完备**（新包落地须登记）· **公开面只出 `.`**。

> 建仓：2026-09-16（规划侧）。
