# 多智能体协作整合验证

工作树：`/Users/jamie/namespace/github/magic-code-multi-agent-collaboration`；分支：`feat/multi-agent-collaboration`。本轮不合 main、不推送、不清理工作树。U100 不作为前置，也未复制其开发代码。

这里区分已取得的行为证据和实际环境联合验收，不将受控端点当作真实模型协作质量证明。

## 已有证据

- [身份、通信与竞争事务](../../records/validation/collaboration-records.md)：真实 SQLite 持久收件、操作幂等、单一委派推进、停止闭包、多进程竞争。
- [上下文、引用授权与局部停止](../../records/validation/collaboration-context.md)：实际引用材料、图片部件、压缩后的未带入收件、发送者授权、停止排队 B 不误停已接受 A。
- [TUI、控制与真实执行进程回环](../../tui/test/collaboration-validation.md)：终端帧与 manager/socket/executor + 本地 HTTP 证据；澄清/拒绝唤回、普通回执不空转、成员审批、共同补充、双窗口草稿归属。
- [模型与主机装配原始证据](../../../.ui-runs/collaboration-models/README.md)：异构模型实际请求、角色材料、配置隔离、用量原事件、后台进程的委派归属与真实退出。
- `collaboration-runtime.test.ts`：入口让出后的等待结果消费、无信息回执、未知用量保留，以及资源未确证时保持 closing。使用真实记录库和会话循环，模型为可控替身，不替代独立执行进程回环。
- `collaboration-actions.test.ts`：首次派生的模型预检失败不展开协作；修正配置后重试仍只创建并启动同一成员。

后续定向收口已通过：`collaboration-runtime`、`collaboration-actions`、`conversation/collaboration` 共 13 项；真实进程入口唤起五项共 51 个断言通过，覆盖有等待的 clarify/reject/accept 与无等待的 reject/accept。拒绝属于待处理决定，接受保持普通回执；重复通知不空转。共同补充在原文已保存、发布失败时如实说明两份事实，归还原 ref 且不请求模型。

继续审查后增加的证据：

- `/clear` 与成员读取并发的真进程回环先红后绿，8 个断言；旧查询结果不携新代次混入新工作，新输入无旧原文或共同约束。负证据为 `.ui-runs/collaboration-manager/clear-query-race-before-fix.json`。
- 等待只通过既有工具 `halt` 让出，删除等待状态对后续工具的统一限制。`agent_wait` 已有结果或循环拒绝不让出；被新信息唤起后可执行点名停止。
- 已领取但尚未实际带入的消息及等待结果，在本地请求失败后可由显式唤起补取；重建实例也能读回，成功带入后不重复请求。自动调度仍只认未领取事实，不因补取能力无限重试。`collaboration-runtime`、`conversation/collaboration`、`tools/agent-tools` 共 16 项、78 个断言通过，随后真实入口五项再次通过。

主会话的记录域、对话域、工具域和 actions 回归曾完整通过 493 项。核心接入前完整回归为 2949 pass、1 fail、1 todo，唯一失败是资源收尾时序，原日志见 `.ui-runs/collaboration-models/full-regression.log`。这是历史负证据，不是当前整合快照的全量结果。

## 常驻核心整合

已在本协作分支吸收唯一稳定出口 `47941ea1fb9b971e5ef70804fdbe1420eedac416`；未吸收废弃中间提交。随后接入恢复修复 `d0f677beb968f7c2324a0373b0d45f9eefd5eeb0` 与关窗修复 `c78a3d3ddcd8077000d43e002714e9c6b82d69f1`。核心接入前快照 `54014818697ee56b070bbf0daabb8d2614d6417a`、关窗整合前快照 `a69cd94fb986b86f734c2e50ccab5f8583d31690` 均保留。共享协议归 `contracts/run-wire`，没有第二套协作执行协议；协作停止复用现有 `stopExecution`、同一 `RunRecord` 等待和 `afterEnd/reclaimRun` 核销出口。

| 当前行为证据 | 结果与边界 |
| --- | --- |
| 原显式 receive / close / 最终正文 | 主会话定向 1 pass / 27 expect；完整协作组再次通过。收到 closed 时，入口与成员的真实 launcher.onExit 均已到达，未增加延时掩盖竞态 |
| TUI 与真实协作回环 | TUI/control/scaffold 961 pass；manager/socket/独立 executor + 本地 HTTP 15 pass / 223 expect，含无 TUI clarify/reject、入口 detached 后成员审批继续、双窗口原 ref 隔离、共同材料、约束后重审、等待中控制与只读查询 |
| 常驻资源回归 | 6 pass / 72 expect；socket 关闭、执行者退出、自有组核销按次序确认，扩展未确认不假报宿主结束 |
| 整体停止与迟到竞争 | `run-collaboration-stop` 4 pass / 194 expect；停止与后代派生竞争、后代真实启动并拥有后台组后整体停止、stop 后旧 HTTP 返回、已发交付 RPC 在原认证通道迟到处理。全部按真实 onExit、持久结束事实、同代身份和进程组消失确认，不以历史 Run 显示 stopped 作为唯一判据 |
| 原生协作归并与宿主重开 | `collaboration-native`、`native-projection`、`collaboration-host` 共 16 pass / 90 expect；整项一行、成员审批归根、有效等待无 executor 仍 affected、异步目录读取不混新状态与旧 gen、旧整体停止版本拒绝；退出后查询不执行，明确继续只接回入口 |
| 执行身份及未核销记录 | token 随原运行记录持久化；`collaboration-runtime` 与 run facts 31 pass / 127 expect；65 份未核销登记不被最近历史上限截断，1 pass / 132 expect。后者是登记装置，不是 65 个真实子进程 |
| records 与 context | 稳定核心整合后 146 pass / 733 expect；同库保留 attention/collaboration；[原生适配材料](../../records/validation/collaboration-native.md)含同步快照与异步目录竞争证据 |
| 模型装配 | 稳定核心整合后 445 pass；常驻只读观察补验 6 pass；能力与选择共用解析机制，保留各成员独立实际配置 |

第二轮正常完整门为 3137 pass / 1 fail，剩双窗口 `/clear` 的旧断言把管理者发车计数当成客户端已收到新目标。当前树与 c78a3d3 均以 FIFO 暂扣真实 target 帧，在原 `not.toBe` 断言直接取红；放行后新旧窗口代次与原会话均正确。证据在 `.ui-runs/collaboration-gate-clear/`；仅补测试的客户端目标回执同步，未改生产路由、固定等待或放松窗口隔离判据。

第三轮正常完整门为 3132 pass / 0 fail / 1 error；搜索工具清单测试只等模型请求就关库，循环晚写触发数据库异常，后续六项压缩测试未运行。当前树与 c78a3d3 的模型门控对照均在提前关库时直接失败、实际回到 waiting 后关库时通过；证据在 `.ui-runs/collaboration-gate-drain/`。仅将测试改为复用既有 `attachShell.submit` 收束屏障并删除请求轮询，原工具清单断言保留；相邻五文件 26 pass / 121 expect，无未处理异常，六项压缩测试全部执行。未改生产生命周期或吞异常；该局部结果仍不替代最终完整门。

原始集成证据在 `.ui-runs/collaboration-integration/`。原 `.ui-runs/collaboration-manager/explicit-close-before-process-exit.json` 保留：旧 manager 的入口进程退出曾比 closed 晚 1 ms；没有删除负证据、放宽强断言或用 `test.failing` 避开。当前实现只在真实该代退出和 owned 核销均确证后调用 `executorExited(session, executionId)`，旧代重复核销不能结束新代。

## 当前整合边界

1. 停止竞争四项已通过；原 HTTP 与已发 RPC 两种在途事实分别验证。核心恢复 idle 误判已取得先红后绿，并隔离提交为 `d0f677beb968f7c2324a0373b0d45f9eefd5eeb0`：仅 facts 与核心回归，在 47941ea 隔离副本正常提交门 2955 pass / 0 fail / 11386 expect，typecheck 通过；已交常驻侧吸收。此门不替代协作最终门。
2. 首轮最终门 typecheck 通过，但 3129 pass / 3 fail；三条旧会话测试均在模型请求前因 workspace=NULL 被协作身份登记误拒。相同暂存树单文件 7 pass / 3 fail，c78a3d3 隔离副本 10 pass / 0 fail；原日志与树快照在 `.ui-runs/collaboration-gate-u48/` 保留，不把超时当行为反证。三例随后在约 0.2 秒的 input.settled 拒收断言取得直接红；记录回归先 5 pass / 1 fail，仅删除私有 addAgent 的重复查询/比较两行后，相邻 67 项 / 406 断言通过。sessions.workspace=NULL 未补写，已知多根顺序与 spawn 拒用既存会话保护保留。完整质量门由正常提交钩子对暂存快照执行；最终日志为 `.ui-runs/collaboration-integration/final-commit.log`，最终结果及交付提交号记录在规划库 `验证/多智能体协作/集成验证.md`。局部通过不替代该门。
3. 关闭全部连接后入口真实退出与事件唤回，以及生产 Manager 退出/重开已有受控回环证据；这些用例不等于真实终端 SIGHUP。稳定关窗修复 c78a3d3 已接入，协作生产 shell.hangUp 回环先红后绿，1 pass / 18 expect；入口 HTTP 在途关窗不整体停止，成员回应仍唤回新代。实际同版 macOS App 包中的联合展示、接回及退出仍待验。
4. 真实付费模型的并行实现与独立复核尚未运行。设计要求在已授权实际工作中取证，不借设计验收擅自调用付费供应商或修改用户真实工程。

本文件只记录本协作分支的实现与验证范围，不修改设计正文、进度台账或其他会话的交付状态。
