/**
 * 授权文件（`~/.magic/grants.json`）的**读写** —— 装配视图第 1 步的边上（U22）。
 *
 * 技术方案 · 权限「授权的落点」：
 *
 * > 存处＝内核自持的授权文件 `~/.magic/grants.json`（按工作区绝对路径分节 · 内核读写）；
 * > **内核不写用户手写的 `config.json`**——写回的麻烦（原子写 · 保留用户编辑 · 并发）
 * > 只落在一个**它全权持有**的文件上。……**原子写 ＋ 失败方向安全**
 * > （最坏丢一次授权，不是多给一次）。
 *
 * 本文件就是那三件麻烦的落点，逐条对应：
 *
 * - **原子写**——先写同目录的临时文件、`rename` 覆盖（`rename` 在同一文件系统上是原子的）。
 *   直接 `writeFile` 到目标上的话，写到一半掉电就是半份 JSON ⇒ 下次启动整份读不懂
 *   （而解析从严意味着**一条授权都不生效**——用户点过的 `a` 全没了）。
 * - **保留用户编辑**——**不必**：这个文件归内核全权持有（这正是设计选它的理由），
 *   用户手写它不在契约里；故整份覆写，不做读改写合并。
 * - **并发**——同一台机器上同时开两个 magic 时，最后落盘的那个赢（**已知限度**，随回报备案）。
 *   失败方向仍是安全的：**丢一次授权**（大不了再点一次 `a`），不会**多**出一次授权。
 *
 * **解析从严归权限域**（`parseGrants`）：本文件只管**字节**——读不出来（文件不在 / JSON 坏）
 * 就报「没有」并**带上缘由**，由装配决定怎么说给用户听；**不在这里替它猜**。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GrantProblem, GrantsFile } from '@magic/permission'
import { emptyGrants, parseGrants } from '@magic/permission'

/** 读的结果——盘上没有 / 读不懂都**不抛**（授权缺失不是启动期事故：默认问那条路照走）。 */
export type LoadedGrants = {
  /** 实际读的文件（已展开的绝对路径）。 */
  readonly path: string
  /** 解析后的那一份（读不到时是空文件）。 */
  readonly file: GrantsFile
  /** 读不懂的条目（连同缘由）——交回装配，够格就报一行给用户。 */
  readonly rejected: readonly GrantProblem[]
  /**
   * 出了什么事的一句话（`undefined` ＝ 一切正常）——**文件不在不是事**（第一次用谁都没有），
   * 故「不在」不报；**JSON 坏**要报（那是用户的文件被写坏了，得让他知道那一条路没走成）。
   */
  readonly note?: string
}

/**
 * 读授权文件。
 *
 * **加载时只读不清理**（`B11`）——本函数**一个字节都不写**，陈旧节也不动：删用户数据不归内核。
 *
 * @param path 已展开的绝对路径（`GRANTS_FILE` 经 `expandDataDir`）。
 */
export function loadGrants(path: string): LoadedGrants {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 文件不在＝常态（第一次跑、或从没点过 `a`）——不是错，也不值得在屏上说一句
    return { path, file: emptyGrants(), rejected: [] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      path,
      file: emptyGrants(),
      rejected: [],
      note: `授权文件不是合法 JSON（${reason}）——本轮一条授权都没加载`,
    }
  }

  const parsed = parseGrants(raw)
  return {
    path,
    file: parsed.file,
    rejected: parsed.rejected,
    // 读不懂的条目**没进账本**，故 `/grants` 里也撤不到它们（名录只列在册的）——
    // 出口是把文件改对或删掉那几条，这一句得说清是哪一个出口
    ...(parsed.rejected.length === 0
      ? {}
      : {
          note: `授权文件里有 ${parsed.rejected.length} 条读不懂（未生效）——改文件或把那几条删掉`,
        }),
  }
}

/**
 * 写授权文件（**原子**）。
 *
 * 临时文件与目标**同目录**：`rename` 只在同一文件系统内是原子的，跨设备会退化成复制。
 * 临时文件名带 `.tmp` 后缀且**固定**（不加随机数——同一时刻只有一个内核在写这个文件，
 * 见文件头注「并发」；多了随机数只会在崩溃后留下一堆没人认领的残骸）。
 */
export function saveGrants(path: string, file: GrantsFile): void {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
