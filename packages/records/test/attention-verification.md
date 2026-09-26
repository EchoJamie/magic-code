# 常驻 App 持久注意事项：records 局部交接

验证日期：2026-09-26（Asia/Shanghai）。工作树：`/Users/jamie/namespace/github/magic-code-resident-app`；分支：`feat/resident-macos-app`；验证时 HEAD：`80d9678a53719535d1e5f2953969774e1b2c29c7`，改动未提交。运行时：Bun `1.4.2 (50a8a8387)`。

本轮实施授权覆盖设计文档中的旧“未授权”字样。依据为 `常驻App与状态栏.md` 的“通知、已读与注意力”“本机协议与数据边界”：观察不消费未读、稳定事项 id 去重、已读不等于已答、投递与已读分别持久化、直接替换 JSON 便条而不迁移。

## 可消费接口

`RecordsStore.attention` 已可直接使用；`AttentionStore` 从 `@magic/records` 导出：

```ts
type AttentionStore = {
  put(item: AttentionItem): boolean
  list(): readonly AttentionItem[]
  markRead(ids: readonly string[]): void
  markDelivered(ids: readonly string[]): void
}
```

- `AttentionItem` 通过 `import type` 复用 contracts 中 native.ts 的公共导出，本分工未修改共享契约。
- `put` 只插入；已有 id 返回 `false`，不覆盖既有字段或已读/已投递标记。稳定 id、fact 与初始标记由调用方提供。
- `list` 按 `at ASC, id ASC` 返回全部事项的新快照，不消费未读、不标记投递。
- `markRead` 只将指定 id 的 `unread` 置为 `false`；`markDelivered` 只将指定 id 的 `delivered` 置为 `true`。空数组、重复 id、未知 id 均可安全重复调用；未知 id 不预存确认。
- 两种确认各自在同库事务内完成一批 id，途中失败整批回滚；不修改事项的 kind/fact，不生成回答或修改会话/事件。

## 落点与修改范围

新增 `src/attention.ts`，在 `src/schema.ts` 初始化 `records.db` 内的 `attention_items` 表，保存 `id/session/kind/fact/at/detail/unread/delivered`；`src/store.ts` 用原连接装配，`src/index.ts` 导出类型。新增结构的必要性是独立持久保存事项及两种确认，避免再持有一份 JSON 或内存真源。

复用现有 WAL、忙等待和 SQLite 事务，无新数据库，无 session 外键或自动建 session 行；来源会话尚未落库时可先保存事项。既有 schema 版本常量和迁移链未改动，新增表随现有幂等 DDL 初始化，不读取或迁移 `notices.json`。

修改限于 `packages/records/src/**` 与 `packages/records/test/**`。未修改 manager、executor、app/notices、Swift 或 contracts，未回退其他开发者变更。

## 验证记录

| 检查 | 结果与证据 |
| --- | --- |
| `bun test packages/records/test` | 63 pass、0 fail，10 个文件，281 次断言；最终一轮 1283 ms |
| 本次注意事项测试 | `attention.test.ts` 9 项及 `attention-concurrency.test.ts` 1 项包含在上述 63 项中 |
| records 独立类型检查 | 读取根 tsconfig 的编译选项，以 records 的 src/test 共 22 个 TS 文件为根，TypeScript 编译 API 检查结果为 0 diagnostics |
| `bun test test/scaffold.test.ts` | 27 pass、0 fail，220 次断言；覆盖包公开面、依赖方向、fs 边界 |
| `bun run typecheck` | 最终退出码 0。较早一次共享工作树快照在 manager.ts:754、run-executor.test.ts:251 有 2 处错误；本分工未修改这些文件，随后复查通过 |
| `git diff --check -- packages/records` | 通过 |

新增用例证明：全字段及三类事项持久/重开、详情缺席与空串可区分、会话尚无行、稳定排序、重复 put 不覆盖任何状态、两种确认顺序独立、按具体 id 确认不影响同会话其他未读、旧快照重放不覆盖新事实、批量更新失败回滚、已读待答的恢复扫描仍为 `requested: true / decision: null`。只读连接上的读取成功，反复 list 不改变观察连接的 SQLite `data_version`。有效和损坏的旧 JSON 均未读取、未改写、未迁移。

真并发用例使用 4 个独立进程，经栅栏同时操作同一临时新库：竞争插入 120 个共享 id，每个 id 只有一方得到 `true`；另写 480 条独立事项。两进程分别确认已读和投递，所有进程重放旧值，最终重新开库逐字段核对全部 600 条，未确认事项仍未读。子进程和测试临时目录由测试收尾。

## 交接与未验边界

records 局部出口完成，可由主会话 `w3A:p4` 接入 manager/native-server。存储列表已证纯读；订阅、握手、在场与具体事项确认的端到端行为仍归 manager 联合验收，本报告不将局部读取测试等同于协议订阅验证。

未运行系统通知、Swift/App、终端接回、宿主异常退出或发行包验收，也未进行磁盘满/断电故障注入。未接触用户真实会话或数据，所有新增存储测试使用隔离临时目录，默认静默。

按用户指令保留 `feat/resident-macos-app` 分支和现有工作树；未 commit、push、merge，未清理工作树，未派子代理。
