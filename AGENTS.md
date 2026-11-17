# AGENTS.md

本文件只放跨任务、高频、会影响正确性的常驻约束；完整规则见 `rules/分支维护与研发流程.md` 与 `rules/TESTING.md`。

## 流程

- `main` 是核心分支与发布基线；短分支从 `main` 切出，提交先合 `develop` 验证，通过后合 `main`；发布 tag 打在 `main`。
- 合并、推送、发布等对外或不可逆动作先确认；分支内提交自主。
- 提交信息用 `<类型>(<范围>): <结果>`；一个提交只做一件事。

## 门禁

- 提交前跑 `bun run typecheck` + `bun run test:fast`（pre-commit 自动跑 `check:commit`）。
- 合并前跑 `bun run check`；Swift／原生／打包改动加 `bun run check:macos`；发布前跑 `bun run check:all`。
- CI 只在 PR／手动触发；直接合并 `main` 时在本地补跑完整门禁。
- 新工作树先 `bun install`；新增 workspace 包后 `bun install --force`。

## 安全与隔离

- 测试使用临时目录、沙箱 HOME、合成配置与假 key；真实 `~/.magic`、用户实例、真实配置与系统设置保持只读。
- 清理进程按本任务 PID；用户实例与归属不明资源保留。
- 提交内容只含本次变更的代码与测试；`.artifacts/`、`.ui-runs/`、临时诊断留在本地。

## 产品行为

- 显示与请求解析使用同一来源；兜底值在界面标出来源。
- 保存／选择阶段允许先配置后校正；请求前对明确不支持的能力说明具体原因。
- 官方支持提示表只记录已核实事实；未核实能力按兜底处理并显示来源。
