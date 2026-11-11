# 协作材料、引用授权与局部停止验证

验证日期：2026-09-26。当前共享工作树中的局部交付记录；不提交、不推送、不合并、不清理工作树。

## 接口与行为

- `assembleContext.onIncluded?: (messageIds: readonly MessageId[]) => void` 在整个上下文成功组装后报告实际展开的顶层消息 ID。包含窗口内发出的消息；不写收件的 `includedAt`。宿主在真实请求边界对照 consumed inbox 取交集。嵌套消息是引用材料，不另报告顶层 ID。任何消息、条目、正文 blob 或图片读取失败均使装配失败，不回报成功。
- `agent-message` 先经 `readMessage` 授权，再按正文次序读取引用条目或 blob。用户材料复用 `userBodyOf`，保留 refs 的原文位置、来源、技能和图片 parts；引用的完整正文不按普通工具输出上限截断。协作来源明确标识，不升级为用户授权。
- 协作材料在完整工具调用/结果配对之后装入。压缩窗口外 consumed 但未 included 的收件仍携带实际材料。初次条目缓冲未见、其后已消费的消息按持久收件顺序补入；pending 收件不会被越过领取。普通无协作条目的上下文不访问 Faux collaboration 桩。
- `listMessages(agentId)` 通过记录端口返回该成员有权访问的发出、收件及关联讨论消息；复用 `readMessage` 的可见性规则，不开放同协作所有历史。
- entry 引用的发送、编辑、委派来源和授权均检查发送者权限：本人会话、明确原始授权、共同约束来源或已可读消息明确分享的单条引用。仅同工作成员关系不能获得引用权；转发不扩大为来源会话的全部历史。
- `StopResult.delegations` 保留本次撤回的来源闭包；`agents` 仅表示需要实际取消或收尾的成员。已有 accepted A 时撤回 queued B 不把该成员或 A 的执行放进取消目标，也不取消该成员无绑定的 coordination 执行。停止与接受判据在同一 SQLite 事务中裁决。
- 全量首轮反馈的 context 补入失败已修复；普通会话测试 getter 显式标注 `RecordsService['collaboration']`，消除抛错桩被推断为 void 的类型错误。

## 验证结果

当前最终回归 **308 pass / 0 fail，1091 断言，20 个文件**，覆盖 conversation 全套、contracts 契约、records 协作行为与多进程竞争、Faux 桩。原始输出在 [collaboration-context-final-tests.log](./collaboration-context-final-tests.log)。

```sh
bun test packages/conversation/test packages/contracts/test/contracts.test.ts packages/records/test/collaboration.test.ts packages/records/test/collaboration-concurrency.test.ts packages/faux/test/stubs.test.ts
```

本轮新增 context 专项 10 项，包括图片/refs/skills 顺序与来源、压缩补入、工具配对、读取失败、授权检查、循环引用、普通会话及消费与读取交错。records 专项包含猜 entry ID、自发自收洗来源、越权编辑、委派来源洗授权、局部约束、明确分享后的窄范围转发等对抗行为。

两项新增真实进程竞争证据使用独立 SQLite 连接和文件 barrier：

1. A 已接受时，A 的执行准入与停止 queued B 并发，两者都成功；A 不在取消目标，执行保持 running。
2. 接受 A 与停止 queued B/无绑定判断并发：接受先成立则保留 A；停止先成立则先置 cancellation，后到接受被拒绝。

全库 `bun run typecheck` 退出码 **0**，见 [collaboration-context-final-typecheck.log](./collaboration-context-final-typecheck.log)。本范围配置 [tsconfig-context.json](./tsconfig-context.json) 的 `tsc --noEmit` 同样退出码 **0**，见 [collaboration-context-final-scoped-typecheck.log](./collaboration-context-final-scoped-typecheck.log)（成功无输出）。此前并行编辑期间的失败日志保留，不代表此次最终检查结果。

相关所有权路径的 `git diff --check` 通过。上一阶段记录底座的验证与历史结果见 [collaboration-records.md](./collaboration-records.md)。

## 证据边界

这些是本地行为、真实 SQLite 多进程竞争与静态类型证据；未由本会话验证真实模型提供商请求、App 界面或端到端部署。boundary、agent-loop 和服务入口由主会话集成；本轮没有修改它们。共享工作树仍在并行开发，以上结果对应执行检查时的源码。
