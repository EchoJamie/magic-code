import type {
  MagicConfig,
  ModelCatalogRow,
  ModelChoice,
  ModelInfo,
  ModelRef,
  ModelSelectionRef,
  ReasoningSetting,
  ReasoningSupport,
  VendorInfo,
} from '@magic/contracts'
import { apiKeyEnvVarOf } from '@magic/contracts'
import { tokenLabel } from '../components/lines.ts'
import type { PickerRow } from '../view.ts'
import { dayLabel } from './time.ts'

/** **挑一家**那一屏的行（接入第一步）——取材就是答复里的那份名单。 */
export function vendorRows(vendors: readonly VendorInfo[]): readonly PickerRow[] {
  return vendors.map((one) => ({
    label: one.label,
    // 副文案**留空**：连接 id 就是它的名字（`MiniMax` / `minimax` 只差大小写）——
    // 区域与协议在连接编辑页集中选择。
    meta: '',
    current: false,
    value: one.vendor,
    oneLine: true,
  }))
}

/**
 * **`/model` 的行**——取材是**连接一览 ＋ 各自的缓存读数**（不再是「配置条目」）。
 *
 * 设计（模型与上下文 · 选择模型）：「先展示已有缓存，再按需刷新」「**行主文案为模型名，
 * 副文案为供应商/连接名**」「实际选择键是"连接 id ＋ 精确模型 id"」。
 *
 * 三条分寸写在行里：
 * - **只列适用于对话的**（`capabilities.chat === false` 的不混入——设计 · 列表取舍）
 *   而那判据**只认 API 给的**：这一位**缺省＝未知**，未知照列（不冒充「不支持」）；
 * - **已有选择照留**：不在最近一次列表里的那个模型**仍然列着**并标明这一事实
 *   （设计：「模型不在最新列表时，已有选择仍明确保留并提示此事实」）；
 * - **副文案是连接名**（缺省＝id）：合法的两条连接可以有同名模型，认谁就看这一格。
 */
export const modelLabel = (choice: ModelChoice): string => choice[0]!.toUpperCase() + choice.slice(1)

export function modelSettingsRows(entries: readonly ModelCatalogRow[], configuredModels: NonNullable<MagicConfig['models']>, current: ModelSelectionRef | ModelRef | null = null, target = '当前工作'): readonly PickerRow[] {
  return [
    ...(['default', 'cantrip', 'spell', 'arcane'] as const).map(choice => ({
      label: `${choice === 'default' ? '默认模型' : '模型档位'} · ${modelLabel(choice)}`,
      meta: configuredModels[choice] === undefined ? '尚未配置' : `${configuredModels[choice]!.provider} · ${configuredModels[choice]!.model}`,
      value: `edit:${choice}`,
      current: false,
      oneLine: true,
    })),
    {
      label: `${target} · 选择模型`,
      meta: current !== null && 'choice' in current ? `当前 ${modelLabel(current.choice as ModelChoice)}；选择只影响此对象` : '尚未选择；Default 或三个能力档位',
      value: 'choose',
      current: false,
      oneLine: true
    },
    { label: '思考等级', meta: '独立设置当前模型的推理投入', value: 'reasoning', current: false, oneLine: true },
    ...modelActionRows(entries),
  ]
}

export function modelChoiceRows(configuredModels: NonNullable<MagicConfig['models']>, current: ModelRef | null): readonly PickerRow[] {
  return (['default', 'cantrip', 'spell', 'arcane'] as const).map(choice => ({
    label: modelLabel(choice),
    value: choice,
    current: current !== null && 'choice' in current && current.choice === choice,
    meta: configuredModels[choice] === undefined ? '尚未配置；请返回模型设置' : `${configuredModels[choice]!.provider} · ${configuredModels[choice]!.model}`,
    oneLine: true,
  }))
}

export function modelRows(
  entries: readonly ModelCatalogRow[],
  current: ModelRef | null,
  configuredModels: NonNullable<MagicConfig['models']> = {},
): readonly PickerRow[] {
  const rows: PickerRow[] = []
  for (const entry of entries) {
    const connection = entry.name ?? entry.provider
    for (const one of modelsOf(entry, current, Object.values(configuredModels))) {
      rows.push({
        label: one.info.name ?? one.info.id,
        // 连接名打头（窄窗先保住它——同名模型靠它分辨），其后才是补充的那几格
        meta: [connection, ...(tailOf(one, entry) ?? [])].join(' · '),
        current:
          current !== null && current.provider === entry.provider && current.model === one.info.id,
        // `value` 只作行与行之间的区分（选定带的是 `pick` 那两件，见 `PickerRow.pick`）
        value: `${entry.provider} ${one.info.id}`,
        pick: { provider: entry.provider, model: one.info.id },
        oneLine: true,
        keep: connection,
      })
    }
  }
  return [...rows, ...(entries.length ? [{ label: '手动填写模型', meta: '无需列表命中', value: 'manual', current: false, oneLine: true }] : []), ...modelActionRows(entries)]
}

export function modelActionRows(entries: readonly ModelCatalogRow[]): readonly PickerRow[] {
  const rows: PickerRow[] = [
    { label: '连接供应商', meta: '', current: false, value: 'connect', oneLine: true, pinned: true },
  ]
  if (entries.length > 0) {
    rows.push({
      label: '管理连接',
      meta: `${entries.length} 条连接`,
      current: false,
      value: 'manage',
      oneLine: true,
      pinned: true,
    })
    rows.push({
      label: '刷新模型',
      meta: '现在就去供应商那儿取一遍',
      current: false,
      value: 'refresh',
      oneLine: true,
      pinned: true,
    })
  }
  return rows
}

function modelsOf(
  entry: ModelCatalogRow,
  current: ModelRef | null,
  configured: readonly ModelRef[] = [],
): readonly { readonly info: ModelInfo; readonly cached: boolean }[] {
  const cached = (entry.cache?.snapshot?.models ?? []).filter(
    // **列表取舍**：明确说了「不适用于对话」的不混入（`false` 才排除；**未知照列**）
    (one) => one.capabilities?.chat !== false,
  )

  const manual = Object.keys(entry.modelOverrides ?? {}).filter(id => !cached.some(one => one.id === id)).map(id => ({ id }))

  const out = [...cached, ...manual].map((info) => ({ info, cached: true }))

  const has = (id: string): boolean => out.some((one) => one.info.id === id)
  // ② **实际当前那条**——同上，一条都不能丢（设计：「模型不在最新列表时，已有选择仍明确
  //    保留并提示此事实」；这里连「它是不是默认」都不假设）
  if (current !== null && current.provider === entry.provider && !has(current.model)) {
    out.push({ info: { id: current.model }, cached: false })
  }
  for (const ref of configured) {
    if (ref.provider === entry.provider && !has(ref.model)) out.push({ info: { id: ref.model }, cached: false })
  }
  return out
}

/** 副文案里连接名之后的那几格——**只在真有话要说时才给**（没有就一个字不加）。 */
function tailOf(
  one: { readonly info: ModelInfo; readonly cached: boolean },
  entry: ModelCatalogRow,
): readonly string[] | undefined {
  const parts: string[] = []
  // **显示名与 id 不是同一个**时把 id 报出来（送出去的是它——用户核对得到）
  if (one.info.name !== undefined && one.info.name !== one.info.id) parts.push(one.info.id)
  if (!one.cached) parts.push('不在最近一次列表里')
  if (entry.vendor === undefined && entry.cache === undefined) parts.push('兼容接入')
  return parts.length === 0 ? undefined : parts
}

/** 管理面那一行连接长什么样（副文案）——**只报手上有的事实**，没有的不编。 */
export function manageMetaOf(entry: ModelCatalogRow): string {
  const parts = [entry.vendor ?? '兼容接入']
  if (entry.region !== undefined) parts.push(entry.region)
  parts.push(authLabelOf(entry))
  return parts.join(' · ')
}

/**
 * 认证来处那一句——**说清是哪儿来的**，不含糊说「已设置」（设计 · 维护连接）。
 * 两处都没有（这条连接还没有可用认证）＝**如实说没有**。
 */
export function authLabelOf(entry: ModelCatalogRow): string {
  if (entry.auth === 'none') return '认证：无需认证'
  if (entry.keySource === 'config') return '认证：配置文件'
  if (entry.keySource === 'env') return `认证：环境变量 ${apiKeyEnvVarOf(entry.provider)}`
  return '认证：还没有'
}

/** 缓存那半句——几个模型 / 什么时候取的 /（有则）这次没刷成。 */
export function cacheLabelOf(entry: ModelCatalogRow): string {
  const cache = entry.cache
  if (cache?.snapshot === undefined) return cache?.refreshing === true ? '正在取' : '还没取过'
  const count = `${cache.snapshot.models.length} 个模型`
  const when = dayLabel(cache.snapshot.fetchedAt)
  return cache.failure === undefined ? `${count} · ${when} 取的` : `${count} · ${when} 取的（上次没刷成）`
}

export function reasoningRows(
  support: ReasoningSupport | undefined,
  current: ReasoningSetting | null,
): readonly PickerRow[] {
  const setting: ReasoningSetting = current ?? { mode: 'default' }

  const mark = (one: ReasoningSetting): boolean =>
    one.mode === setting.mode &&
    (one.mode !== 'level' || (setting.mode === 'level' && one.level === setting.level)) &&
    (one.mode !== 'budget' || (setting.mode === 'budget' && one.budgetTokens === setting.budgetTokens))
  const rows: PickerRow[] = [
    {
      label: '模型默认',
      meta: '不发送思考参数，服务端自己定',
      current: mark({ mode: 'default' }),
      value: 'default',
      reasoning: { mode: 'default' },
      oneLine: true,
    },
  ]
  if (support?.disable === true) {
    rows.push({
      label: '明确关闭',
      meta: '说了别想（与「默认」不是一回事）',
      current: mark({ mode: 'off' }),
      value: 'off',
      reasoning: { mode: 'off' },
      oneLine: true,
    })
  }
  for (const level of support?.levels ?? []) {
    rows.push({
      label: level,
      meta: '档位',
      current: mark({ mode: 'level', level }),
      value: `level:${level}`,
      reasoning: { mode: 'level', level },
      oneLine: true,
    })
  }
  if (support?.budget !== undefined) rows.push({
    label: '指定 token 预算',
    meta: setting.mode === 'budget' ? String(setting.budgetTokens) : '输入范围内的正整数',
    current: setting.mode === 'budget',
    value: 'budget',
    oneLine: true
  })
  return rows
}

/** 思考那一屏上方那句实话——**这个模型声明了什么，就说什么**（没声明＝如实说没有）。 */
export function reasoningHint(support: ReasoningSupport | undefined): string {
  if (support === undefined) return '这个模型没有声明思考档位——只能按模型默认用'
  const parts: string[] = []
  if (support.levels !== undefined && support.levels.length > 0) parts.push(`${support.levels.length} 个档位`)
  if (support.disable === true) parts.push('可明确关闭')
  if (support.budget !== undefined) parts.push(`token 预算 ${support.budget.minTokens ?? '未声明下限'} ～ ${support.budget.maxTokens ?? '未声明上限'}`)
  return parts.length === 0
    ? '这个模型没有声明思考档位——只能按模型默认用'
    : `这个模型支持：${parts.join(' · ')}`
}

/**
 * `/model` 列表下方那行说明——**只说有事要说的那几件**。
 *
 * 三件由头（各自都在别处查不到）：
 * - **缓存的状态**：还没取过 / 正在取 / 过期 / 上次没取成——「能用不能用、新不新」是用户此刻
 *   唯一要判断的事（设计：「失败……返回最后成功时间与本次失败原因」）；
 * - **三个动作怎么走**：它们沿 `/model` 展开（设计：不再新增一组按内部能力命名的 slash
 *   命令），故得在这儿指出来；
 * - **内核那句 `note`**（有则）——装配有话说时说（如「本次装配没有注册表」）。
 *
 * ⚠️ **更新时间只在这里出现一次**（过期的那些），新鲜的连接**不报时间**：设计写的是
 * 「供应商信息与更新时间**按需**可见」——按需＝详情里查得到，不是每个连接都在列表上挂一行。
 */

/**
 * 那一行说明里**最多逐条报几条连接**——实现级常量。
 *
 * 由头（真跑量出来的）：这一行原先**没有上界**——30 条「还没取过」的连接就是 30 行说明，
 * 而说明是**候选窗口之外**另加的，于是交互区一路长到把记录区整个顶出屏幕
 * （真 PTY 60×24 · 30 条连接实测：分隔线以上一行不剩）。
 *
 * 取 3 的由头：它是一屏里「还看得过来」的条数；再多就**折起来报数**并指到 `/model manage`
 * （那里逐条列着每条连接的认证与缓存读数，正是「到底哪条有状况」该去的地方）。
 */
const MAX_MODEL_NOTES = 3

/** 默认模型或档位映射编辑，与工作选择分开。 */
export type ModelScope = 'session' | ModelChoice

export function modelHint(
  entries: readonly ModelCatalogRow[],
  note?: string,
  scope: ModelScope = 'session',
): string {
  const lines: string[] = []
  for (const entry of entries) {
    const connection = entry.name ?? entry.provider
    const cache = entry.cache
    if (cache?.snapshot === undefined) {
      lines.push(
        cache?.refreshing === true
          ? `${connection}：正在取模型列表……`
          : `${connection}：还没取过模型`,
      )
    } else if (cache.stale === true) {
      lines.push(
        cache.refreshing === true
          ? `${connection}：列表是 ${dayLabel(cache.snapshot.fetchedAt)} 取的，正在重新去取`
          : `${connection}：列表是 ${dayLabel(cache.snapshot.fetchedAt)} 取的（过期了）`,
      )
    }
    // 失败**照说**，哪怕旧列表还在用（「有旧缓存而这次没刷成」是两件事，得都说清）
    if (cache?.failure !== undefined) lines.push(`${connection}：上次没取成——${cache.failure.reason}`)
  }
  // 「详情」那一个键放在这儿（不在右位）：右位那条键位提示是**共用**的
  // （`HINT_PICKER`，五扇抽屉同一句），各屏另加一个键就得各写一句——而它一变，
  // 认它当判据的装置（`app/test/ui/scenarios.ts` 的抽屉场景）当场全红。
  // 列表下方报键位有先例（`/grants` 的「回车＝撤销选定那条」），照它。
  // **折起来如实报数**（见 `MAX_MODEL_NOTES`）——超出的那几条不逐行铺，指到管理页去
  const heads = lines.slice(0, MAX_MODEL_NOTES)
  const rest = lines.length - heads.length
  if (rest > 0) heads.push(`… 另有 ${rest} 条连接也有状况——/model manage 里逐条看`)
  if (entries.length === 0) heads.push('还没有接上任何供应商')
  if (note !== undefined && note !== '') heads.push(note)
  if (scope !== 'session') heads.unshift(`配置 ${modelLabel(scope)}：选定实际型号后保存；当前工作不受影响`)
  return heads.join('\n')
}

export function reasoningText(setting: ReasoningSetting): string {
  if (setting.mode === 'off') return '不思考'
  if (setting.mode === 'default') return '思考·默认'
  if (setting.mode === 'budget') return `思考·${tokenLabel(setting.budgetTokens)}`
  return `思考·${setting.level === 'low' ? '低' : setting.level === 'medium' ? '中' : '高'}`
}

export function configReasoningOf(current: ModelSelectionRef | null): ReasoningSetting | undefined {
  if (current === null) return undefined
  return 'reasoning' in current ? current.reasoning as ReasoningSetting | undefined : undefined
}
