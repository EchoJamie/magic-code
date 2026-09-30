# 拒绝回报与跨动作幂等冲突闭合

2026-09-26。本轮只修改 `contracts/src/collaboration.ts` 的 OperationResult、records 实现及 records 测试；未修改 actions、App、conversation、tools。没有提交、推送、合并或清理工作树。

## 本轮已修复

### 拒绝决定不再作为普通回执过滤

`respondToDelegation(reject)` 现在使用现有 `purpose: decision`，保留发送者、委派关联、拒绝理由及原来的等待 interrupted 裁决；accept 仍为 receipt，clarify 仍为 clarification。未新增唤起状态。

修复前整合复现：无等待的入口接到成员 reject，actions 确实发出 1 次 wake，但 boundary 将 receipt 过滤，conversation 模型请求数为 0，拒绝原因留在 consumed、未 included 的消息中。本轮 records 验证覆盖有/无等待、拒绝重传不重复、拒绝终止等待和 accept 不解除等待；主会话完成的整合回归见下方补证。

### 原幂等 kind 检查区分消息动作

原实现将四个动作都登记为 message，同一 actor 复用 operationId 会取回其它动作的消息。现仅调整原操作结果判别式，继续由原 `prior` 在同一个 SQLite 事务中校验 actor 和 kind；不另加命名空间、去重状态、材料 hash 或数据库迁移。

| 方法 | OperationResult.kind | 结果引用 |
| --- | --- | --- |
| send | message | messageId |
| delegate | delegation | delegationId |
| deliver | delivery | messageId |
| publishConstraint | constraint | messageId |

同动作重传取原结果；跨动作复用同一 operationId 抛出 `operation identity conflict`，不改已有消息、委派、约束、收件或操作事实。

修复前整合复现：成员先 send(`report`) 告知仍在工作，再 deliver(`report`) 声称完成，deliver 返回 `ok: true` 和原 inform，委派仍为 accepted。现 records 明确拒绝该碰撞；actions 不必改操作键来掩盖冲突。

这是开发中协作契约的变更：按既定边界，未对此前统一 kind=message 的旧试验操作记录增加兼容迁移。本轮持久重开验证覆盖新契约写入的记录。

## 验证产物

- [修复前日志](./collaboration-operation-before.log)：新增专项 1 pass / 14 fail；普通 accept 原行为通过，reject 分类与 12 个跨动作组合失败。
- [修复后专项日志](./collaboration-operation-focused.log)：27 pass / 0 fail，133 断言，含既有竞争专项及新增真实双进程 send/deliver 同 ID 竞争。
- [局部回归日志](./collaboration-operation-regression.log)：155 pass / 0 fail，625 断言，13 文件。包含 records 全套、contracts 契约和 Faux 桩。
- [全库 TypeScript 日志](./collaboration-operation-typecheck.log)：`bun run typecheck` 退出码 0。
- 相关路径 `git diff --check` 通过。未放宽现有测试。

主会话整合补证：其回报 collaboration-runtime、actions、conversation 合计 13 pass / 64 断言；本会话已读取 [/tmp/magic-collaboration-wake-http.log](/tmp/magic-collaboration-wake-http.log)，真实 manager/socket/executor 入口专项 5 pass / 0 fail、51 断言，包含无 wait 的 reject 增加入口 HTTP 而 accept 不增加。没有为此重复执行全量。

```sh
bun test packages/records/test/collaboration-operation.test.ts packages/records/test/collaboration-concurrency.test.ts
bun test packages/records/test packages/contracts/test/contracts.test.ts packages/faux/test/stubs.test.ts
bun run typecheck
```

## 回交主会话的其它审查发现

以下为前轮使用真实 SQLite、实际 boundary/service 与受控模型的复现，不在本轮修改范围内。

1. **等待挡住协调动作。** 入口等待成员 A，收到 inform 后模型提出 `agent_control stop(A)`；loop 的 `waiting()` 通用分支拦下工具。实测请求 1 次、工具执行 0 次，A 仍 accepted。定位 `conversation/src/agent-loop.ts` 工具循环的 waiting 分支及轮末 continues 判定。建议去掉对协调动作的一刀切等待限制，保留工作工具限制；已消费新消息的重新判断不能被 waiting 吞掉。
2. **领取后请求失败，显式 wake 不再推进。** 在 `gateway.stream` 注入 HTTP 发出前的本地配置失败，分别放入普通消息和 expired 等待结果，连续显式 wake 两次。两种情形均只尝试请求一次：消息 consumed 且无 includedAt；等待已写 handledAt。定位 `app/src/collaboration-boundary.ts` 的 consume、`conversation/src/service.ts` 的 drain 消费判断及 `app/src/run/collaboration.ts` 的 pending/handled 调度条件。消息可复用 consumed、未 included 的事实；等待领取与实际回报确认需共同确定接口，不能仅把失败后自动调度改成无限重试，更不能重放工作工具。本轮没有擅改 handledAt 语义。

另有 prepareInput 的保存/发布失败语义：前轮源码中 appendUserEntry 成功后调用 accepted 发布共同约束，发布异常进入“没能记下来，请重新发送”的共同 catch；这是静态确认，未单独运行复现。交付时只读核对发现主会话已增加发布阶段的独立 catch，文案明确“输入已保存，但共同补充未能发布”；本会话没有修改或扩大审查。

manager 旧 retire 接线不作为最终验收依据；afterEnd 资源确证按主会话与 App 稳定接口继续整合。本轮未复现新的假 included 或自动工具重放问题，不将局部证据视为整套端到端验收。
