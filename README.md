# Magic Code

软件工程智能体工具——TUI 起步、单机闭环（首站）。

## 开发

- **规划材料**（外部）：Obsidian「Magic」工作区 · `Magic Code/交接/`——材料清单（读什么）· 进度台账（当前开发项）· 回报（完成或卡住写回 `<单元号>.md`）；开工第一动作＝对表。
- **工作分解**：单元 · 契约 · 并行切分 · 集成顺序——开发以此为基准，自 U01 起。
- **`playground/`**：试跑区——给 Agent 练手的临时目录，内容不入库。

## 仓库结构

Bun workspaces 分包，依赖单向 `kernel` ← `tui` ← `app`（越界由 `test/scaffold.test.ts` 拦截）：

| 包 | 职责 |
| --- | --- |
| `packages/kernel` | 内核——主循环 / 工具 / 权限 / 上下文 / 记录 / 事件 / 模型接缝；零外壳依赖、不直碰文件系统 |
| `packages/tui` | 外壳——渲染组件库；只经控制面接口 + 事件订阅使用内核 |
| `packages/app` | 装配与入口——可执行名 `magic` |

## 常用命令

```sh
bun install      # 装配依赖（prepare 顺带配置 git 钩子）
bun run check    # 质量闸：typecheck + test——提交前由 .githooks/pre-commit 自动跑
bun run typecheck
bun test
```

> 建仓：2026-09-16（规划侧）。
