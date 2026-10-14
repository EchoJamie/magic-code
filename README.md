# Magic Code

本机软件工程智能体。Magic Engine 管理运行与记录；macOS App 提供状态栏、会话管理与通知阅读，TUI 负责交代、对话与审批。

关闭终端、收起面板或退出 App 后，Engine 中已受理的工作继续运行。终端断线时保留记录与草稿，按 `ctrl+r` 明确重连；重连与恢复都不会自动发送草稿。

## macOS App

开发目标为 macOS 26 / arm64、Xcode 与 Bun。同版 App、内置 helper、CLI 和协议一起构建：

```sh
bun install
bun run build:macos
open '.artifacts/macos/Magic Code.app'
'.artifacts/macos/Magic Code.app/Contents/Helpers/magic-runtime'
```

测试副本使用独立 bundle 身份、发现目录与隔离数据目录（按固定验证根隔离）。源码 CLI 只连接同源测试宿主；日常使用 App 内置的命令，在设置里选择安装目录后安装 `magic` 链接。登录时打开与系统通知默认关闭，通知权限仅由设置里的明确启用动作申请。

所选基础路径下的 `.magic` 共同保存配置、记录、blob、授权、日志、缓存与 Magic 用户技能；已选实例由 App 发布。旧 `dataDir` 键作为未知配置忽略，不迁移或删除旧数据。显式 `MAGIC_HOME` 与当前实例不一致会拒绝连接，切换须在 App 无在途责任时完成。握手、状态汇总与历史查看均不标读、不起执行者。

`bun run check` 执行类型检查与全部 TS 测试；`bun run check:macos` 重建签名开发包、运行 Swift 测试与隔离 App 联验；`bun run check:all` 执行两侧检查。默认测试不弹系统通知、不启用登录项、不安装用户命令链接。开发构建采用本机 ad-hoc 签名；公开 Release 需显式 Developer ID 与公证配置，参见 `scripts/macos/build.sh`。

## 调试模式与日志

设置 → 高级 → 诊断与系统集成可调整调试开关和日志等级，保存后立即应用于当前 App、管理者和在途执行者。两项独立：调试默认关闭，日志默认 `info`；开启调试显示可找回的独立工作窗口，关闭窗口不关闭调试模式。

```sh
magic --debug --log-level debug
magic --no-debug --log-level info
```

App 可执行文件同样接受这些参数。显式参数保存当前实例 `config.json` 的 `debugMode` / `logLevel`，无参数沿用保存值；与 `--check` 不能组合。调试模式不改变数据、凭据、工作区或操作权限，Release 同样支持。

日志写入所选 `.magic` 目录下的 `logs/`，设置中可复制路径或在 Finder 打开。App、管理者和执行者各写 JSONL 文件，等级为 `error / warn / info / debug / trace`。只记录结构化事件和已有标识，不复制凭据、对话或工具正文。单文件 10 MiB，目录保留目标 100 MiB，活动文件优先保留；退出排空最多等待两秒。

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
magic resume <id>            # 只读接回已有会话（id 见 /resume），明确输入后继续
magic --model <选择>             # default / cantrip / spell / arcane

# 下面两条不是日常用法
magic --check                   # 离线只读检查配置与路径，不启动 App、模型或工具
magic --script <文件>           # 连接同一 App 跑脚本，打印事件轨迹（JSONL）与摘要

# 开发
bun run check:commit            # 提交门禁：typecheck + 快速回归
bun run check                   # 合并回归：typecheck + 全部 TS 测试
bun run typecheck
bun run test:fast               # 纯逻辑、契约、组件与廉价隔离 I/O
bun run test:integration        # 真实进程、协议与生命周期
bun run test:e2e                # 真实 CLI / Engine / PTY 全链路
bun run test                    # 全部 TS 测试

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
  "models": {
    "default": { "provider": "deepseek", "model": "deepseek-chat" },
    "cantrip": { "provider": "deepseek", "model": "deepseek-chat" },
    "spell": { "provider": "deepseek", "model": "deepseek-reasoner" },
    "arcane": { "provider": "deepseek", "model": "deepseek-reasoner" }
  }
}
```

执行选择只接受小写标识；`--provider` 与原始型号均拒绝。思考偏好仅归 Agent/角色选择，型号覆盖不再保存 `reasoning` 默认。型号的容量/能力覆盖位于 `providers.<连接>.modelOverrides.<型号>`。网页提炼与压缩独立使用 Cantrip，关闭思考且无工具；失败保留原始记录并报告实际原因。

换档在下一请求生效，在途使用原组合；等待或接回的成员保留已解析的组合。失败保留选择与上下文，组合改变不盲目继承旧思考设置。状态行可选显示 Default 或英文档位，容量来自实际模型。
不认得的斜杠文字**不抢**——`/usr/bin 里有什么` 这类人话照旧发给模型。

### 会话管理与接回

空手打开终端不创建会话，首条交代提交后才保存记录。`magic resume <id>` 接回普通会话；不存在的身份明确报错，已归档会话必须先在 App 或 `/resume` 中手动恢复。`magic resume <id> --check` 只读报告记录与归档状态。

状态栏只显示仍在执行、当前内容尚未确认或终端入口仍打开的普通工作。完整历史在“管理会话…”打开的主窗口会话页中查看，支持普通／已归档、工作区、名称筛选、历史阅读、改名和批量归档／恢复。会话是主窗口默认界面，工具栏齿轮进入应用设置，设置页通过“返回会话”回到原位置；设置入口和通知定位复用这个窗口；状态栏保持轻量弹出。App 提供复制接回命令，实际发送和审批仍回到 TUI。

`/resume` 保留当前草稿，在临时选择器中管理会话：

| 操作 | 行为 |
| --- | --- |
| 输入、↑／↓ | 名称搜索、移动选择 |
| Tab | 全部／当前工作区 |
| Shift+Tab | 普通／已归档 |
| Enter | 普通会话接回；已归档会话只读历史 |
| Ctrl+G | 查看记录、普通会话改名、具备资格时归档或恢复 |
| Esc | 返回上一层，保留草稿和阅读位置 |

归档仅在整件工作已结束执行且资源状态已确认时可用；协作成员跟随入口会话。归档不删除内容、不停止任务，也不表示目标完成。已打开的终端被归档后进入只读，原草稿与引用保留；明确恢复后原稿可编辑，另按发送才提交。改名和整理不改变最近内容活动时间。

没有有效 TUI 连接且工作需要用户回来时，系统通知展示会话与实际内容；同一会话更新同一通知位置。接回或归档会撤下通知，实际阅读只确认所见来源，不批准请求、不清除失败事实。旧通知点击仍可在同一个主窗口的会话页查看原文和当前状态；App 离线期间不唤起、不在重开时补发积累横幅。

记录库按实际结构初始化，自动补齐新增字段与表，保留已有记录，不以 schema 版本号阻止打开。无法安全补齐的结构会报错，不删除或重建用户记录；开发验证使用隔离数据库。

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
    { "switch": { "choice": "spell" } },
    "刚才那个文件还在吗"
  ],
  "decisions": ["approve", { "decision": "approve", "remember": true }]
}
```

- `inputs`：按序走的步骤——**裸字符串**＝一条交代（等它收束再走下一步）；
  **`{ "switch": { "choice"?, "reasoning"? } }`** ＝会话中途换模型（与 `/model` 同一条链）；
  **`{ "input": { "text", "skills"?, "ref"? } }`** ＝一整份结构化交代（U33：技能随这次交代
  绑定、`ref` 是提交的配对键——回执按它配对）。
- `decisions`：裁决答复按询问次序取（用尽＝批准）；对象形带 `remember` ＝**「总是允许」**
  （本会话同类不再问）。

## 质量闸与守护

- **提交前自动跑**——`.githooks/pre-commit` 执行 `check:commit`（类型检查、结构守护和快速回归），经 `bun install` 的 prepare 装配 `core.hooksPath`。
- **校验对象＝暂存内容**——闸把暂存区物化到临时目录，按暂存锁文件离线安装依赖；workspace 链接也指向暂存树，未暂存源码与未跟踪草稿不参与。缓存不足或依赖清单与锁文件不一致时拒绝提交，先核对并运行 `bun install` 准备依赖。
- **合并前全量回归**——`bun run check` 始终包含全部 TS 测试；PR 检查执行全量 TS 与原生检查。直接合并也须在最终内容上完成相应检查，不能用提交门禁代替。
- **分类就近维护**——普通 `*.test.ts` 属于快速回归，`*.integration.test.ts` 属于集成，`*.e2e.test.ts` 属于端到端；同文件混合层级按职责拆分。开发时先跑改动相关测试，涉及进程、协议或用户路径即补对应集成或端到端检查。
- **规范正本**——Obsidian「Magic」的 `Magic Code/设计/技术/架构与边界.md`「代码治理」规定包内职责、拆分判据与测试价值；不按文件行数或测试数量机械拆删。
- **覆盖范围＝入库目录**——仓库级守护在 `test/`，包级测试在 `packages/<pkg>/test/`；`playground/` 是试跑区，内容不参与（见 `bunfig.toml`）。
- **仓库级守护**（`test/scaffold.test.ts`）按面分：
  - **依赖纪律**——`src/**` 只许 `@magic/contracts`（＋许可外部库：模型域 → AI SDK · 外壳 → Ink / React）；**`test/**` 额外许可 `@magic/faux`**（`dependencies` 与 `peerDependencies` 同受生产面约束）。
  - **fs 直触**——只许记录域与执行域；扫描面＝**域包** `src/`（外壳 · 装配根 · 测试层不在此列——装配根读配置是设计明写的事）。
  - **blobs 落点唯一** · **契约包零运行时依赖** · **包表完备**（新包落地须登记）· **公开面只出 `.`**。

> 建仓：2026-09-16（规划侧）。
