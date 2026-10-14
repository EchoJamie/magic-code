import type { PathCatalogRow, SkillCatalogRow } from '@magic/contracts'
import type { PickerRow, SkillsCatalog } from '../view.ts'

export type SkillHit =
  | { readonly kind: 'one'; readonly skill: SkillCatalogRow }
  | { readonly kind: 'none' }

/**
 * **同名直达**（`/<名称>` 敲回车那条路）——解析出发现面留下的那一份。
 *
 * 按名字取**第一份**（而不是断言「只有一份」）：发现面保证一个名字只产出一条，
 * 故这里是那条保证的消费口；真有不唯一的情形（桩、或将来别处喂进来的清单），
 * 取的也是**次序里靠前的那一份**——那正是发现层的规则，不另立一套。
 */
export function resolveSkill(name: string, catalog: readonly SkillCatalogRow[]): SkillHit {

  const one = catalog.find((skill) => skill.name === name)
  return one === undefined ? { kind: 'none' } : { kind: 'one', skill: one }
}

export function skillRows(
  catalog: readonly SkillCatalogRow[],
  filter = '',
): readonly PickerRow[] {
  const needle = filter.trim().toLowerCase()
  const rows: PickerRow[] = []
  for (const skill of catalog) {
    // 筛词仍认来源（它是这一项的**事实**，只是不再印在行上）——`/skills users` 这类
    // 按来源找的用法照旧管用，且不因为「不显示」就丢
    const haystack = `${skill.name} ${skill.label} ${skill.description}`.toLowerCase()
    if (needle !== '' && !haystack.includes(needle)) continue
    rows.push({
      label: skill.name,
      meta: skill.description,
      current: false,
      value: skill.path,
      detail: [`来源：${skill.path}`, `用途：${skill.description}`],
      oneLine: true,
    })
  }
  return rows
}

export function pathRows(rows: readonly PathCatalogRow[]): readonly PickerRow[] {
  return rows.map((row) => ({
    label: row.external ? `${row.display}（工作区外 · 只读）` : row.display,
    meta: row.kind === 'directory' ? '目录' : '文件',
    current: false,
    value: row.path,
    detail: [`路径：${row.path}`],
    oneLine: true,
  }))
}

export function pathHint(input: {
  readonly filter: string
  readonly shown: number

  /**
   * **这一趟还没回来**（边打边问，答复在路上）——见下。
   *
   * 为什么要有这一位：清单为空有两件不同的事实——「这一步对不上」与「还在看」。
   * 混成一句的话，用户刚打下一个字就被告知「没有对得上的」（而他明明有），
   * 那句话**当场就是假的**。拿不到的不编：正在看就说正在看。
   */
  readonly pending?: boolean
  readonly note?: string | undefined
}): string {
  const lines: string[] = []
  if (input.shown === 0 && input.pending === true) {
    lines.push('正在看这个写法……')
  } else if (input.shown === 0) {
    // 一条都没有时：内核那句说明优先（它说得出为什么），否则**指路**（怎么把它打出来）
    lines.push(input.note ?? '这一步没有对得上的——把路径打全，或退格换个写法')
  } else {
    lines.push(
      input.filter === ''
        ? '选一条放进这句话里（Tab 补全；目录再往里看一层）'
        : '接着打收窄，退格删一个字（Tab 补全）',
    )
    if (input.note !== undefined) lines.push(input.note)
  }
  return lines.join('\n')
}

/**
 * 列表下方那行说明——**筛选状态 · 空名录的出口 · 没读进来的那些**（各自说不同的东西）。
 *
 * 空名录指向的是**放哪儿**（设计：「空列表指向 `.magic/skills/<名称>/SKILL.md`」）——
 * 不解一句「没有技能」，那等于说了等于没说。
 *
 * 没读进来的只报**份数**：那些话（「front-matter 缺 `description`」一类）本来就是
 * `--check` 那一屏的正文，一条条搬进抽屉会把列表挤没；而**一个字不说**更坏——
 * 用户写了一份技能却发现它不在列表里，只能对着它发呆（静默丢弃是这一族最坏的形态）。
 * 故报数 ＋ 指路：`magic --check` 里逐条说得清。
 */
export function skillHint(input: {
  readonly catalog: SkillsCatalog | null
  readonly filter: string

  /** 筛选后的候选数。 */
  readonly shown: number
}): string {
  const { catalog, filter, shown } = input
  const lines: string[] = []
  // ⚠️ 这里原有一条「「x」有 N 份同名的——按来源挑一份」：它是「同名 ⇒ 展开候选」那一手
  // 的说明，随 2026-09-25 的裁定去掉（同名在发现那一层只剩一条，那一屏再也开不出来）。
  if (shown === 0 && filter !== '') {
    // 零命中仍允许修改筛词或返回。
    lines.push(`没有匹配「${filter}」的技能——退格删一个字，或换个词再打 /skills`)
  } else if (filter !== '') {
    lines.push(`筛选「${filter}」——接着打收窄，退格删一个字`)
  } else if ((catalog?.skills.length ?? 0) === 0) {
    lines.push('还没有技能——放一份 .magic/skills/<名称>/SKILL.md 就来')
  } else {
    lines.push('直接打字可筛选 · ↑↓ 候选 · Enter 引用 · Esc 返回')
  }

  const broken = catalog?.problems.filter((one) => one.kind === 'error').length ?? 0
  if (broken > 0) lines.push(`有 ${broken} 份没能读进来——magic --check 里逐条说得清`)
  return lines.join('\n')
}
