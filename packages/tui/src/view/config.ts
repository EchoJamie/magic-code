import type { EventDataOf, ModelCatalogRow, ModelRef, StatusLineCell, StatusLineConfig } from '@magic/contracts'
import type { PickerRow } from '../view.ts'
import type { GrantsCatalog } from './grants.ts'
import type { McpCatalog } from './mcp.ts'

/**
 * **`/config` 那一屏里「不是读数」的那两件**——数据目录与工作区根。
 *
 * 另外三行（连接 · 授权 · 外部工具）各有自己的读侧命令可问，唯独这两件**是进程启动那一刻
 * 就定下的**（配置 ＋ 启动目录），没有任何命令答得出来。装配把**已解析的那两份**递进来
 * （同 `ShellOptions.workspaceRoots` 的姿势）：**拿不到的不编**——没给就那一格空着、那一屏
 * 少一行，绝不拿一个拼出来的路径顶上。
 */
export type ConfigPaths = {

  /** 数据目录（由选定基础目录派生的绝对路径）。 */
  readonly dataDir?: string | undefined

  /** 系统家目录——**只用来把屏上的路径缩成 `~/…`**（长路径在那一行里放不下）。 */
  readonly home?: string | undefined

  /** 工作区根（规范形 · 声明序，`[0]` 是默认根）。 */
  readonly workspaceRoots?: readonly string[] | undefined
}

/** `/config` 那一屏的一项——**顺序即屏上的顺序**（设计里就是这么排的）。 */
export type ConfigItem = {

  /** 选定之后进哪一项——落在 `PickerRow.value` 上（与 `modelActionRows` 同一姿势）。 */
  readonly key: 'model' | 'grants'
  | 'mcp' | 'web' | 'paths' | 'statusLine' | 'motion' | 'turnDuration'
  readonly name: string
}

export const CONFIG_ITEMS: readonly ConfigItem[] = [
  { key: 'model', name: '模型与连接' },
  { key: 'grants', name: '本工作区授权' },
  { key: 'mcp', name: '外部工具' },
  { key: 'web', name: '网页查询与搜索' },
  { key: 'statusLine', name: '状态行' },
  { key: 'motion', name: '减少动效' },
  { key: 'turnDuration', name: '本轮耗时' },
  { key: 'paths', name: '数据目录与工作区根' },
]

/** 名称那一格最宽是几个字——补齐全靠它（见 `paddedLabel`）。 */
const CONFIG_LABEL_CHARS = Math.max(...CONFIG_ITEMS.map((item) => [...item.name].length))

/**
 * 名称补齐到同宽——**「右列对齐」全在这一手**（设计：「每行**一个可配项 ＋ 它的当前值**
 * （右列对齐）」）。
 *
 * 渲染那一层给的是「序号 ＋ 名称 ＋ 一个全角空格 ＋ meta」（`components/picker.ts` 的
 * `PickerList`），名称是**变长**的——四条不补齐，值那一列就参差不齐，而这一屏的全部意义
 * 正是**竖着扫一眼**。
 *
 * 补的是**全角空格**（与那一格的分隔同一个字符）：四个名称都是全角汉字，按**字**补齐
 * 即按**列**补齐（`inkWidth` 那边一列不多、一列不少）。补出来的是行尾空白——看不见。
 */
function paddedLabel(name: string): string {
  return name + '　'.repeat(CONFIG_LABEL_CHARS - [...name].length)
}

/**
 * 家目录下的路径缩成 `~/…`——**给那一格省地方**（`/Users/<谁>/.magic` 这种头谁都知道，
 * 而那一行的右边还有别的字）。
 *
 * 三条：不知道家目录 ⇒ 原样（拿不到的不编）· 正好是家目录 ⇒ `~` · 在家目录下 ⇒ 换成 `~/`。
 * **不在家目录下的照旧写绝对路径**——那正是用户要认出来的那一格。
 */
function tildify(path: string, home: string | undefined): string {
  if (home === undefined) return path
  const base = home.replace(/\/+$/u, '')
  if (base === '') return path
  if (path === base) return '~'
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

/**
 * ① **模型与连接**的当前值——**此刻会走哪一条**（`模型名 · 连接名`）。
 *
 * 记号**一字不新造**：那一格取自 `model.catalog` 的 `current`（与 `/model` 那屏标「正在用」
 * 是**同一份读数**），名称的取法也与 `modelRows` 同一条（模型名取 `info.name ?? id`、
 * 连接名取 `entry.name ?? id`）——两处各取一套的话，屏上那一栏就会与它通向的那一屏对不上。
 *
 * 两种「没有去向」分开说（同 `--check` 的 `describeProviders`）：**一条连接都没接入**与
 * **接入了但没选过模型**是两件事，后者进去挑一条就有。
 *
 * ⚠️ **不报「几条连接」**：那是各入口自己的上下文（设计明文：不复制连接状态），
 * 这一格说的是「现在走谁」。
 */
function configModelValue(entries: readonly ModelCatalogRow[], current: ModelRef | null): string {
  if (current === null) return entries.length === 0 ? '还没接入' : '还没选模型'

  const entry = entries.find((one) => one.provider === current.provider)
  const connection = entry?.name ?? current.provider
  // 缓存里没有它（用户换过的那个模型从最近一次列表里没了）⇒ 照实报精确 id——不拿别的顶上

  const info = entry?.cache?.snapshot?.models.find((one) => one.id === current.model)
  return `${info?.name ?? current.model} · ${connection}`
}

/**
 * ② **本工作区授权**的当前值——**几条**（少了／多了跟着变）。
 *
 * ⚠️ **不报「授权来源」**（规则来的还是 `a` 记的）：那是 `/grants` 那一屏的上下文。
 * 陈旧的节（别的工作区）也不进这一格——这一行说的是**本工作区**。
 */
function configGrantsValue(catalog: GrantsCatalog | null): string {
  if (catalog === null) return ''
  return catalog.grants.length === 0 ? '还没有' : `${catalog.grants.length} 条`
}

/**
 * ③ **外部工具**的当前值——**配了几台**。
 *
 * ⚠️ **不报「连上没有 · 各有几件工具」**（设计明文点名的「工具数」）：那是 `/mcp` 那一屏
 * 的上下文。这一格说的是**配置里写了几台**。
 */
function configMcpValue(catalog: McpCatalog | null): string {
  if (catalog === null) return ''
  return catalog.servers.length === 0 ? '还没配' : `${catalog.servers.length} 台`
}

/**
 * ④ **网页查询与搜索**的当前值——**连接 ＋ Fetch 的提炼模型**。
 *
 * 两件各说一件事：Search 只要连接；Cantrip 只影响 Fetch（未配置时 Search 照常可用）。
 * 读数来自 `web.state`（不复用模型列表事件冒充网页状态）。
 */
function configWebValue(web: EventDataOf['web.state'] | null): string {
  if (web === null) return ''
  const provider = web.provider === undefined ? '还没配置' : web.provider
  const cantrip = web.cantrip === undefined ? '未配置' : web.cantrip.model
  return `${provider} · Fetch 提炼 ${cantrip}`
}

/** ④ **数据目录与工作区根**的当前值——两条路作一段（多个根时报个数，逐个摆进它那一屏）。 */
function configPathsValue(paths: ConfigPaths): string {
  const parts: string[] = []
  if (paths.dataDir !== undefined) parts.push(tildify(paths.dataDir, paths.home))
  const roots = paths.workspaceRoots ?? []
  if (roots.length === 1) parts.push(tildify(roots[0] as string, paths.home))
  else if (roots.length > 1) parts.push(`${roots.length} 个根`)
  return parts.join(' · ')
}

export function configRows(input: {
  readonly paths: ConfigPaths
  readonly models: readonly ModelCatalogRow[]
  readonly current: ModelRef | null
  readonly grants: GrantsCatalog | null
  readonly mcp: McpCatalog | null
  readonly web: EventDataOf['web.state'] | null
  readonly statusLine: StatusLineConfig | undefined
  readonly turnDuration?: 'elapsed' | 'active'
  readonly reducedMotion: boolean

  /** 正在筛的词——空串＝全表。 */
  readonly filter: string
}): readonly PickerRow[] {
  const values: Readonly<Record<ConfigItem['key'], string>> = {
    model: configModelValue(input.models, input.current),
    grants: configGrantsValue(input.grants),
    mcp: configMcpValue(input.mcp),
    web: configWebValue(input.web),
    paths: configPathsValue(input.paths),
    statusLine: configStatusLineValue(input.statusLine),
    motion: input.reducedMotion ? '已开' : '已关',
    turnDuration: input.turnDuration === 'active' ? '扣除等待用户' : '完整经过时间',
  }
  const needle = input.filter.trim().toLowerCase()
  return CONFIG_ITEMS.filter((item) => hits(needle, item.name, values[item.key])).map((item) => ({
    label: paddedLabel(item.name),
    meta: `${values[item.key]} · ${(item.key === 'motion' || item.key === 'turnDuration') ? 'Enter 切换' : item.key === 'paths' ? 'Enter 查看路径' : 'Enter 进入'}`,
    // 这一屏没有「当前那一条」这回事（四行都是入口，不是候选项）
    current: false,
    value: item.key,
    oneLine: true,
  }))
}

/**
 * 筛词中不中——**按屏上看得见的那些字筛**（名称 ＋ 当前值那一格）。
 *
 * 与 `/skills` / `/resume` 同一条口径（那两个也是拿**行上写着的字**筛）：用户打的词就在眼前，
 * 中不中他一眼看得出来。空词＝全中（退到空＝全表）。
 */
function hits(needle: string, name: string, value: string): boolean {
  return needle === '' || `${name} ${value}`.toLowerCase().includes(needle)
}

/**
 * 抽屉下方那行说明——**两件，谁说谁**：
 *
 * - **没在筛**：`回车＝进那一项`。这一屏的那件事（「选中 ⇒ 进它自己那一屏」）**别处一个字
 *   都没说**——状态行右位那句是通用的「回车 定」，而这里「定」下去发生的是**换一屏**
 *   （照 `/grants` 那句「回车＝撤销选定那条」的先例）；
 * - **在筛**：报出筛词。⚠️ **必须报**——输入被这一屏接管了，不报用户就看不见自己打的字
 *   去了哪儿（见 `Picker.filter` 的注）。0 行也照报：那时「没有这一项」**是一个回答**，
 *   不是一个空档（照 `/skills` 同一条）。
 */
export function configHint(input: {
  readonly filter: string

  /** 筛过之后还剩几行。 */
  readonly shown: number
}): string {
  if (input.filter === '') return ''
  return input.shown === 0
    ? `没有匹配「${input.filter}」的项——退格删一个字`
    : `筛选「${input.filter}」——接着打收窄，退格删一个字`
}

/** 第 4 项那一屏的抬头（纯输出那一块的头一行）。 */
export const CONFIG_PATHS_TITLE = '数据与工作区根'

/**
 * **第 4 项自己那一屏**——数据目录与工作区根，**两个完整值**（不缩、不截）。
 *
 * 为什么它有「一屏」而 `/model` 那三项是抽屉：那三项**各有自己改配置的地方**（选定就是进
 * 那儿去改），而这两件今天是**手改配置文件**才动得了的——它没有可进的入口，于是它自己
 * 那一屏就是**一份读出来的账**（同 `/status` 的姿势：纯输出进记录区，不是一个可操作的屏）。
 * 这也正是那一格在列表里截断、而这里必须写全的理由：**细节有地方看**。
 *
 * ⚠️ **多根时头一条标「默认根」**（`--check` 的 `describeRoots` 同一条口径）：相对路径与
 * 新文件落它——「平等平铺 ＋ 一个默认」里那个「默认」是**看得见**的一条。单根时不标
 * （没得比，标了是废话）。
 */
function configStatusLineValue(config: StatusLineConfig | undefined): string {
  const cells = statusLineCellsOf(config)
  if (cells.length === 0) return config === undefined ? '默认 · 只要状态那一格' : '只要状态那一格'

  const names = cells.map((key) => STATUS_LINE_CELLS.find((cell) => cell.key === key)?.name ?? key)
  return `${config === undefined ? '默认 · ' : ''}${names.join(' · ')}`
}

export const STATUSLINE_COLOR_ACTION = 'color'

export function statusLineRows(input: { readonly config: StatusLineConfig | undefined }): readonly PickerRow[] {
  const cells = statusLineCellsOf(input.config)
  return [
    ...STATUS_LINE_CELLS.map((cell) => {
      const at = cells.indexOf(cell.key)
      return {
        label: cell.name,
        // **顺序＝挑的先后**（先放上的排前面）——故这一格就是它显示在状态行里的位次
        meta: at === -1 ? '未放上' : `已放上 · 第 ${at + 1} 格`,
        current: at !== -1,
        value: cell.key as string,
        oneLine: true,
      }
    }),
    // **上色开关**——常驻末行（见头注）。`pinned` 那一格的语义是「这一行是入口，不是候选」。
    {
      label: '颜色',
      meta: statusLineColorOf(input.config) ? '已开' : '已关',
      current: statusLineColorOf(input.config),
      value: STATUSLINE_COLOR_ACTION,
      pinned: true,
      oneLine: true,
    },
  ]
}

/** 「状态行」那一屏下方那句话——**两件，谁说谁**（照 `/config` 那一屏的先例）。 */
export function statusLineHint(): string {
  return '回车＝放上或拿下 · 顺序就是放上的先后 · ← 退'
}

export function configPathLines(paths: ConfigPaths): readonly string[] {
  const lines: string[] = []
  if (paths.dataDir !== undefined) lines.push(`  数据目录　${paths.dataDir}`)
  const roots = paths.workspaceRoots ?? []
  roots.forEach((root, index) => {
    const mark = roots.length > 1 && index === 0 ? '（默认根）' : ''
    lines.push(`  工作区根　${root}${mark}`)
  })
  return lines
}

/**
 * **能挑的那几格**——顺序即那一屏上的顺序（不改：用户挑的是**放不放**与**摆哪儿**，
 * 不是「清单本身怎么排」）。
 *
 * 名字（`name`）就是屏上写的字，与 `PickerRow.label` 同一姿态：**不从键反推文案**。
 * `hint` 是「这一格拿不到时」那句——不摆在选择器里（那一屏只挑放不放），只写在回报与
 * 这一处，供人读懂「为什么有时候它不见了」。
 *
 * ⚠️ **锚那两格不在这张表里**（运行状态 · 全放行）——设计 · 终端交互「状态行可配置」
 * 只列了**可挑**的那几格，而「① 状态永不省」与「看不见的裸奔是最坏的一形」是既有的
 * 两条硬规矩（规划侧 2026-10-01 裁定：状态是这一行的锚，永远第一位、不可去）。
 */
export const STATUS_LINE_CELLS: readonly {
  readonly key: StatusLineCell
  readonly name: string

  /** 这一格「暂时不可用」时屏上怎么省（整格省掉，不占位、不显示空值）。 */
  readonly hint: string
}[] = [
    { key: 'session', name: '会话名', hint: '总有（还没有会话时写「新会话」）' },
    { key: 'model', name: '模型', hint: '还没跑过任何一次调用就省掉' },
    { key: 'reasoning', name: '思考档', hint: '那个模型没声明推理能力就省掉' },
    { key: 'context', name: '上下文占用', hint: '还没有用量读数就省掉' },
    { key: 'workspace', name: '工作区', hint: '不知道自己在哪个工作区就省掉' },
  ]

/**
 * **没配过时那一条**（设计：「默认给一条（不配也能用）」）。
 *
 * 两格：**会话名 ＋ 上下文占用**。⛔ **默认不放「用哪个模型」**——那是**配置回显**
 * （设计那条边界：默认那条不放配置回显，用户**自己勾**才算他要的）；用量那一格也不是
 * 回显，它是**此刻的实况**（这一问花了多少上下文）。
 */
export const STATUS_LINE_DEFAULT: readonly StatusLineCell[] = ['session', 'context']

/** 那一行要摆哪几格——**没配过就是默认那条**（`cells: []` 是合法值，会**原样保留**）。 */
export function statusLineCellsOf(config: StatusLineConfig | undefined): readonly StatusLineCell[] {
  return config?.cells ?? STATUS_LINE_DEFAULT
}

/** 上色开关——**缺省照常上色**（只有明确写了 `false` 才是关）。 */
export function statusLineColorOf(config: StatusLineConfig | undefined): boolean {
  return config?.color !== false
}
