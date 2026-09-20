/**
 * 测试台 —— 装配用例与全链冒烟共用的一束接线活文档。
 *
 * 沙地三块：**数据目录**（记录库 / blob 落这儿）· **工作区根**（首站单根＝启动目录）·
 * **配置文件**（形制照冻结的字面）。三者都在一个 `mkdtemp` 目录里，用完删干净。
 *
 * 配置走**真的加载器**（`loadConfig`）而不是手搓一个 `LoadedConfig`——冒烟要验的就是
 * 「从配置文件到全链」这条路，绕开加载器等于验了一半。
 *
 * ⚠️ 测试面：`@magic/faux` 与 `node:fs` 只许出现在 `test/**`（技术方案 · 代码治理 ·
 * 测试面分面）。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import type { FauxGateway, FauxTurn } from '@magic/faux'
import { createFauxGateway } from '@magic/faux'
import type { Assembly, AssembleOptions } from '../src/index.ts'
import { assemble, loadConfig } from '../src/index.ts'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

/** 一段「交代一件事、它跑一条命令」的 Faux 脚本——冒烟的标准剧本。 */
export const SMOKE_TURNS: readonly FauxTurn[] = [
  {
    toolCalls: [{ name: 'exec', args: { cmd: 'echo hello-magic' } }],
    usage: { inputTokens: 11, outputTokens: 3 },
  },
  { text: '跑完了', usage: { inputTokens: 21, outputTokens: 7 } },
]

/** 一块装好的沙地。 */
export type Stage = {
  readonly root: string
  readonly dataDir: string
  readonly workspace: string
  readonly configPath: string
  /** 本次装配用的假模型（`requests` 留痕在这儿——「回填送达了吗」靠它）——未装配时为空。 */
  readonly models: readonly FauxGateway[]
  /** 按需装配（同一块沙地上可装配多次——如「顺序纪律」用例）。 */
  assemble(options?: StageAssembleOptions): Assembly
  dispose(): void
}

/**
 * 装配入参——沙地已经定下的两件（工作区根 · 配置）不外露，其余照给。
 *
 * `modelGateway` **可以覆盖**（U33 返工补）：缺省仍是 Faux，但**真实网关**那几例
 * （真 SDK ＋ 注入 fetch，无网络）要拿它换掉——真实模型域与 Faux 的首事件时序不同，
 * 而那正是要咬的地方。沙地、家目录、授权文件照旧全在临时目录里。
 */
export type StageAssembleOptions = Omit<AssembleOptions, 'cwd' | 'config'> & {
  readonly turns?: readonly FauxTurn[]
  /** 每步之间的等待（毫秒）——测中断时给消费方留窗口。 */
  readonly stepDelayMs?: number
}

/** 沙地的可调项——目前只有配置：权限规则等用例要在**真配置**里加键。 */
export type StageOptions = {
  /** 配置字段覆盖（形制照冻结的字面）——如 `{ permissions: { rules: [...] } }`。 */
  readonly config?: Record<string, unknown>
}

export function makeStage(options: StageOptions = {}): Stage {
  const root = tempDir('magic-app-')
  const dataDir = join(root, 'data')
  const workspace = join(root, 'ws')
  const configPath = writeConfig(root, validConfig({ dataDir, ...options.config }))
  const models: FauxGateway[] = []

  // 工作区根须**已存在**（工作区构造取 realpath——宁可在装配期响亮失败）
  mkdirSync(workspace, { recursive: true })

  return {
    root,
    dataDir,
    workspace,
    configPath,
    models,

    assemble(options: StageAssembleOptions = {}) {
      const { turns = SMOKE_TURNS, stepDelayMs, ...rest } = options
      return assemble({
        cwd: workspace,
        // **授权文件也落沙地**（U22）：缺省 `GRANTS_FILE` 是 `~/.magic/grants.json`——
        // 那是**用户真的那份**。装配级用例默认全在沙地里跑（同 dataDir / 配置的姿势），
        // 要另指别处就在 `options` 里覆盖（`...rest` 在后，覆盖得起）。
        //
        // ⚠️ 这一条是**踩出来的**：`U22` 头一轮漏了它，`permission.test.ts` 那条
        // 「按 `a`」的用例直接把测试的临时工作区**写进了用户的真文件**（6 节全是
        // `/private/var/folders/…/magic-app-*/ws`）——测试污染真实数据，是这一层总该防住的。
        grantsFile: join(root, 'magic', 'grants.json'),
        // **家目录也落沙地**（U33）：用户那一类技能来源是 `<home>/.magic/skills` 与
        // `<home>/.agents/skills`——不给这一条，每个 app 用例都会去扫**用户真的**
        // 那两个目录（读到了什么全看这台机器上装了什么，用例当场不可复现）。
        // 与 `grantsFile` 同一条纪律：装配级用例一律沙地化，不碰真东西。
        home: root,
        config: loadConfig({ path: configPath, home: root }),
        modelGateway: (stamper) => {
          const gateway = createFauxGateway({ stamper, turns, stepDelayMs })
          models.push(gateway)
          return gateway
        },
        prompt: { platform: 'darwin', date: '2026-09-18' },
        ...rest,
      })
    },

    dispose(): void {
      removeDir(root)
    },
  }
}

/** 最近一次装配的假模型——回填断言用（未装配即抛，免得断在 `undefined` 上）。 */
export function lastModel(stage: Stage): FauxGateway {
  const gateway = stage.models.at(-1)
  if (gateway === undefined) throw new Error('还没装配过——先 stage.assemble()')
  return gateway
}

/** 某 kind 的事件（先按 kind 收窄再取——判别联合的红利，无须强转）。 */
export function eventsOfKind<K extends KernelEvent['kind']>(
  events: readonly KernelEvent[],
  kind: K,
): Extract<KernelEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<KernelEvent, { kind: K }> => event.kind === kind)
}

/** 事件轨迹的 kind 序列——「发生了什么」的骨架。 */
export function kindTrail(events: readonly KernelEvent[]): string[] {
  return events.map((event) => event.kind)
}

// —— 独立验证：直读库表（不经 API 回读闭环）——

export type RawEntry = {
  readonly id: number
  readonly session: string
  readonly kind: string
  readonly content_kind: string
  readonly content_text: string | null
  readonly content_blob: string | null
  readonly payload: string | null
  readonly at: number
}

export type RawEvent = {
  readonly id: number
  readonly session: string
  readonly turn: number | null
  readonly at: number
  readonly kind: string
  readonly data: string
}

export type RawDatabase = {
  /** `title` 可空（U16：没改过就没有——默认标题由对话域按首条消息现算，不落库）。 */
  readonly sessions: readonly {
    readonly id: string
    readonly at: number
    readonly title: string | null
    /** 工作区（U26）——落盘形态＝JSON 一列；列加上之前落账的会话为 `null`。 */
    readonly workspace: string | null
  }[]
  readonly entries: readonly RawEntry[]
  readonly events: readonly RawEvent[]
  close(): void
}

/** 直读记录库——「记录可直读」的判据就建在这上面。 */
export function readDatabase(databasePath: string): RawDatabase {
  const db = new Database(databasePath, { readonly: true })

  return {
    sessions: db
      .query<{ id: string; at: number; title: string | null; workspace: string | null }, []>(
        'SELECT id, at, title, workspace FROM sessions ORDER BY at',
      )
      .all(),
    entries: db
      .query<RawEntry, []>(
        `SELECT id, session, kind, content_kind, content_text, content_blob, payload, at
           FROM entries ORDER BY id`,
      )
      .all(),
    events: db
      .query<RawEvent, []>('SELECT id, session, turn, at, kind, data FROM events ORDER BY id')
      .all(),
    close: () => db.close(),
  }
}
