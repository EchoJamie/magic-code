/**
 * 授权 —— 「总是允许」（`a`）点出来的那一类规则（U22 · 技术方案 · 权限「授权的落点」）。
 *
 * ## 落点＝工作区，不是会话
 *
 * `a` 表达的是「**这类事在这个项目里我信任**」。**会话不是信任的边界**——它会失效不是
 * 因为「该失效」，而是因为会话必然结束，**那是实现的副产品**。故：
 *
 * - **两层，不是三层**：`y` 批准＝**这一次**（不记）；`a` 总是允许＝**这个工作区**（记）。
 *   「会话级记忆」那一层**取消**（它既不是安全单元——同会话内一直在生效；
 *   也不是使用单元——会话必然结束）。
 * - **存处＝内核自持的 `~/.magic/grants.json`**（按工作区绝对路径分节）——
 *   内核不写用户手写的 `config.json`。
 * - **一个文件，不是一项目一文件**：安全相关的东西价值在**一眼看全**（能扫、能删）；
 *   散进几十个小文件的那一刻它就不再被审。
 *
 * ## 本文件的两半
 *
 * - **形态与解析**（`Grant` / `parseGrants`）——文件怎么读，**解析从严**：读不懂的条目
 *   **不生效**（而不是退化成更宽的规则），连同缘由交回调用方。这与 `parseRules` 同一姿势。
 *   **整份读不懂另算**（D31）：那不是「有几条不生效」，是「盘上有什么我们不知道」——
 *   账本照旧给空的那一份，但**这一份不许拿去落盘**（`unreadable`，见 `GrantParseResult`）。
 * - **账本**（`createGrantLedger`）——**纯内存**，本域仍然**不碰文件系统**：落盘是装配的事
 *   （同配置文件的先例），账本只把「变了」报出去（`onChange`）。
 *
 * ## 报的是「改了哪一项」，不是整份（U47）
 *
 * 报出去的是 **`GrantEdit`**（一项增删），不是整份快照——这是「多执行者共享一份
 * `grants.json`」的前置（设计 · 会话与运行管理「多执行者共享数据的前置条件」第二项）。
 * 账本**不知道**盘上现在是什么（那是装配读的文件），故它只说「我加了这一条 / 撤了那一条」；
 * 把这项改动落到**当前内容**上归 `applyGrantEdit`，读与写、以及串行的锁，归装配。
 * 账本因此在并发下仍然自洽：它管的是**本进程**那一份，盘上那一份谁都不许拿旧账本覆写。
 *
 * ## 分节键
 *
 * 一节 ＝ 一个工作区，键是**默认根的规范形**（`roots()[0]`）。三条由头：
 * ① 文件要**一眼看全**——键是一串路径才读得下去（整组根的 JSON 序列化当键，读的人先疯了）；
 * ② **默认根**是工作区在用户面前的那个身份（提示词那一行、`--check` 那一行都从它起头）；
 * ③ 授权条目自带**路径模式**（缺省＝根内），故即便多根工作区之间共用一节，
 *   放行的范围仍然收在那条根的里面——**不会因为分节宽了而多放一条**。
 * （多根的取舍见回报「备案」：另一条路是按整组根分节，代价是「同一个项目换个根集合打开
 * 就要重新点一遍」——那正是本单元要治的摩擦。）
 *
 * ## 陈旧
 *
 * **加载时只读不清理**（`B11`）——本文件不认识「什么时候该删」：删用户数据不归内核。
 * 只标两样，且**都只是话**：`stale`（久未命中——按注入的时钟判，阈值是实现级常量）与
 * 「路径已不在」的那些节（那要问文件系统，故判在**装配**那一侧，见 `grants.catalog`）。
 */

import type { GrantRow } from '@magic/contracts'
import type { RuleOp } from './ops.ts'
import type { PermissionRule } from './rules.ts'
import { describeRule, readRuleEntry } from './rules.ts'

/** 授权文件的版本——写在文件里，供**将来**改形时认得出来。 */
export const GRANTS_VERSION = 1

/**
 * **久未命中**的阈值——实现级常量（技术方案 · 权限：陈旧节的显式列出）。
 *
 * 取 30 天的由头：授权是「这个项目我信任」的**长期**声明，几天不用是常态（项目有忙闲）；
 * 一个月没碰过一条授权，它多半已经属于**过去那个项目**了——那时值得在 `/grants` 里
 * 提一句「这条很久没用了」，但**删不删由用户定**（内核只标不删）。
 */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 一条授权 —— 规则四格（工具 × 路径模式 × 操作类型 × 域名）＋ 记账三件。
 *
 * 几格与 `PermissionRule` **同一形态**（同一套解析、同一套匹配、同一关必闸禁区）——
 * 授权不是第二种规则，只是**它从哪儿来**不同（点出来的 vs 手写的）。
 */
export type Grant = PermissionRule & {
  /** 点下「总是允许」的时刻（毫秒）。 */
  readonly grantedAt: number
  /** 最近一次命中的时刻（毫秒）——从未命中就不写这一位。 */
  readonly lastHitAt?: number
  /** 命中次数——从未命中就不写这一位。 */
  readonly hits?: number
}

/** 授权文件（`~/.magic/grants.json` 的形制）——**一个文件，按工作区分节**。 */
export type GrantsFile = {
  readonly version: number
  readonly workspaces: Readonly<Record<string, readonly Grant[]>>
}

/** 空文件——没读过盘 / 盘上还没有这个文件时的起点。 */
export function emptyGrants(): GrantsFile {
  return { version: GRANTS_VERSION, workspaces: {} }
}

/** 被拒的条目——`index` 是它在那一节里的位置（`-1` ＝**整节**，不是某一条）。 */
export type GrantProblem = {
  /** 哪一节（分节键）。 */
  readonly workspace: string
  readonly index: number
  readonly reason: string
}

/** 解析结果——收下的 ＋ 被拒的（**且缘由**：静默丢弃会让人对着不生效的授权发呆）。 */
export type GrantParseResult = {
  readonly file: GrantsFile
  readonly rejected: readonly GrantProblem[]
  /**
   * **整份读不懂**的缘由（D31）——三样：整个值不是对象 · `version` 不认 · `workspaces`
   * 不是对象。`undefined` ＝整份读得懂（个别条目读不懂是 `rejected` 那一支）。
   *
   * ⚠️ **这一位在，就说明 `file` 那份空账本是「没读进来」，不是「盘上没有」。**
   * 两者在账本上长得一模一样（都是空），但处置**相反**：读得懂才谈得上落盘。
   * 拿一份空账本去写，就是把用户那份东西**抹掉**——**单进程、不并发也会踩**
   * （[[缺陷/D31 授权文件读不懂时被下一次写入抹掉]]）。故它是**不许写**的信号，
   * 不是「有几条不生效」那种可以照写的提醒（见 `grants-file.ts` 的 `commitGrants`）。
   */
  readonly unreadable?: string
}

/**
 * 解析授权文件（**只读**——本函数不写回，落盘归装配）。
 *
 * 入参是 `JSON.parse` 出来的**原值**（`unknown`）——形状不对＝不收：
 *
 * - **整个值不是对象** → 空文件 ＋ `unreadable`（整份读不懂）；
 * - **`version` 不认**（在，且 ≠ 本版）→ 整份不收（那是**将来的**内核写的，本轮读不懂它）；
 *   ⚠️ `version` **缺席按本版认**（文件是人手可写的，缺一个元数据键不该让整份授权失效）；
 * - **`workspaces` 不是对象** → 同上（整份读不懂）；
 * - **逐条**：读不懂的**不收**（复用规则那一套 `readRuleEntry`——同一套「什么算合格的规则」），
 *   记账位（`grantedAt` / `lastHitAt` / `hits`）形态不对也**不收**（宁可少一条授权，不可多一条）。
 *
 * **整份读不懂与个别条目读不懂是两件事**（D31）：前者 `unreadable`，盘上那份**不许写**
 * （我们不知道里面有什么）；后者 `rejected`，文件本身读得懂、照写不误（那几条不生效，
 * 缘由已报给用户）。分界就在**这份文件整体能不能读**。
 *
 * 两种情形都**不抛**：读文件的人是装配，它要把「有几条读不懂」报成一行话给用户看。
 */
export function parseGrants(raw: unknown): GrantParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      file: emptyGrants(),
      rejected: [],
      unreadable: '整个值须是一个对象（形如 { version, workspaces }）',
    }
  }

  const root = raw as Record<string, unknown>
  const version = root['version']

  if (version !== undefined && version !== GRANTS_VERSION) {
    return {
      file: emptyGrants(),
      rejected: [],
      unreadable: `版本 ${String(version)} 不认（本轮只认 ${GRANTS_VERSION}）`,
    }
  }

  const sections = root['workspaces']
  const rejected: GrantProblem[] = []

  if (sections === undefined) return { file: emptyGrants(), rejected }
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) {
    return {
      file: emptyGrants(),
      rejected: [],
      unreadable: '`workspaces` 须是对象（一节一个工作区）',
    }
  }

  const workspaces: Record<string, readonly Grant[]> = {}

  for (const [workspace, value] of Object.entries(sections as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      rejected.push({ workspace, index: -1, reason: '一节须是数组（一条授权一个条目）' })
      continue
    }

    const grants: Grant[] = []
    value.forEach((entry, index) => {
      const read = readGrant(entry)
      if ('reason' in read) {
        rejected.push({ workspace, index, reason: read.reason })
        return
      }
      grants.push(read.grant)
    })

    // 一節一条都不剩就不留这一节——空节只是噪音（撤销掉最后一条＝那一节也没了）
    if (grants.length > 0) workspaces[workspace] = grants
  }

  return { file: { version: GRANTS_VERSION, workspaces }, rejected }
}

/** 读**一条**授权——`{ grant }` 或 `{ reason }`（摘掉记账那几个键再走规则那一套校验）。 */
function readGrant(entry: unknown): { readonly grant: Grant } | { readonly reason: string } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { reason: '条目须是对象（形如 { tool, path?, op?, grantedAt?, lastHitAt?, hits? }）' }
  }

  const fields = entry as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!GRANT_KEYS.includes(key)) rest[key] = value
  }

  // 规则那三格——**同一处校验**（`readRuleEntry`）；它不认识记账位，故上面先摘掉
  const read = readRuleEntry(rest)
  if ('reason' in read) return { reason: read.reason }

  const grantedAt = fields['grantedAt']
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) {
    return { reason: '缺记账位 `grantedAt`（点下「总是允许」的时刻，毫秒）' }
  }

  const accounting = readAccounting(fields)
  if ('reason' in accounting) return { reason: accounting.reason }

  return { grant: { ...read.rule, grantedAt, ...accounting.meta } }
}

/** 记账位——两个都**可选**，但给了就得是**非负整数**（宁可少一条授权，不可多一条）。 */
const GRANT_KEYS: readonly string[] = ['grantedAt', 'lastHitAt', 'hits']

function readAccounting(
  fields: Record<string, unknown>,
): { readonly meta: { lastHitAt?: number; hits?: number } } | { readonly reason: string } {
  const meta: { lastHitAt?: number; hits?: number } = {}

  for (const key of ['lastHitAt', 'hits'] as const) {
    const value = fields[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { reason: `记账位 \`${key}\` 须是非负的数（给了就是记过的账，别写个读不懂的）` }
    }
    meta[key] = value
  }

  return { meta }
}

// ══ 改动单元 ══════════════════════════════════════════════════════════

/**
 * **一项增删**——账本报出去的落盘单位（U47）。**不是整份快照。**
 *
 * 由头（设计 · 会话与运行管理「多执行者共享数据的前置条件」第二项）：原先报的是
 * **整份文件**，装配拿它整份覆写——两个执行者各持旧账本，后落盘的那个把前一个的
 * 改动**抹掉**，撤销也会被旧的那一份**复活**。改成「说清楚我改了哪一项」，装配那一侧
 * 就能做到「读**当前**内容 → 应用这一项 → 原子保存」，并使这一串**串行**执行。
 *
 * `hit` 单独一支、且可以攒着（见 `GrantLedgerOptions.onChange`）：它是每一次自动放行
 * 都发生的事，逐次写盘＝白烧 io，而掉电丢的只是统计，不是授权。
 */
export type GrantEdit =
  /** 新记了一条（`a`）——**立刻落盘**（这是那份文件存在的理由）。 */
  | { readonly kind: 'grant'; readonly workspace: string; readonly grant: Grant }
  /**
   * 撤了一条（`/grants` 选定即撤）——**立刻落盘**（撤销不落盘＝下次启动又回来了）。
   *
   * `index` 是它在**撤的那一刻**名录里的位置；`rule` 是三格身份。两个都给，是因为
   * 落盘要落在一份**重读来的当前内容**上（并发前置）：索引对得上就直接那一条，
   * 对不上（盘上已被别人动过）就按身份找——找不到＝那一条已经不在了，这一项就是空操作。
   */
  | {
      readonly kind: 'revoke'
      readonly workspace: string
      readonly index: number
      readonly rule: PermissionRule
    }
  /** 整节撤掉（陈旧节那条路——路径已不在）。 */
  | { readonly kind: 'section'; readonly workspace: string }
  /**
   * 命中记账——**攒着**（每一次自动放行都写盘＝白烧 io；掉电丢的是统计，不是授权）。
   *
   * 一次可以带好几笔：装配把攒下的合到一次锁里落盘，不必一笔一锁。
   */
  | { readonly kind: 'hit'; readonly updates: readonly GrantHit[] }

/** 一笔命中记账——够重建那一条的两个记账位。 */
export type GrantHit = {
  readonly workspace: string
  readonly rule: PermissionRule
  readonly lastHitAt: number
  readonly hits: number
}

/**
 * **把一项增删应用到一份授权文件上**（纯函数）——落盘那一跳的「改」那一半。
 *
 * 装配拿它做「读**当前**内容 → 应用这一项 → 原子保存」（见 `GrantEdit`）：
 * 输入是**刚从盘上读来的**那一份，输出是写回去的那一份。本函数不碰文件系统
 * （域纪律），也不知道盘上有过什么——**这就是它能在并发下不出错的原因**。
 *
 * 逐项的分寸：
 * - `grant`——同形的已在册就不再加（用户的话说过了，不必说两遍；并发下这一句也挡住
 *   别人刚加进去的那一条）；
 * - `revoke`——先按 `index` 对身份，对不上再按身份找第一条；都没找到＝**空操作**
 *   （不抛、不新建节）——那一条已经不在了就不该被这一项弄回来；
 * - `section`——整节删掉；那节不在＝空操作；
 * - `hit`——**只改在册的那些**（不在册的直接跳过）：撤销**不得**被一笔迟到的命中记账
 *   复活。
 *
 * 空节不留（与 `parseGrants` 的读面同一分寸：撤销掉最后一条＝那一节也没了）。
 */
export function applyGrantEdit(file: GrantsFile, edit: GrantEdit): GrantsFile {
  const workspaces: Record<string, readonly Grant[]> = { ...file.workspaces }

  /** 替掉某一节——**空节不留**（撤销掉最后一条＝那一节也没了，与读面同一分寸）。 */
  const put = (workspace: string, grants: readonly Grant[]): void => {
    if (grants.length === 0) delete workspaces[workspace]
    else workspaces[workspace] = grants
  }

  switch (edit.kind) {
    case 'grant': {
      const grants = workspaces[edit.workspace] ?? []
      if (grants.some((seen) => sameRule(seen, edit.grant))) break
      put(edit.workspace, [...grants, { ...edit.grant }])
      break
    }

    case 'revoke': {
      const grants = workspaces[edit.workspace]
      if (grants === undefined) break

      const at = grants[edit.index]
      const target =
        at !== undefined && sameRule(at, edit.rule)
          ? edit.index
          : grants.findIndex((seen) => sameRule(seen, edit.rule))
      if (target === -1) break

      put(
        edit.workspace,
        grants.filter((_, index) => index !== target),
      )
      break
    }

    case 'section': {
      delete workspaces[edit.workspace]
      break
    }

    case 'hit': {
      for (const update of edit.updates) {
        const grants = workspaces[update.workspace]
        if (grants === undefined) continue

        const index = grants.findIndex((seen) => sameRule(seen, update.rule))
        if (index === -1) continue // 不在册＝**不复活**（撤销之后迟到的记账就落在这儿）

        put(
          update.workspace,
          grants.map((grant, at) =>
            at === index ? { ...grant, lastHitAt: update.lastHitAt, hits: update.hits } : grant,
          ),
        )
      }
      break
    }
  }

  return { version: file.version, workspaces }
}

// ══ 账本 ══════════════════════════════════════════════════════════════

export type GrantLedgerOptions = {
  /** 本工作区——**分节键＝默认根的规范形**（见文件头注「分节键」）。 */
  readonly workspace: string
  /** 启动时读来的那一份（缺省＝空文件）。 */
  readonly file?: GrantsFile | undefined
  /** 时钟（毫秒）——「久未命中」的判据要它；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined
  /**
   * 变了就报**改了哪一项**（**落盘归调用方**——本域不碰文件系统）。
   *
   * ⚠️ 报的是 `GrantEdit`（一项增删），**不是整份快照**（U47）：报整份，调用方就只能整份
   * 覆写，两个执行者各持旧账本时后落盘的会把前一个的改动抹掉。见 `GrantEdit`。
   */
  readonly onChange?: ((edit: GrantEdit) => void) | undefined
}

/**
 * 授权账本 —— 本工作区记着哪些授权 ＋ 它们的账（`技术方案 · 权限「授权的落点」）
 * 里那两件：**查看 / 撤销**）。
 *
 * 纯内存：加载是装配读文件 → `parseGrants` → 交进来；写回是 `onChange` 报出去 → 装配落盘。
 * 权限域因此仍然**一个字节都不往盘上写**（域纪律 · 不碰文件系统）。
 */
export type GrantLedger = {
  /** 本工作区的分节键。 */
  readonly workspace: string
  /** 本工作区生效的授权**规则**（匹配用，声明序）——未经 `parseGrants` 的那些不影响它。 */
  rules(): readonly PermissionRule[]
  /** 记一条（`a` 批准）——已有同形的**不重复入册**（用户的话说过了，不必说两遍）。 */
  remember(rule: PermissionRule): void
  /** 命中一次——记上次数与时刻（**久未命中**那条判据的原料）。 */
  hit(rule: PermissionRule): void
  /**
   * 撤某一节的第 `index` 条（`/grants` 选定即撤）。
   *
   * 节名**显式给**（而不是「本工作区」）：撤销是用户对**名录上那一行**的动作，
   * 而名录里除了本工作区，还有陈旧节的入口——传错节＝撤错东西，不该靠缺省值猜。
   * 越界 / 那节不在＝`false`，不抛。
   */
  revoke(section: string, index: number): boolean
  /** **整节撤掉**（陈旧节那条路——路径已不在）——返回撤掉了几条。 */
  dropSection(section: string): number
  /** 全部节名（含本工作区）——装配据以探「哪些已不在」。 */
  sections(): readonly string[]
  /** `/grants` 要的那一份（本工作区，声明序）——`stale` 在这里算好。 */
  view(): readonly GrantRow[]
  /**
   * **整份快照**——已按当前账本重建（空节不留）。
   *
   * ⚠️ **不是落盘的那一份**（U47 起）：落盘走 `GrantEdit`（一项改动落到**重读来的**
   * 当前内容上），拿这份快照整份覆写会把别的执行者的改动抹掉。它留作**本进程所知的
   * 整份**这张读面（验收与诊断用）。
   */
  snapshot(): GrantsFile
}

/** 造一个账本（本工作区那一节现取；其余节原样留着——撤陈旧节要用）。 */
export function createGrantLedger(options: GrantLedgerOptions): GrantLedger {
  const now = options.now ?? Date.now
  const workspace = options.workspace
  /** 全部节（含本工作区）——改写它，`snapshot()` 按它重建。 */
  const sections = new Map<string, Grant[]>(
    Object.entries(options.file?.workspaces ?? {}).map(([key, grants]) => [key, [...grants]]),
  )

  const mine = (): Grant[] => {
    const found = sections.get(workspace)
    if (found !== undefined) return found
    const fresh: Grant[] = []
    sections.set(workspace, fresh)
    return fresh
  }

  /** 整份快照——**空节不留**（撤销掉最后一条＝那一节也没了）。 */
  const build = (): GrantsFile => {
    const workspaces: Record<string, readonly Grant[]> = {}
    for (const [key, grants] of sections) {
      if (grants.length > 0) workspaces[key] = grants.map((grant) => ({ ...grant }))
    }
    return { version: GRANTS_VERSION, workspaces }
  }

  return {
    workspace,
    rules: () => mine(),
    sections: () => [...sections.keys()],

    remember(rule) {
      const grants = mine()
      if (grants.some((seen) => sameRule(seen, rule))) return // 同形的已在册——不必说两遍
      const grant: Grant = { ...rule, grantedAt: now() }
      grants.push(grant)
      options.onChange?.({ kind: 'grant', workspace, grant: { ...grant } })
    },

    hit(rule) {
      const grants = mine()
      const index = grants.findIndex((seen) => sameRule(seen, rule))
      // 只记在册的那些（不在册＝报信的人搞错了，不替它补一条）
      if (index === -1) return

      const found = grants[index] as Grant
      const at = now()
      const hits = (found.hits ?? 0) + 1
      grants[index] = { ...found, lastHitAt: at, hits }
      options.onChange?.({
        kind: 'hit',
        updates: [{ workspace, rule, lastHitAt: at, hits }],
      })
    },

    revoke(section, index) {
      // **不新建节**（与 `remember` / `hit` 不同）：撤一条不存在的＝没撤成，不该顺手造一节
      const grants = sections.get(section)
      if (grants === undefined || index < 0 || index >= grants.length) return false
      const [removed] = grants.splice(index, 1)
      // 报的是**撤掉的那一条**（三格身份）——`splice` 之后就拿不到它了
      if (removed !== undefined) {
        options.onChange?.({ kind: 'revoke', workspace: section, index, rule: removed })
      }
      return true
    },

    dropSection(section) {
      const grants = sections.get(section)
      if (grants === undefined) return 0
      sections.delete(section)
      options.onChange?.({ kind: 'section', workspace: section })
      return grants.length
    },

    view: () => mine().map((grant) => rowOf(grant, now())),
    snapshot: build,
  }
}

/** 一条授权 → 名录那一行（**陈旧**在这里判——阈值见 `STALE_AFTER_MS`）。 */
function rowOf(grant: Grant, now: number): GrantRow {
  const last = grant.lastHitAt ?? grant.grantedAt

  return {
    describe: describeRule(grant),
    grantedAt: grant.grantedAt,
    // 没记过账就不给这一位（**不编一个 0**——「从未命中」与「命中于 1970 年」不是一回事）
    ...(grant.lastHitAt === undefined ? {} : { lastHitAt: grant.lastHitAt }),
    ...(grant.hits === undefined ? {} : { hits: grant.hits }),
    stale: now - last >= STALE_AFTER_MS,
  }
}

/** 两条授权同不同——工具 × 路径 × 操作 × **域名**四格全等（顺序无关的集合比对）。 */
export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.tool === b.tool && a.path === b.path && a.host === b.host && opKey(a.op) === opKey(b.op)
}

function opKey(op: PermissionRule['op']): string {
  if (op === undefined) return ''
  return (Array.isArray(op) ? op : [op]).join(',')
}

/**
 * 「总是允许」凝出的那一条授权 ——（工具 × 本次调用的操作类型 × **本次的域名**）；
 * 路径一格缺省＝**根内**。
 *
 * 四格照技术方案「按（工具 × 路径模式 × 操作类型）记录」落，第四格见下：工具**收到具体名**
 * （不推广到别的工具）、操作类型收到**本次实际发生的那几类**（复合命令的每一段都算数）、
 * 路径不写＝根内（用户说的是「这类事别再问」，不是「机器上哪儿都行」）。
 *
 * ## 域名那一格：**有就必须带上**（U72）
 *
 * 这一处正是「**按域名给，不按工具给**」的落点（设计 · 网页与搜索）。不带上它的后果是
 * 具体的：`{ tool: 'web_fetch', op: ['outbound'] }` 这一条会命中**任意域名**的取网
 * ——用户答的本来是「往这家发」，记下来的却成了「往哪家发都行」。
 *
 * 反面（调用没有域名，如 `exec` / `write`）**不补这一格**：补一个空串或通配，
 * 会让「这一次没有域名」与「这一次的域名是某某」在匹配上分不开（`matchesHost` 那两种缺省）。
 */
export function grantOf(face: {
  readonly tool: string
  readonly ops: readonly RuleOp[]
  readonly host?: string
}): PermissionRule {
  return {
    tool: face.tool,
    op: [...face.ops],
    ...(face.host === undefined ? {} : { host: face.host }),
  }
}
