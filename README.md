# Magic Code

软件工程智能体工具——TUI 起步、单机闭环（首站）。

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
| `packages/contracts` | 共享语言（事件 · 条目 · 控制面 · 配置 · 标识）＋ 跨域端口；**纯类型、零运行时依赖** |
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

## 常用命令

```sh
bun install            # 装配依赖（prepare 顺带配置 git 钩子）
bun run magic          # 起外壳（TUI）——装配 → 接控制面 → 一屏
bun run magic --check  # 装配自检（配置来处 · 数据落点 · 工作区根 · 会话 · 模型；不打印 key）
bun run magic --script <文件>   # 无人值守跑一段脚本，打印事件轨迹
bun run check          # 质量闸：typecheck + test
bun run typecheck
bun test
```

## 质量闸与守护

- **提交前自动跑**——`.githooks/pre-commit`，经 `bun install` 的 prepare 装配 `core.hooksPath`。
- **校验对象＝暂存内容**——闸把暂存区物化到临时目录再跑，故「暂存到坏版本」会被拦下，未跟踪的本地草稿不会误拦。
- **覆盖范围＝入库目录**——仓库级守护在 `test/`，包级测试在 `packages/<pkg>/test/`；`playground/` 是试跑区，内容不参与（见 `bunfig.toml`）。
- **仓库级守护**（`test/scaffold.test.ts`）按面分：
  - **依赖纪律**——`src/**` 只许 `@magic/contracts`（＋许可外部库：模型域 → AI SDK · 外壳 → Ink / React）；**`test/**` 额外许可 `@magic/faux`**（`dependencies` 与 `peerDependencies` 同受生产面约束）。
  - **fs 直触**——只许记录域与执行域；扫描面＝**域包** `src/`（外壳 · 装配根 · 测试层不在此列——装配根读配置是设计明写的事）。
  - **blobs 落点唯一** · **契约包零运行时依赖** · **包表完备**（新包落地须登记）· **公开面只出 `.`**。

> 建仓：2026-09-16（规划侧）。
