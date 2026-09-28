# 协作与常驻核心合并后的局部验证

2026-09-26。基于协作分支吸收 `47941ea`、恢复并行修改后的工作树；不提交、不推送、不合 main、不清理工作树。

## 本次修改

- 解除 `contracts/src/index.ts`、`records/src/store.ts`、`records/test/schema.test.ts` 三处冲突，仅暂存这三个已解冲突文件。保留 native / collaboration 导出，以及 attention / collaboration 使用同一个 SQLite 连接的初始化与端口。schema 用例确认两组表都在原 records.db。
- 新增 `app/src/run/collaboration-native.ts` 和专用测试。同步 `captureCollaborationNative(records, sessions)` 公开 `sessions` 与 `groups`；每组含 collaboration / members / delegations / waits / executions。纯函数 `mergeCollaborationNative(works, snapshot)` 按 originSessionId 合并，不读新记录、不计算停止版本。
- 新增文件未暂存；manager、native-projection、contracts native 均由主会话接线，本次未编辑。

## 结果

| 局部命令 | 结果 | 产物 |
| --- | --- | --- |
| `bun test packages/records/test packages/conversation/test/context.test.ts packages/conversation/test/context-collaboration.test.ts` | 146 pass / 0 fail / 733 expect，16 文件 | [记录与上下文日志](magic-collaboration-records-context-merged.log) |
| `bun test packages/app/test/collaboration-native.test.ts packages/app/test/native-projection.test.ts` | 14 pass / 0 fail / 58 expect，2 文件 | [原生投影日志](magic-collaboration-native-unit.log) |
| `bunx tsc --noEmit --pretty false -p packages/records/validation/tsconfig-context.json` | exit 0 | [记录与上下文类型检查](magic-collaboration-records-context-merged-types.log) |
| `bunx tsc --noEmit --pretty false --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --allowImportingTsExtensions --module Preserve --moduleResolution bundler --target ESNext --skipLibCheck packages/app/src/run/collaboration-native.ts packages/app/test/collaboration-native.test.ts` | exit 0 | [原生投影类型检查](magic-collaboration-native-types.log) |

已有记录回归覆盖 attention / collaboration 的持久化和并发竞争，以及上下文材料授权、图片保留、压缩后实际带入和收件次序。此次没有重复全量测试。

## 专项证据与接缝

- 同一根工作只占一行；入口 idle 不遮成员 running，成员审批保留 waiting；不同 origin 的同名成员互不混入。
- 旧成员事项展示归根，detail 仅成员名与原因；保留 id / fact / unread / delivered，不修改持久事项，不从历史 needs-you 推断当前待答。
- waiting 事实即使没有 executor 仍 affected；投影不根据当前时钟自行过期。queued / accepted / delivered 未收下仍属整项范围；全员空闲不推断工作完成。
- 协调者 suspended 显示“协调承接待核实”，保留其他成员正在执行的动作。execution 未核销且没有对应运行事实时仍待核实；停止受理与核销分开。closed 只显示“已收尾”，不生成 done 事项。
- 有控制屏障的真实 records + projectWorks 用例：捕获快照后挂住目录读取，再新增成员、普通会话、事项，改名并停止换代。旧投影仍使用旧成员名、旧 running、旧事项和旧 gen；后续快照才看见新成员 / stopped。
- 快照必须在 await projectWorks 之前和 runs / 整项 stop gen 同步取得；groups 供 manager 计算整体版本。合并器仅保留根行 gen/null，不借成员 gen。目录新增行留到下一拍。

证据止于记录/上下文回归和投影单元测试；整项 stop 的版本校验、资源确证及真实 Native App 展示由主会话的 manager / App 集成验收覆盖。本次未替代或宣称完成该集成验收。
