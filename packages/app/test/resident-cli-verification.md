# resident-cli 局部验证与稳定交接

日期：2026-09-26。工作树：`/Users/jamie/namespace/github/magic-code-resident-app`，分支：`feat/resident-macos-app`。这是共享脏工作树上的 CLI 局部结果，不代表全局矩阵或正式 App 发布验收。未提交、推送、合并或清理工作树。首轮冻结后按 root 新派发补齐 U42；最新冻结包含下文 U42 追加验证，native helper 需用这版 CLI 重建。

## 冻结结论

**最终没有 render 自动 ack。** 临时加入的 `run/attention-presentation.ts`、对应单测及 terminal 接线均已撤除，没有 no-op 或替代焦点猜测。真实 PTY 渲染、current frame、hello 汇总、history 接回和普通查询均不构成可靠在场证据，done / failed / needs-you 全部保持未读。`ManagerClient.markRead(ids)` 仅保留明确具体 ID 的显式端口；App 明确展开事项仍由主线的 `native.read` 处理。已读与批准是不同动作。

CLI 的旧 detached 管理者启动路径已删除。主动产品入口 `magic` 与 `--script` 连接 App；允许打开 App 的路径只调用 `/usr/bin/open` 加真实所属 App 的绝对路径，不加 `-n`。`--help` / `--version` / 离线 `--check` 不启动 App；状态读取、失联和被动重连不启动 App。源码模式必须有同来源的显式原生宿主，不另开后台兜底。

`--check` 保留项目规约、技能、权限与授权的本地只读诊断，不装配执行者、模型或 MCP 连接。无执行者时七类目录查询使用共享纯读产出，不建 Session、不改变未读。

U42 追加修复：`--check` 复用模型域已有的纯 `resolveApiKey`，诊断本次实际选中供应商的缺 key；缺失返回 1，指明实际配置路径和对应环境变量。环境回退有效时不泄露 key；未选中的备用条目不阻断检查。不为诊断构造网关。

## 稳定接口

| 出口 | 约定 |
| --- | --- |
| `connectApp(options)` / `reopenApp(options)` | 默认只观察；主动入口显式传 open，reopen 是明确动作。返回 client、已选实例配置与 discovery。重开先核原 base/dataDir，再发送 hello/session。 |
| `locateHost` / `readHostDiscovery` / `selectedHostConfig` | executable realpath 定位 bundle；正式与 Dev 分开发现路径；source/version/protocol/App/base/dataDir/宿主与服务代次校验；stale 文件不视为在线。 |
| `ManagerClient.onDetached(listener)` | 只表示 executor 已核销，与管理者连接关闭分开。gen 可为 null，真实 selected Session 保留。 |
| `ManagerClient.markRead(ids)` | 非空具体 ID 才发送 `t:read`；握手、汇总、查询和渲染均不自动调用。 |
| `terminalConnection(initial, reconnect, openingSession?)` | 稳定 client 门面与 `reopen(): Promise<void>`；保留 Shell、草稿与订阅，按当前真实 Session 握手，隔离旧 client 消息；关闭中的迟到连接会被关闭。 |
| `query(command, context)` | 返回真实 `KernelEvent` 或 `undefined`。覆盖 model / provider / skills / paths / grants / mcp / attachments 的 list；动作不冒充观察。MCP 使用主线传入的真实 catalog。 |
| `publishHostDiscovery(path, value)` | 测试夹具共享的原子发布器，`cliGround.publish` 与 core-tests 的 `resident-host-fixture` 复用。 |

hello 传协议、版本、软件来源及可选 `openRequest` UUID；welcome 核对 identity 与 dataDir。line 后 close 的拒绝保留具体缘由，不当作普通离线再次打开 App。初始 ev/target 缓存至 UI 订阅；history 后立即关闭仍回放已收到的事实，不造假 Session。执行环境只传必要白名单，不传播整份环境或凭据。

未显式设 `MAGIC_HOME` 时采用 App 已选 base，base 已含 `.magic`，不再拼一层。显式设置沿原 resolve 规则规范化，再比对 App 实例；不同则列明双方差异并失败。脚本沿同一 App 连接执行；工具中间 `turn.end.continues=true` 不算完成，等待最终终态。

## 最终局部检查

| 检查 | 实际结果 | 归档日志 |
| --- | --- | --- |
| CLI / discovery / client / observation / script / 三类未读真实 PTY，6 文件 | 55 pass，0 fail，314 断言 | `logs/current/resident-cli-focused-final.log` |
| 撤自动 ack 后 run-terminal 整套，含 U53 新帧 | 6 pass，0 fail，40 断言 | `logs/current/resident-run-terminal-after-withdrawal.log` |
| rules 真 CLI `--check` 原三项 | 3 pass，0 fail，13 断言 | `logs/current/resident-cli-rules.log` |
| model / catalog / skills / attachments / grants / MCP / records 相关回归，10 文件 | 144 pass，0 fail，609 断言 | `logs/current/resident-catalog-regressions-final.log` |
| `bunx tsc --noEmit` | exit 0，无诊断 | `logs/current/resident-cli-typecheck-final.log` |
| 所有权文件 `git diff --check` | exit 0，无诊断 | `checks.json` |
| U42 + CLI + observation 定向复验，3 文件 | 38 pass，0 fail，237 断言 | `u42/logs/resident-cli-u42-final.log` |
| U42 追加后的 `bunx tsc --noEmit` | exit 0，无诊断 | `u42/logs/resident-cli-u42-typecheck.log` |

55 项组合命令：

```sh
bun test packages/app/test/cli.test.ts packages/app/test/host-discovery.test.ts packages/app/test/run-client.test.ts packages/app/test/observation.test.ts packages/app/test/cli-script.test.ts packages/app/test/resident-cli-presentation.test.ts
```

最终 PTY 命令：

```sh
MAGIC_CLI_EVIDENCE=/tmp/magic-resident-cli-evidence/after-ack-withdrawal bun test packages/app/test/run-terminal.test.ts
```

三类未读测试在真实 stdin 测试宿主、真 PTY 和真实 records.db 上执行。最新原件为 `/var/folders/5t/cwtq02916lb62n1848znbw5h0000gn/T/magic-resident-cli-evidence/presentation-5b14a09a-8eb6-4cfe-9d25-c2d3c631ffce`。归档 `pty/current/` 保留 raw.bin、步骤、帧、run.json、合成数据库快照、事项 JSON 和宿主退出事实。

## 实际反例与红绿关系

- **U42 新派发的五红：** 本责任复现 1 pass / 5 fail；前三项旧自检开库断言改为读取真实新配置、指定数据目录、授权 1 条（旧树 2 条）和新技能，并比较两棵树及数据哨兵的路径、mtime、SHA，确认没有写入或尝试打开哨兵数据库。缺 key 的生产漏诊修复后仍 exit 1 且点名实际文件，补本次供应商切换与环境 key 回退反例。脚本改用现成同来源 stdin 宿主；实库核对唯一会话、用户原文与 assistant 答复，客户端 history 摘要为 2 条，老树未写。中间复验 37 pass / 1 fail 是旧 stdout 数据库路径断言，改由更直接的数据库内容与历史摘要断言后 38 pass / 237 断言全绿。U42 原始红、过渡红和最终绿均在 `u42/logs/`。
- **旧 assistant / 多个 done / 空答轮：** headless 先完成一个有正文轮和一个空答轮，形成两个 done；hello、history 原始查询和真 PTY 历史接回后两项仍未读。再次真实显示新正文后，三个 done 全部未读。不能以历史 assistant、时间、Session 或任意渲染猜具体事项已看。
- **当前裁决卡：** 真实出现 `y / n`，needs-you 仍未读；数据库 `tool.decision` 为 0，模型请求未因呈现继续，显示不等于批准。Ctrl+C 收掉卡后保留事项事实。
- **真实失败：** loopback 夹具返回 HTTP 400，PTY 显示模型错误，failed 仍未读；最终数据库三类全部 unread=true。
- **已撤销的错误实现：** 两次旧 PTY 曾把实时 done / 当前 needs-you 标读。旧 `resident-cli-final.log` 的 57 pass / 319 断言和旧呈现 1 pass / 8 断言仅说明当时错误判据通过，不能作最终绿证据。原件保留在 `pty/superseded-auto-ack/`，日志在 `logs/superseded-auto-ack/`，用于解释为何必须撤掉自动 ack。原 U86 三类未读强断言已通知 core-tests 保持并复验；其最终结果归该负责人报告。
- **离线诊断遗漏：** `resident-catalog-regressions.log` 实际 134 pass / 2 fail，暴露 `--check` 丢失技能发现诊断；已恢复共享纯读目录，后续 144 pass / 609 断言。项目规约三条原判据由 root 报红，本责任恢复原 rules 读取与描述，3 pass / 13 断言；没有复制 root 全局日志冒充本责任原始记录。
- **U53：** `resident-run-terminal.log` 实际 5 pass / 1 fail，用户首句没有落在恢复记录区。主线修复页头/历史重建后，本责任完整回归最终 6 pass / 40 断言，保留新帧；没有通过减弱原判据放绿。
- **连接边界：** 主动入口在服务缺席时只打开明确 App；passive/stale 只失败不打开。source/version/dataDir/代次不匹配及 line 后关闭均保留具体错误；重开实例变化在 hello 之前拒绝。旧 TUI 断连不自动打开，显式 reopen 保留草稿并隔离旧连接事件。
- **脚本多轮：** 两个真实工具轮与最终文本，终态 continues 序列为 `[true, true, false]`，实际三次模型请求、两条工具结果和最终正文落账。不是收到第一个中间轮就提前结束。

## 归档与进程核查

归档位置：`/Users/jamie/Library/Mobile Documents/iCloud~md~obsidian/Documents/Magic/Magic Code/验证/常驻App与状态栏/cli/`。只复制本责任已存在日志和合成沙地证据，原件不移动、不删除。`manifest.json` 记录原路径、归档相对路径、字节数与 SHA-256；`source-freeze.json` 记录本责任源码和测试冻结时的内容摘要，不把共享脏树写成新提交。

首轮 331 项归档保持原样；U42 追加材料在 `u42/`，其 `manifest.json`、`source-freeze.json` 与文档副本描述最新冻结，避免覆盖首轮原证据。本轮生产只补 CLI 的纯 key 诊断；已提前告知 root 重做 native helper 构建。

配置均为 loopback 和明确假 key；没有复制用户配置、真实密钥或完整环境。旧错误判据单独归档，不与最终证据混用。文档副本只写本归档目录，不更新全局矩阵或其他规划目录。

`process-audit.json` 对已留存的 16 份宿主 PID、sandbox、`host.stopped` 和 exit code 逐一核查，结合当前 PID/PPID 祖先链及进程命令/cwd 检查本责任路径。全部宿主已有 exit 0 与 stopped；未发现对应存活进程或仍存在的运行沙地，因此未发送任何终止信号。PTY 原记录没有单独保留 CLI 子 PID，保留其 close/exit 事实并按所属 sandbox 补查；不声称掌握已经退出进程的完整历史祖先链。脚本测试通过 `child.exited` 和 `host.close()` 等待收尾。未停止、清理任何其他开发者或用户进程。

U42 两次脚本复验另留两份宿主证据，均 exit 0 + stopped；追加 PID 与 sandbox 核查见 `u42/process-audit.json`，不扩大为其他开发者的全局进程清理。

## 最终修改文件清单

以下为本 CLI 责任及已明确扩展的纯读复用面；共享文件只认领相应提取接线，不回退他人修改。

- `packages/app/src/cli.ts`
- `packages/app/src/run/client.ts`
- `packages/app/src/run/host-discovery.ts`（新增）
- `packages/app/src/run/observation.ts`（新增）
- `packages/app/src/run/spawn-manager.ts`
- `packages/app/src/run/terminal.ts`
- `packages/app/src/assembly.ts`（共享纯读 catalog 接线）
- `packages/model/src/model-info.ts`（纯 peek 与预算 helper）
- `packages/model/src/registry.ts`（提取原 selectModel 判定）
- `packages/model/src/index.ts`（必要出口）
- `packages/conversation/src/sessions.ts`（readAttachmentCatalog 纯读提取）
- `packages/conversation/src/index.ts`（必要出口）
- `packages/records/src/store.ts`（decisionHistory 可选 workspace 沿原 SQL 扩展；此前注意事项持久化另有原报告）
- `packages/app/test/cli.test.ts`
- `packages/app/test/magic-home.test.ts`（U42 新授权接管）
- `packages/app/test/run-terminal.test.ts`
- `packages/app/test/host-discovery.test.ts`（新增）
- `packages/app/test/run-client.test.ts`（新增）
- `packages/app/test/observation.test.ts`（新增）
- `packages/app/test/cli-script.test.ts`（新增）
- `packages/app/test/resident-cli-fixture.ts`（新增，共享发现发布器）
- `packages/app/test/resident-cli-presentation.test.ts`（新增，最终只验三类未读）
- `packages/app/test/resident-cli-verification.md`（本文件）

临时新增后已删除、最终不存在：`packages/app/src/run/attention-presentation.ts`、`packages/app/test/attention-presentation.test.ts`。manager / native / contracts / TUI / 通用 UI driver 由其各自负责人持有，本责任未接手。

## 未测边界与交接状态

- executable realpath、bundle 身份与 `/usr/bin/open` 参数以受控临时 bundle 和调用接缝验证；没有在用户安装的正式签名 App 上执行 Finder / LaunchServices 全链路验收，也未操作用户 CLI 链接、登录项或系统通知。
- `--open-request` 已验证到 hello 参数与身份边界；原生 Terminal.command → Terminal.app → native.attached 的整条 UI 链由原生/主线负责。
- 终端可靠焦点没有证据，因此最终没有任何终端自动已读能力。App 明确展开的 native.read、系统投递与未读持久化全局验收由相应负责人报告。
- MCP 目录 query 只读主线提供的真实 preflight 元数据；本责任没有重复外部 MCP 服务全矩阵或正式网络供应商验收。
- 全量 bun test、U86/U98 核心矩阵和新通用 driver 验收不归此局部报告；core-tests 改 driver 时复用共享发布器，显式宿主的 run-terminal 不双起宿主，本责任只提供事实协调。
- U42 修改了编入 native helper 的 CLI；源码定向绿不等于已重建并验收 helper，重建与可引用核心 Git 提交由 root 负责。

以上接口与最终未读语义冻结。报告和本责任归档完成后保持原 worktree、原分支 idle，后续全局矩阵、最终回报与 Git 操作由 root 统一负责。
