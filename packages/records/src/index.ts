/**
 * `@magic/records` —— **记录域**（记录库）。
 *
 * 职责（技术方案 · 领域划分）：内容与过程的持久化——会话条目 · 事件存储 · blob · schema。
 * 对外端口 **`RecordsService`**（在 `@magic/contracts`）；本包＝它的实现域。
 * 域内规则：**blob 写权唯一归本域**（各域大块转存皆经其公开面）· schema 演进走纪律
 * （`user_version`）· 恢复的查询面（在途识别）由本域提供（阶段 2）。
 *
 * 域纪律（技术方案 · 代码治理）：
 * - **只依赖 `@magic/contracts`**——域之间互不 import、域不认知外壳与装配；
 * - **fs 直触**——本域是内核仅有的两处之一（另一处＝执行域）；库文件与 blob 目录
 *   只在 `store.ts` / `blobs.ts` 落下；
 * - **不取时钟**——`at` 一律由调用方给（信封由产出方铸），会话时间取首次写入的时间。
 *
 * 公开面四件（技术方案 · 代码治理 · 公开面：端口实现 ＋ 装配期构造入参形态）：
 * ① **端口实现**——`createRecordsStore`（库 / blob 的唯一持有者；会话实例经 `serviceFor` 取）；
 * ② **构造入参形态**——`RecordsStoreOptions` / `RecordsStore`；
 * ③ **形态补足**——`isToolCallEntry` / `isToolResultEntry`（契约占位 9「kind ↔ 载荷强对应」
 *    的读取侧收窄；只增不改，见 `entries.ts` 头注）；
 * ④ **恢复查询面**——`scanForRecovery` ＋ `InFlightCall` / `RecoveryScan`（阶段 2 · U15
 *    「在途识别由记录域提供」；经 `RecordsStore.recoveryScan` 取用，见 `recovery.ts`）。
 *
 * 不出去的：库表形态 · SQL · id 预留水位 · 引用格式（`BlobRef` 对消费者不透明）。
 */

export { createRecordsStore, DATABASE_FILE } from './store.ts'
export type { RecordsStore, RecordsStoreOptions } from './store.ts'

export { isToolCallEntry, isToolResultEntry } from './entries.ts'
export type { ToolCallEntry, ToolResultEntry } from './entries.ts'

// 恢复查询面（阶段 2 · U15）——**在途识别**（技术方案 · 领域划分：恢复的查询面由本域提供）
export { scanForRecovery } from './recovery.ts'
export type { InFlightCall, RecoveryScan, ScanInput } from './recovery.ts'
