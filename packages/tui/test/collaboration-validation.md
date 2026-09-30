# 协作 TUI/control 局部验证

2026-09-26，分支 `feat/multi-agent-collaboration`。本记录区分局部 TUI 夹具和后续真实 manager/socket/executor 回环；两类均使用受控模型响应，不代表真实模型行为或常驻 App 已验收。

## 生产 hangUp 接缝补测（c78a3d3 接入后已绿验）

用户再次授权的范围仅为 `run-collaboration.test.ts`、必要现有 fixture 和本记录。新增一条相邻真实回环，未修改 fixture、app/src、stop 测试或 resident-cli 独占的生产/单测文件。原 no-TUI 两案关窗前入口已 idle；本案先让成员真实 `agent_message send inform` 唤起入口，确认原 wait 仍 waiting、入口第三次实际 HTTP 处于受控屏障且 shell 为 working，再调用生产 `shell.hangUp()`、关闭真实 socket。

窄跑结果 **0 pass、1 fail、4 expectations（13 filtered out）**。在全部连接为 0、原入口已有真实 onExit 且 executor 已移除之后，断言取得：

| 事实 | 预期 | 修复前实际 |
| --- | --- | --- |
| `hangUp()` 返回 | `{ exit: true }` | `{ exit: false }` |
| 关窗产生的 command | 无 | `turn.interrupt` |
| 持久协作状态 | `open` | `stopped` |
| 原持久 wait | `waiting` | `interrupted` |

失败证据独立保存在 `.ui-runs/collaboration-hangup-before-fix/no-tui-hangup.json` 和同目录 `test.log`；原日志 `/tmp/magic-collaboration-hangup-before-fix.log`。入口 HTTP 恰 3 次、成员 2 次，两执行者均真实退出，HTTP fixture 无错误。该证据在测试清理前读取并断言协作/wait 状态，停止事实不是 finally 清理造成的。

```sh
MAGIC_COLLAB_RUN_EVIDENCE=.ui-runs/collaboration-hangup-before-fix bun test packages/app/test/run-collaboration.test.ts --test-name-pattern '生产 shell.hangUp'
```

失败发生在释放成员 clarify 之前。测试已保留后续强断言：关窗后 wait 必须仍 waiting，成员回应使同一宿主启动不同 gen/PID 的无窗口入口，第四次 HTTP 带入澄清原因，deadline 未到且 wait 已领取，最终正文落库、新代入口真实退出，无额外模型请求。主会话接入稳定提交 `c78a3d3ddcd8077000d43e002714e9c6b82d69f1` 后，沿同一强断言绿验：**1 pass / 0 fail / 18 expectations**。`hangUp()` 放行客户端退出且不发中断，wait 保持 waiting；成员澄清随后唤回同宿主新 gen/PID 入口，HTTP 总计 4 次，最终正文落库并真实退出。正证据位于 `.ui-runs/collaboration-integration/no-tui-hangup.json` 与 `hangup-after-core.log`；原负证据独立保留。

这是**生产 shell.hangUp 组件出口 + 真实 manager/socket/executor + 本地受控 HTTP** 的回环；沿用 no-TUI 的生产 `allowAll` 条件，不代表真实 PTY SIGHUP、完整终端关窗或 App 包验收。窄测试负责人仅新增测试并回交；主会话负责稳定补丁整合及最终暂存快照质量门。真实终端 EOF/SIGHUP/SIGTERM 的上游证据随 c78a3d3 交付，本案仍只按这里的组件与真实进程范围描述。

## 47941ea 整合后（hangUp 补测前基线）

- `shell.ts` 冲突保留常驻连接就绪约束与协作审批去重。入口 detached 仅撤本入口失效审批，成员审批仍可答复；宿主整体退出才撤全部失效审批。现有目标、草稿、引用、阅读位置与只读 selectedSession 接回继续保留，没有修改 stop/cancel 或增加 UI 入口。
- 专用 fixture 改用新版 `terminalOptions.transport`、`expectedIdentity: manager.identity`、连接环境白名单入口和 `onGone → shell.hostGone`。会话切换测试忽略 onTarget 的订阅回放，随后以真实新 `target(null)` 作为新代接入边界，不把它误作尚未切换。
- TUI/control/scaffold：**961 pass、0 fail、16 snapshots、3447 expectations**。真实协作三文件：**15 pass、0 fail、223 expectations**。类型检查通过；本轮没有修改 app/src。
- 新增 no-TUI clarify/reject 两条：全部 TUI 与 socket 连接关闭，入口真实 onExit 且 executor 已移除，原 wait 仍持久有效；成员响应让同一 manager 身份启动不同 gen/PID 的入口。下一实际 HTTP 带入回应原因，等待已领取且未过 deadline，入口最终正文落库并再次真实退出；入口 HTTP 恰为 3 次，期间一直没有 TUI 连接。
- no-TUI 专用用例显式启用生产 `allowAll`，只放行受控协作工具，关闭窗口后没有隐藏审批客户端。这证明无人连接时的同宿主唤回，不代表无人值守审批验收。其余审批用例保留真实 permission gate。
- 原显式 close 强断言通过：收到 closed 的每一个采样点，原入口和成员均已有真实 onExit 回执，活跃 executor 为空；最终正文与关闭后完整记录查询也通过。旧提前 closed 与旧 reject 分类失败证据原样保留。

本轮日志：`/tmp/magic-collab-resident-local-tests.txt`、`/tmp/magic-collab-integration-tests.txt`、`/tmp/magic-collab-resident-typecheck.txt`。真实 HTTP/socket/退出证据写入独立目录 `.ui-runs/collaboration-integration/`，包含新增 `no-tui-clarify.json`、`no-tui-reject.json`、`window-detached-decision.json` 与其余场景。

## 本轮出口

- `collaboration.view` 为瞬时事件；control 保留五类协作命令的 member、delegation、shared、input.ref/refs 与模型配置。装配可通过 `ControlRoutes.onCollaboration` 接入。
- 真实分工后才显示摘要。成员运行、待答、等待、阻塞共同决定显示，入口空闲或全员空闲不等于完成。
- 执行者已退出、runtime 缺席时仍按既有 suspended 身份显示“执行中断，待处理”；根协调中断在整体摘要可见。closed 摘要只显示已收尾，成员历史拒绝仍保留在详情，不再作为当前受阻前置。
- Tab 或当前会话详情进入协作。沿既有选择器层栈看成员、完整对话/工具、关联讨论再返回；浏览不切输入目标，不复制全员日志到整体。
- 显式选择整体或成员输入，各自保留草稿、引用、光标和输入历史；记录页保留阅读位置。失败 `input.settled` 按原 ref 归还原目标，不能覆盖另一个目标的草稿。
- 成员停止再点名具体 delegation；整体停止与继续有明确入口。审批显示成员和操作原因、按唯一请求排队去重，裁决后返回原阅读位置。
- 模型/思考设置复用现有选择器；成员配置与后续派生默认分开。刷新目录保留配置作用范围。
- 第二个窗口接回时允许协作快照先于会话状态到达；过滤成员事件以原入口身份判断，避免把尚未初始化的窗口误认成另一位成员。

U100 不作为前置，也没有等待、复制或吸收其实现。本轮未改 Ctrl+C 逻辑，停止通过上述明确菜单完成；不把现有 Ctrl+C 宣称为协作三选已验收。

## 验证

| 检查 | 结果与边界 |
| --- | --- |
| `bun run typecheck` | 全仓通过；同伴测试的中间类型错误已由主会话修正 |
| `bun test test/scaffold.test.ts packages/tui/test packages/control/test` | 整合后 961 pass、0 fail，16 snapshots、3447 expectations；含协作 17 项，覆盖 suspended/closed 呈现及 detached/hostGone 相邻适配；跨包私有 test 引用守护通过 |
| `git diff --check`（本轮所有权路径） | 通过 |
| README 的 `bun run ui script` 单会话冒烟 | 8/8 步、2 帧；真 cli/装配配合本机受控模型，未展开时无协作区 |
| 既有 `createUiSession` 真 PTY 协作夹具 | 13 帧，100×30 起步后缩到 46×18；真实 Ink/键盘/终端输出，正常 app 退出，无输出截断 |
| 同一装置直接以 46×18 启动 | 2 帧：点名委派、工具记录阅读；正常 app 退出，无输出截断 |
| `run-collaboration.test.ts` + `run-collaboration-wait-control.test.ts` + `collaboration-session-routing.test.ts` | 整合后 15 pass、0 fail、223 expectations；no-TUI 原 todo 已替换为两条实际用例，close 保留并通过原生命周期强断言。真实 manager/socket/独立 executor 子进程，本地受控 HTTP |
| 上述文件 `--test-name-pattern '入口.*唤起语义'` | records 拒绝分类修复后，由主会话复跑 5 pass、0 fail、51 expectations；覆盖原 wait 三项及无 wait reject/accept，日志 `/tmp/magic-collaboration-wake-http.log` 已核对，未运行 close 竞争 |
| `bun test packages/app/test/run-collaboration-wait-control.test.ts` | 1 pass、0 fail、23 expectations；等待期 inform 唤起后 wait 仍 waiting，点名 stop 实际返回工具结果，下一 HTTP 带入该结果并产出最终正文 |

核心整合前的呈现修正仅改 `collaboration.ts`，直接使用已有 reachability/state，没有新增状态或改变 stop/cancel。新增回归先复现三项失败，修正后 TUI/control 全部通过，typecheck 与 diff-check 通过；Ink 帧断言覆盖 46×18 窄窗中断文字及 closed 画面不含当前“受阻”。这是该阶段的局部渲染证据，既有真 PTY 证据继续保留，不把渲染断言写成新增 PTY 验收。

PTY 复现：

```sh
bun run ui script .ui-runs/collaboration-tui/product-smoke.json --out .ui-runs/collaboration-tui/product
bun packages/app/test/frames-collaboration-tui.ts --out .ui-runs/collaboration-tui/final
bun packages/app/test/frames-collaboration-tui.ts --narrow --out .ui-runs/collaboration-tui/narrow
```

证据保存在仓库本地 `.ui-runs/collaboration-tui/`（忽略目录，不纳入源码）：

- `product/20260926T061428-script-协作前单会话保持简洁/summary.json` 与 `product/20260926T061428-控制-app/`。
- `final/result.json` 与 `final/20260926T063306-协作-TUI-契约夹具/`，13 帧、raw.bin 68341 bytes。
- `narrow/result.json` 与 `narrow/20260926T063306-协作-TUI-窄窗夹具/`，2 帧、raw.bin 15319 bytes。
- `boundary-check/20260926T064305-协作-TUI-窄窗夹具/`：将 PTY fixture 改成本包数据后重跑，2 帧、正常 app 退出、无截断。
- `resident-integration/20260926T073526-协作-TUI-窄窗夹具/`：47941ea 整合后重跑，2 帧、raw.bin 15319 bytes、正常 app 退出、无截断；帧已逐项核对点名委派和工具记录。

每个终端目录有 `viewer.html`、`raw.bin`、`steps.ndjson` 与 `frames/*.txt/json`。已通读最终帧：输入目标、审批来源、工具输出、未解决分歧、停止范围与配置作用范围可辨。宽窗缩小时，旧终端滚屏上部会残留重排后的旧文字；因此另留直接窄窗启动的独立帧，本轮不把 resize 残影标成已修复。

## 真实 manager/socket/executor 回环

用户追加授权后新增 `packages/app/test/run-collaboration.test.ts` 与专用 `run-collaboration-fixture.ts`。manager 运行在测试进程，客户端走真实本机 socket，执行者由生产 `createProcessLauncher` 启动独立 `cli.ts --internal-executor` 进程。根 TUI 使用公开 `@magic/tui` 的 shell 和生产 terminal 适配；本地 HTTP 端点仅控制模型响应，不代替宿主/执行者/记录实现。除上文明确的 no-TUI 全放行条件外，协作工具的审批由测试用户明确批准，普通工具仍按真实权限流程等待测试步骤裁决。

| 场景 | 实证 |
| --- | --- |
| 入口让出后 clarify/reject | 先确认持久等待与入口实际 idle，再释放成员 HTTP；一小时 deadline 未到即事件唤回，等待终态已领取，入口请求恰为 3 次，下一请求含成员原因 |
| 普通 accept | 成员完成接受后入口仍仅 2 次 HTTP，等待仍有效；收悉未导致模型空转 |
| 未登记 wait 的 reject/accept | 先确认入口正常正文落库、turn settled、实际 idle 且 waits 为空，再放开成员响应。修复前 reject 已落库且入口 resumed→waiting，但 HTTP 仍只有 2 次；records 修正分类后主会话实跑通过：reject 从 2 次变为 3 次、下一请求含原因且不重复，accept 仍为 2 次 |
| wait 期间 inform 后点名控制 | root spawn→agent_wait 持久化且 idle 后才释放成员 accept/send inform；没有新信息时入口只有 2 次 HTTP。第三次 HTTP 含 inform，暂扣响应期间直接确认原 wait 仍 waiting、deadline 未到、委派 accepted；再返回 agent_control stop 指定 delegation。实际工具结果成功且只涉及该成员/委派，结果原文进入第四次 HTTP，最终正文落库；入口 HTTP 恰为 4 次，控制只执行一次 |
| 成员审批 | 根 TUI 展示成员名和唯一 id；重复快照/通知仍是同一卡；根窗口只发送一次答复，成员在沙地实际执行 chmod，根窗口仍在原会话 |
| 入口 detached 后成员审批 | 先建立整体/成员各自草稿及真实文件引用，成员 chmod 待审批时放入口正文结束；确认入口真实 onExit、executor 消失、根窗口收到 detached。根窗口仍选原会话和成员输入，原审批 id 保留；只读查询不重建入口，根窗口答复只发一次，成员实际 chmod。裁决后成员原稿/引用归还，切回整体仍是原稿，入口 HTTP 保持 2 次 |
| 审批等待窗口追加共同约束 | 成员 chmod 已弹审批卡，根入口发布 shared；确认约束落库且成员 inbox 仍 pending 后批准旧卡。真实批准事件已回成员，旧工具结果为失败，文件仍为 600；下一成员 HTTP 含新约束及重审提示，约束状态为 included |
| 显式正常收尾 | 成员 accept/deliver 后，入口下一 HTTP 含交付结论与验证，再 receive、close。暂扣最终正文 HTTP 时仍为 closing、两个 executor 仍在；放行后最终正文落库，收到 closed 当时两个 PID 均已真实退出。关闭后经原 socket 查询完整 entries/messages 不重建 executor。整合后原强断言通过，旧提前 1 ms closed 的负证据仍保留 |
| 双窗口同名 ref | 两个根 TUI 各从真实候选绑定不同文件后删除沙地文件，同时首发 `draft-1`；各自只收到一份含本窗口文件名的失败回执，成员草稿/引用和整体草稿不串，未新增模型 HTTP |
| 共同补充 refs | 原用户正文及引用位置落账；文件按既有 U63 保留原位引用供模型自读，保存图片的实际字节进入入口和成员下一 HTTP；共同约束来源回指真实 user 条目，双方带入状态可查 |
| 全部 TUI 关闭后的 clarify/reject | 持久等待让出后，关闭所有窗口并确认 manager.clients() 为 0、入口真实退出且无 executor；等待仍 waiting。放成员响应后，同一宿主新 gen/PID 入口的第三次 HTTP 含回应原因，wait 非 expired 且已 handled；最终正文与新代真实退出均确认。没有人工 wake、deadline 触发、第二宿主或额外模型轮询 |

复现并保留实际 HTTP/事件：

```sh
MAGIC_COLLAB_RUN_EVIDENCE=.ui-runs/collaboration-integration bun test packages/app/test/run-collaboration.test.ts packages/app/test/run-collaboration-wait-control.test.ts packages/app/test/collaboration-session-routing.test.ts
```

无 wait 语义修复后的局部复验（不触发 close 竞争）：

```sh
MAGIC_COLLAB_RUN_EVIDENCE=.ui-runs/collaboration-manager bun test packages/app/test/run-collaboration.test.ts --test-name-pattern '入口.*唤起语义'
```

新增证据为 `no-wait-reject.json`、`no-wait-accept.json`，修复前 reject 失败独立保留为 `no-wait-reject-before-semantic-fix.json`。测试通过真实 manager/socket/生产 executor，只控制本地 HTTP；没有向宿主人工补 wake，也没有直接写 records。响应后短观察窗口只检查额外模型请求，不作为唤起触发。测试实现已交回主会话；records 负责人修正 reject 语义后，主会话按上述过滤完成五项复验，并保留本地 manager HTTP/事件证据。

等待期控制回环独立放在 `packages/app/test/run-collaboration-wait-control.test.ts`，初次交付时只读复用既有 fixture，未改共用 fixture、原回环测试或生产代码。初次复现命令：

```sh
MAGIC_COLLAB_RUN_EVIDENCE=.ui-runs/collaboration-manager bun test packages/app/test/run-collaboration-wait-control.test.ts
```

证据为 `.ui-runs/collaboration-manager/wait-inform-control.json`，日志 `/tmp/magic-collab-wait-control-tests.txt`，typecheck 与 diff-check 通过。这条只证等待不会吞掉协调控制、没有额外模型轮询；工具返回成功与委派 cancelled **不作为资源退出确证**，旧 manager 的 socketclose/retire 竞争仍由原 close 案及 App 稳定接口处理。本次没有重跑 close、全量测试或 PTY。完成材料后，新测试实现所有权回交主会话并冻结写入，宿主吸收后的共用 fixture 变化由主整合。

证据为 `.ui-runs/collaboration-manager/{wait-clarify,wait-reject,wait-accept,member-decision,approval-shared-constraint,explicit-close,member-input-ref,shared-input-refs}.json`，标记 `real-manager-socket-executor-controlled-http`。双窗口证据分别保留各连接的 commands/events；真实启动器的退出回执保存在 `processExits`，收到 closed 时的活跃/已退出 PID 保存在 `closedViews`，每例夹具清理后 `remainingExecutors=[]`。

首个发送方消息被错误计入 consumed inbox 的问题已交主会话修正。新增收尾竞争独立保留在 `explicit-close-before-process-exit.json`：closed 时 `livePids=[]`、仅成员 PID 73366 已确认退出，入口 PID 73346 的 onExit 晚 1 ms。定位为 manager 的 socket 断开直接 `retire`，并在其中提前完成 `stoppedWaiters`，导致 `cancelMembers` 未等真实 onExit 就返回。已通过 Herdr 交主会话；测试保留失败断言，不能等迟到 onExit 再判 closed 成功。本测试任务没有修改 manager 或其他 app/src。

该竞争在核心整合前记录为 **expected 未闭合**，当时没有使用 `test.failing`、跳过或放宽验收。用户叫停重复竞争验证时已有的一轮执行已结束（8 pass、1 todo、116 expectations）；单轮通过没有撤销已抓到的失败。47941ea 整合后，主会话先以 1 pass/27 expectations 验证原 close 案，本会话完整协作组再次通过同一强断言。完整记录断言仍先核对最终正文、工具结果与原 socket 查询，最后按收到 closed 当时的退出回执裁决；未加入延时等待来掩盖次序错误。

### 停止与迟到交付待接场景

以下只设计真实宿主场景，尚未执行；继续复用本文件的同一 manager/socket/生产 executor 和本地 HTTP。records 已有的并发测试不替代这些宿主证据，也不通过直接写 records 或另造宿主补齐。

| 场景 | 触发与屏障 | 必须核对的事实 |
| --- | --- | --- |
| 整体 stop 与后代 spawn 并发 | 入口派生 A、A 已 accept；受控 HTTP 暂扣 A 的派生 B 响应，与根 TUI 的整体 stop 竞争释放。以真实派生持久结果区分 stop 前已准入或 stop 后被拒，不固定哪方先赢 | 若 B 已准入，资源回收包含入口、A、B；否则不能遗留 B 身份对应的执行进程。stop 持久准入墓碑生效后无新工作调用，最终全部执行者有真实退出及自有资源回收确认，等待已中断。单有 `state=stopped` 或活跃表清空不足以证明回收完成 |
| stop 后才返回的旧模型工具请求 | 成员 accept 后暂扣下一 HTTP 响应；根 TUI stop 已持久生效后再释放旧 `agent_message deliver` 响应 | 已取消的 HTTP 可以被直接丢弃；若工具继续到达准入点，必须被拒。不得由这份旧响应重启执行者或产生新模型请求，原委派保持 cancelled。这只能证明旧模型响应不能继续执行，不能冒充“已发出的交付 RPC 迟到” |
| stop 前已发出、stop 后才处理的交付 | 需要稳定 App 接口下可观测的真实在途交付请求：已绑定成员身份且确实从 executor 发出，stop 先持久生效，再由同一宿主收完原通道。不用新连接伪造成员、不直接调用 actions/records 注入交付 | 若原请求仍有效并被保存，delivery 必须挂回原 delegation、原 sender，结论/产物/验证/未解决项完整可读；delegation 保持 cancelled，协作保持 stopped，迟到结果不能自动 receive、恢复工作或唤起入口模型。若通道已取消且没有受理，记录应如实没有交付，不能宣称该次验证覆盖了迟到保存 |

以上最终停止竞争由用户指定的 runtime-tests 接续，本会话冻结后不再实现或执行。停止范围 A/B 的 records 裁决由其负责人维护；native 与恢复资源仍由主会话处理。

## 尚待整体验收

整体停止/局部停止实际覆盖的执行范围、真实模型的并行实现、独立复核、追加约束、受阻与最终整合仍需另验；本轮 PTY 夹具的停止回执只表示受控 transport 接收了命令。常驻 App 由另一会话负责。

原 no-TUI todo 已由同宿主 clarify/reject 两条实际回环替换并通过。停止宿主后由新宿主只读接回、明确继续由主会话负责，不与本轮同宿主唤回混记。

成员普通事件不进入整体日志；宿主需持续给出 `collaboration.view`，主动 `collaboration.read(member)` 回完整 entries/messages。审批应保留成员 `event.session`，失败输入回执必须带原 `input.ref`。整体/成员停止命令的范围由宿主履行，TUI 不从浏览位置推断执行范围。

## 最终回交与冻结

用户已接收本轮真实协作组 15 pass / 223 expectations。validation 完成后，正式回交 TUI/control 模块、局部 tests、协作专用 app fixture/tests、frames 装置及本记录的文件所有权；停止本会话全部源码/测试写入与测试执行，不再自行扩展。`shell.ts` 是本轮唯一主动 git add 的已解冲突文件；未提交、推送、合 main 或清理 worktree。

主会话另行报告 native+host **16 pass / 90 expectations**、全树 typecheck 通过；本记录将其标为主会话结果，不计入本会话 15 项真实协作回环，也不替代最终停止竞争验收。实际模型行为、常驻 App 与跨宿主恢复继续由对应负责人验收。
