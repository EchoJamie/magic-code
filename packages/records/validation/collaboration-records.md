# 协作身份与持久通信底座局部验证

日期：2026-09-26。工作树：`magic-code-multi-agent-collaboration`；分支：`feat/multi-agent-collaboration`。未提交、未推送、未合并，工作树与本目录验证产物保留。

## 已落地的责任链

- `RecordsStore.collaboration` / `RecordsService.collaboration` 共用当前 SQLite 和 blob 记录域。
- 身份绑定会话；协作绑定原会话；派生成员继承原工作区。入口配置在建立协作时捕获为 `defaultModel`，后续模型切换不修改未来派生默认。`responsibility` 与角色名独立。
- 稳定操作身份保存原受理结果；成员、初始委派、授权来源与发送/收件引用在短事务中成立。
- 消息正文仅保存于消息事实；发送/接收条目只引用消息，`Entry.source` 仍是发送会话。普通 appendEntry 不能伪造协作条目。讨论邀请允许回查同一问题，但不修改原始接收方集合。
- 收件采用持久 position；消费和引用追加同事务，按成员/消息去重；已消费正文不能编辑或撤回。纳入实际模型请求另记 includedAt。
- 委派接受、澄清、拒绝、交付、核验收下分别保存；一个成员最多一份已接受责任，其余排队；协调判断可在接受前发生，工作准入仍要求已接受绑定。
- 共同约束保留真实用户来源、适用成员和当前有效引用；晚加入及明确重新启用成员补取当前约束，带入状态不冒称遵守。
- 等待对象、原委派、期望和截止点持久化；只用未解决等待做循环检查；结果、期限和中断产生真实终态。`consumeWaitOutcomes` 原子领取终态，不伪造成员发送消息。
- 整体/宿主停止和委派来源闭包停止均先关闭准入；派生、接受、开始执行使用同一 SQLite 写事务裁决。旧 run 的停止墓碑持续有效；迟到结果可持久化但不重启工作。close 保留未收下结果与在途执行的机械 blockers。

## 做减法与接线约定

撤掉旧记录编号的进程内块预留。协作事务会向别的 Session 追加引用，保留块预留会让后写的普通条目退回旧 id 区间。条目、事件、消息、等待现在沿同一个 records_meta 水位以单语句取号；收件顺序仍由独立的持久 position 表达。代价是每次取号一次 SQLite 写入，不再有内存编号窗口。

`actor` 和 `mode` 是可信宿主参数，不应暴露为模型自行填写的身份/准入控制。`coordination` 用于模型判断和协作工具；工作工具用 `work`。返回原 execution 操作结果不意味着可以重放副作用，调用方须遵守结果状态与宿主运行生命周期。

本实现保存授权来源与可追溯引用，不替代权限域对具体文件、命令、blob/材料及供应商访问的裁决。等待终态领取表示宿主已经领取，不宣称模型理解或副作用恰好一次。

## 验证证据

1. `bun test packages/records/test packages/faux/test`：**163 pass，0 fail**，含真实多进程竞争和既有八进程编号测试。见 `collaboration-records-faux-tests.log`。
2. 扩大到指定 contracts/conversation 测试的前一次运行：**214 pass，1 fail**。唯一失败为 contracts 瞬时事件清单缺 `collaboration.view`（该文件只获授权补 records 桩字段，未越界修改清单）。见 `collaboration-local-tests.log`。
3. 最近保存的全库类型检查问题位于 `app/src/agent-models.ts`：`ModelInfoServiceOptions` 缺 `fetch/now`。本记录责任链当次无类型错误；见 `collaboration-typecheck.log`。共享工作树仍在并行集成，此快照不代表最终全库状态。
4. 自有文件 `git diff --check` 通过。

关键竞争覆盖：同时接受两份委派；派生/发送重传；停止与派生/执行；消费与撤回/编辑；两个消费者；相反等待并发登记；并发超时/终态领取；双唤起单执行者；接受与撤回。另有 SQLite 触发器故障注入，验证引用追加失败时消费位置一并回滚。

这份证据仅覆盖记录域、契约传播和测试替身。App 生命周期、action/run 联合行为、真实供应商模型、TUI/原生界面及实际工具副作用的端到端验证由主会话集成，不在此声明已验。
