# AGENTS.md

本文件只放跨任务、高频、会影响正确性的常驻约束；完整规则见 `rules/分支维护与研发流程.md` 与 `rules/TESTING.md`。

## 流程

- `main` 是核心分支与发布基线；短分支从 `main` 切出，提交先合 `develop` 验证；验证通过后保持验证线，按明确的收束指令合 `main`；发布 tag 打在 `main`。
- 合并、推送、发布等对外或不可逆动作先确认；分支内提交自主。
- 版本线建立不等于发布；用户未明确要求发版／打 tag 时，不主动建议或执行合入 `main`、打 tag、发布。
- 提交信息用 `<类型>(<范围>): <结果>`；一个提交只做一件事。

## 门禁

- 提交前跑 `bun run check:commit`（typecheck + check:imports + test:fast；pre-commit 自动执行）。
- 合并前跑 `bun run check`（含 check:imports）；Swift／原生／打包改动加 `bun run check:macos`；发布前跑 `bun run check:all`。
- 大范围回归（多文件、目录、全仓）**必须带 bun 原生并行参数**：`bun test --parallel <路径>`（文件级 worker，缺省按核数）——这是执行的底线，不是推荐。推荐走自带结果落盘的入口：`bun run check`（全量）/ `test:integration` / `test:e2e`，JUnit 与日志落 `.artifacts/test-results/`，失败定位先读落盘记录。不带 `--parallel` 的多文件运行属于执行错误，其结果不作为合入或合并的结论。
- CI 只在 PR／手动触发；直接合并 `main` 时在本地补跑完整门禁。
- 新工作树先 `bun install`；新增 workspace 包后 `bun install --force`。

## 安全与隔离

- 测试使用临时目录、沙箱 HOME、合成配置与假 key；真实 `~/.magic`、用户实例、真实配置与系统设置保持只读。
- 清理进程按本任务 PID；用户实例与归属不明资源保留。
- 提交内容只含本次变更的代码与测试；`.artifacts/`、`.ui-runs/`、临时诊断留在本地。

## 外部调研材料

- 2026-11-24 为「会话标题生成」调研克隆的外部仓库在本仓库上级目录 `~/namespace/github/magic/` 下（浅克隆）：`codex`、`opencode`、`gemini-cli`、`goose`、`cline`、`aider`。
- 同目录 `claude-code-research/` 放 Claude Code 调研材料：反编译产物 `cc-cli.js` 与逆向笔记 `cc-arch.md`。
- **用户没有明确提及的话不要读取**以上材料；不纳入本仓库的门禁与操作。

## 产品行为

- 显示与请求解析使用同一来源；兜底值在界面标出来源。
- 保存／选择阶段允许先配置后校正；请求前对明确不支持的能力说明具体原因。
- 官方支持提示表只记录已核实事实；未核实能力按兜底处理并显示来源。
