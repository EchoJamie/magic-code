# 等待终态领取与实际带入确认

2026-09-26。仅修改 contracts/collaboration、records 实现与对应测试、Faux 桩与对应测试。未修改 App、conversation、actions 或工具。未提交、推送、合并或清理工作树。

## 稳定接口

```ts
// CollaborationWait
readonly handledAt?: Timestamp
readonly includedAt?: Timestamp

// CollaborationRecords
markWaitOutcomesIncluded(agentId: AgentId, waitIds: readonly WaitId[], at: Timestamp): void
```

- handledAt 仍只表示宿主领取。consumeWaitOutcomes 不写 includedAt，领取后重开也不会重复领取。
- includedAt 表示宿主确认该终态实际带入模型请求，保留首次确认时间，不代表模型理解、执行或完成。
- 新方法仅接受本 actor 的已领取终态（expired、resolved、interrupted）；仍在等待、未领取、他人的或不存在的 ID 均拒绝。即使已经确认，也不能以他人身份调用为幂等成功。
- 同一数据库的短事务内处理整批 ID，重复 ID 去重；任何非法项导致整批回滚。空数组无事。
- 停止后允许补记已领取终态的实际带入事实，不恢复准入或改变停止状态。
- 复用现有等待 JSON 记录，没有 schema 变更、新调度状态、自动重试循环或兼容迁移。Faux 提供新签名，未注入脚本的写操作照旧明确拒绝，不复制等待状态机。

宿主接线由主会话完成：context 捕获本次请求实际携带的已领取、未 included 等待 ID；在供应商响应兑现 requested 时，将那份 ID 列表传入新方法。records 校验归属和领取状态，不推测模型请求是否实际发出，也不自行触发唤起。

## 验证

- [相关回归](./collaboration-wait-inclusion-regression.log)：109 pass / 0 fail，455 断言，6 文件；涵盖全部 records 协作专项、contracts 契约、Faux 桩。
- [最终专项](./collaboration-wait-inclusion-final-focused.log)：57 pass / 0 fail，174 断言，3 文件。
- [最终全库 TypeScript 检查](./collaboration-wait-inclusion-final-typecheck.log)：退出码 0。首次检查发现新增竞争断言的可选值类型错误，已修正并重跑；原日志保留。
- 相关所有权路径 `git diff --check` 通过；没有放宽已有测试。

新增行为证据覆盖三种等待终态；领取后请求失败、重开仍保留未 included 事实；首次确认幂等；未领取/非终态/越权/不存在记录拒绝；批次回滚；空数组；停止后只补事实。真实双进程使用独立 SQLite 连接同时确认同一个等待，均幂等成功且只有一个首次 includedAt，handledAt 保持原值。

```sh
bun test packages/records/test/collaboration*.test.ts packages/faux/test/stubs.test.ts packages/contracts/test/contracts.test.ts
bun test packages/records/test/collaboration-wait-inclusion.test.ts packages/records/test/collaboration-concurrency.test.ts packages/faux/test/stubs.test.ts
bun run typecheck
```

本轮证据限于记录行为、真实 SQLite 竞争和类型传播。App 的显式 wake、自动调度条件和实际供应商回应兑现由主会话集成验证。

## 主会话整合补证与冻结交回

主会话本轮回报：boundary 已接入等待 included 事实；重建实例后显式补取 message/wait 的两例通过，连同等待期控制等共 **16 pass / 78 断言**；真实 manager/socket/executor 入口五项仍为 **5 pass / 51 断言**，typecheck 通过。这些是主会话提供的整合证据，本会话未重复运行；此前真实入口日志位于 `/tmp/magic-collaboration-wake-http.log`。

至此本责任链的实现、接口传播、局部验证材料均已交回。本次文档补证后冻结本责任修改面，不再写入；后续本地快照保全、稳定核心吸收及整树冻结由主会话统一操作。本会话未提交、推送、合并或清理工作树，也未扩展新审查。
