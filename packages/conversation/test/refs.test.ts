/**
 * U36 · 引用在对话域的那一半 —— **按位置取齐 · 按位置展开**。
 *
 * 三件各咬一处：
 * - **送达**（`createRefDelivery`）：一份取不到整条不跑（不换同名项、不发残缺输入）；
 *   技能名与来源**取读回来的那一份**（外壳带过来的只是正文里那几个字）；
 * - **装配**（`assembleContext`）：材料**展开在它被说出来的那个位置**，正文一个字不剥；
 * - **旧记录**：`UserPayload.skills`（无位置那一形）照旧统一前置（不替它编插入点）。
 *
 * 域内件测试（相对路径取 `../src/…`）；真装配 · 真模型请求那条路由
 * `packages/app/test/refs.test.ts` 咬。
 */

import { describe, expect, test } from 'bun:test'
import type {
  InputRef,
  InputRefEntry,
  MaterialLoad,
  MaterialRequest,
  Materials,
  ModelMessage,
  Skill,
  SkillCatalog,
  SkillRead,
  Skills,
} from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { assembleContext, inlineOf, refsPayloadOf } from '../src/context.ts'
import { createRefDelivery } from '../src/refs.ts'

const AT = 1_700_000_000_000
const SYSTEM = '## 身份\n你是 Magic Code。'

const REVIEW: Skill = {
  name: 'review',
  description: '按这份清单检查改动',
  path: '/ws/.magic/skills/review',
  source: 'project',
  origin: 'magic',
  label: '项目 .magic/skills',
}

function stubSkills(name = 'review'): Skills {
  const skill = { ...REVIEW, name }
  return {
    discover: (): SkillCatalog => ({ skills: [skill], problems: [] }),
    readMain: (): SkillRead => ({ ok: true, material: { skill, text: '逐条核对清单。' } }),
    readReference: () => ({ ok: false, reason: '没用到' }),
  }
}

/** 桩材料面——按路径表给正文；表里没有的＝取不到。 */
function stubMaterials(files: Readonly<Record<string, string>>): Materials {
  return {
    load: async (requests: readonly MaterialRequest[]): Promise<MaterialLoad> => {
      const materials = []
      for (const request of requests) {
        const text = files[request.source]
        if (text === undefined) return { ok: false, reason: `取不到「${request.source}」` }

        materials.push(
          request.kind === 'dir'
            ? { kind: 'dir' as const, path: request.source, label: request.source, text }
            : { kind: 'file' as const, path: request.source, label: request.source, text },
        )
      }

      return { ok: true, materials }
    },
    candidates: async () => ({ rows: [] }),
  }
}

/** 一处引用（命令面形态）——三支各有一份现成的写法，用例里少写点字。 */
function skillRef(at: number, marker = '/review'): InputRef {
  return { kind: 'skill', at, marker, name: 'review', source: REVIEW.path }
}

function fileRef(at: number, marker: string, source = '/ws/src/login.ts'): InputRef {
  return { kind: 'file', at, marker, source }
}

// ══ 送达 ══════════════════════════════════════════════════════════════

describe('U36 · 送达：按位置取齐', () => {
  test('三处引用（文件 / 技能 / 文件）按位置排好——**只排序、不改次序**', async () => {
    const delivery = createRefDelivery({
      skills: stubSkills(),
      materials: stubMaterials({
        '/ws/需求.md': '要求：先看登录',
        '/ws/src/login.ts': 'export const login = () => {}',
      }),
    })

    const loaded = await delivery.load([
      fileRef(4, '@需求.md', '/ws/需求.md'),
      skillRef(10, '/review'),
      fileRef(21, '@src/login.ts'),
    ])

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    expect(loaded.refs.map((ref) => [ref.kind, ref.at, ref.marker])).toEqual([
      ['file', 4, '@需求.md'],
      ['skill', 10, '/review'],
      ['file', 21, '@src/login.ts'],
    ])
    // 内容随引用一起落定（技能名与来源**取读回来的那一份**）
    expect(loaded.refs[0]?.text).toBe('要求：先看登录')
    expect(loaded.refs[1]?.source).toBe(REVIEW.path)
    expect(loaded.refs[1]?.text).toBe('逐条核对清单。')
  })

  test('乱序给进来也按位置排（位置是那一处引用自己的，不靠数组顺序）', async () => {
    const delivery = createRefDelivery({ skills: stubSkills(), materials: stubMaterials({}) })

    const loaded = await delivery.load([skillRef(20), skillRef(3, '/review'), skillRef(11)])

    expect(loaded.ok && loaded.refs.map((ref) => ref.at)).toEqual([3, 11, 20])
  })

  test('**一份取不到，整条不跑**（不换同名项、不发残缺输入）', async () => {
    const delivery = createRefDelivery({
      skills: stubSkills(),
      materials: stubMaterials({ '/ws/需求.md': '要求' }),
    })

    const loaded = await delivery.load([fileRef(0, '@需求.md', '/ws/需求.md'), fileRef(9, '@src/login.ts')])

    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.reason).toContain('取不到')
  })

  test('装配没接材料来源 ⇒ 带文件引用的那一条不跑（不当作没有引用继续）', async () => {
    const delivery = createRefDelivery({ skills: stubSkills() })

    const loaded = await delivery.load([fileRef(0, '@src/login.ts')])

    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.reason).toContain('没跑')
  })

  test('技能取不到同一条出口（**不换同名项**）', async () => {
    const skills: Skills = {
      discover: () => ({ skills: [], problems: [] }),
      readMain: () => ({ ok: false, reason: '技能「review」在 /ws/.magic/skills/review 上不再成立' }),
      readReference: () => ({ ok: false, reason: '没用到' }),
    }

    const loaded = await createRefDelivery({ skills }).load([skillRef(0)])

    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.reason).toContain('不再成立')
  })
})

// ══ 展开 ══════════════════════════════════════════════════════════════

describe('U36 · 展开：材料摆在它被说出来的那个位置', () => {
  const refs: readonly InputRefEntry[] = [
    {
      kind: 'file',
      at: 4,
      marker: '@需求.md',
      source: '/ws/需求.md',
      label: '需求.md',
      text: '要求：先看登录',
    },
    {
      kind: 'skill',
      at: 14,
      marker: '/review',
      name: 'review',
      source: REVIEW.path,
      label: REVIEW.label,
      text: '逐条核对清单。',
    },
    {
      kind: 'file',
      at: 25,
      marker: '@src/login.ts',
      source: '/ws/src/login.ts',
      label: 'src/login.ts',
      text: 'export const login = () => {}',
    },
  ]

  test('正文一个字不剥，材料紧跟在那一处引用之后（前后文字仍指向原对象）', () => {
    const said = inlineOf('先读 @需求.md，再按 /review 检查 @src/login.ts', refs)

    // 那句原话的次序没被打乱：三处引用各自后面跟着自己那份材料
    const first = said.indexOf('要求：先看登录')
    const second = said.indexOf('逐条核对清单。')
    const third = said.indexOf('export const login')
    expect(first).toBeGreaterThan(said.indexOf('@需求.md'))
    expect(second).toBeGreaterThan(said.indexOf('/review'))
    expect(third).toBeGreaterThan(said.indexOf('@src/login.ts'))
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)

    // 前后文字都在（一个字不剥）
    expect(said).toContain('先读 @需求.md')
    expect(said).toContain('再按 /review')
    expect(said).toContain('检查 @src/login.ts')
  })

  test('材料有明确的来源边界（抬头 ＋ 结尾）——技能与文件分得开', () => {
    const said = inlineOf('看 @需求.md 与 /review', refs)

    expect(said).toContain('〔本次材料 · 文件 需求.md〕')
    expect(said).toContain('〔材料完 · 需求.md〕')
    expect(said).toContain('〔本次技能 · review（来源 项目 .magic/skills）〕')
    expect(said).toContain('〔技能完 · review〕')
  })

  test('截断 / 未展开在抬头就说清（不静默缺材料）', () => {
    const said = inlineOf('看 @big.txt 与 @src/', [
      {
        kind: 'file',
        at: 2,
        marker: '@big.txt',
        source: '/ws/big.txt',
        label: 'big.txt',
        text: 'xxxx',
        truncated: true,
      },
      {
        kind: 'dir',
        at: 14,
        marker: '@src/',
        source: '/ws/src',
        label: 'src',
        text: 'a.ts\nsub/',
        omitted: 12,
      },
    ])

    expect(said).toContain('（原文更长，这里是前一段）')
    expect(said).toContain('（只列了这一层，另有 12 项未列）')
  })

  test('工作区外那一份标「只读附件」', () => {
    const said = inlineOf('看 @/etc/hosts', [
      {
        kind: 'file',
        at: 2,
        marker: '@/etc/hosts',
        source: '/etc/hosts',
        label: '/etc/hosts',
        text: '127.0.0.1 localhost',
        external: true,
      },
    ])

    expect(said).toContain('（工作区外 · 只读附件）')
  })

  test('位置越界一律夹回（材料宁可摆在末尾，也不丢、也不插进一句话中间）', () => {
    const said = inlineOf('很短', [
      { kind: 'file', at: 99, marker: '@x', source: '/ws/x', label: 'x', text: '正文' },
    ])

    expect(said).toContain('很短')
    expect(said).toContain('正文')
  })

  test('全角 / 中文正文里位置不串（按码元切，不从字面猜）', () => {
    const said = inlineOf('第一句：@甲.txt 之后', [
      { kind: 'file', at: 4, marker: '@甲.txt', source: '/ws/甲.txt', label: '甲.txt', text: '甲的内容' },
    ])

    expect(said.startsWith('第一句：@甲.txt\n')).toBe(true)
    expect(said).toContain('甲的内容')
    expect(said.endsWith(' 之后')).toBe(true)
  })
})

// ══ 装配（条目 → 消息）════════════════════════════════════════════════

describe('U36 · 装配：走记录里那一份，不重读文件', () => {
  test('带引用的交代：正文与材料都在，位置对得上', async () => {
    const records = makeFauxRecords()
    records.appendEntry({
      kind: 'user',
      content: { text: '先读 @需求.md，再按 /review 检查 @src/login.ts' },
      payload: {
        refs: [
          { kind: 'file', at: 3, marker: '@需求.md', source: '/ws/需求.md', label: '需求.md', text: '要求：先看登录' },
          {
            kind: 'skill',
            at: 13,
            marker: '/review',
            name: 'review',
            source: REVIEW.path,
            label: REVIEW.label,
            text: '逐条核对清单。',
          },
        ],
      },
      at: AT,
    })

    const messages = await assembleContext({ records, session: 's1', systemPrompt: SYSTEM })
    const user = messages.find((one): one is Extract<ModelMessage, { role: 'user' }> => one.role === 'user')

    expect(user?.content).toContain('要求：先看登录')
    expect(user?.content).toContain('逐条核对清单。')
    // 位置：需求在 `/review` **之前**（它是句首那一处引用的材料）
    expect(user?.content.indexOf('要求：先看登录')).toBeLessThan(
      user?.content.indexOf('/review') ?? Number.POSITIVE_INFINITY,
    )
  })

  test('重放不重读文件：源改了，历史那一份照旧', async () => {
    const records = makeFauxRecords()
    records.appendEntry({
      kind: 'user',
      content: { text: '看 @a.txt' },
      payload: {
        refs: [{ kind: 'file', at: 2, marker: '@a.txt', source: '/ws/a.txt', label: 'a.txt', text: '当时那一份' }],
      },
      at: AT,
    })

    const messages = await assembleContext({ records, session: 's1', systemPrompt: SYSTEM })
    const user = messages.find((one) => one.role === 'user')

    expect(user?.content).toContain('当时那一份')
  })

  test('旧记录（`skills`，无位置）照旧统一前置——不替它编插入点', async () => {
    const records = makeFauxRecords()
    records.appendEntry({
      kind: 'user',
      content: { text: '照它做' },
      payload: { skills: [{ name: 'review', source: REVIEW.path, label: REVIEW.label, text: '逐条核对清单。' }] },
      at: AT,
    })

    const messages = await assembleContext({ records, session: 's1', systemPrompt: SYSTEM })
    const user = messages.find((one) => one.role === 'user')

    // 旧形的抬头照旧（`本次使用技能：`）——那是它当时的样子
    expect(user?.content).toContain('本次使用技能：review')
    expect(user?.content.indexOf('逐条核对清单。')).toBeLessThan(user?.content.indexOf('照它做') ?? 0)
  })

  test('载荷收窄：缺件的条目**不当作材料**（当作没有）', () => {
    // 手搓的残件（库里真出现这种行时，读的那一头不能把它当成一份材料）
    const broken = (payload: unknown): ReturnType<typeof refsPayloadOf> =>
      refsPayloadOf(payload as never)

    expect(broken({ refs: [{ kind: 'file', at: 0, marker: '@x' }] })).toEqual([])
    expect(broken({ refs: [{ kind: 'skill', at: 0, marker: '/a', name: 'a', source: '/p' }] })).toEqual([])
    expect(broken({ skills: [] })).toEqual([])
    expect(refsPayloadOf(undefined)).toEqual([])
  })
})
