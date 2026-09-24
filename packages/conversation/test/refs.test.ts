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
import type { TextRefEntry } from '../src/context.ts'
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

/**
 * 一处引用（记录侧形态）的**文本**——U37 起 `InputRefEntry` 多了图片支（它没有 `text`，
 * 内容是字节），故取正文前先收窄（不 `as`）。
 */
function textOfRef(ref: InputRefEntry | undefined): string | undefined {
  return ref === undefined || ref.kind === 'image' ? undefined : ref.text
}

/** 一条用户消息的正文（U37 起可能是**部件串**——带图那条）——只取文字那几件。 */
function textOfUser(message: ModelMessage | undefined): string {
  if (message === undefined || message.role !== 'user') return ''
  const content = message.content

  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
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
    expect(textOfRef(loaded.refs[0])).toBe('要求：先看登录')
    expect(loaded.refs[1]?.source).toBe(REVIEW.path)
    expect(textOfRef(loaded.refs[1])).toBe('逐条核对清单。')
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
  const refs: readonly TextRefEntry[] = [
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

  /**
   * ⚠️ **技能那一处的抬头不带来源**（2026-09-25 用户裁）：同名只留一条之后名字已唯一，
   * 来源对模型是没有信息量的额外字。文件 / 目录那两处仍写路径——那是**这份材料本身**
   * （模型要知道读的是哪一份文件），与技能的「来源」不是一回事。
   */
  test('材料有明确的边界（抬头 ＋ 结尾）——技能与文件分得开', () => {
    const said = inlineOf('看 @需求.md 与 /review', refs)

    expect(said).toContain('〔本次材料 · 文件 需求.md〕')
    expect(said).toContain('〔材料完 · 需求.md〕')
    expect(said).toContain('〔本次技能 · review〕')
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

    const said = textOfUser(user)
    expect(said).toContain('要求：先看登录')
    expect(said).toContain('逐条核对清单。')
    // 位置：需求在 `/review` **之前**（它是句首那一处引用的材料）
    expect(said.indexOf('要求：先看登录')).toBeLessThan(said.indexOf('/review'))
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

    expect(textOfUser(user)).toContain('当时那一份')
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
    const said = textOfUser(user)
    expect(said).toContain('本次使用技能：review')
    expect(said.indexOf('逐条核对清单。')).toBeLessThan(said.indexOf('照它做'))
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

// ══ U37 · 图片：字节落 blob，进请求的是图像部件 ═════════════════════════

/** 判据：**图片不走文本那几条尺子**（字节原样落库 / 原样进请求），且**一路不回头读原文件**。 */
describe('U37 · 图片引用：字节落 blob，装配成图像部件', () => {
  /** 1×1 真 PNG（67 字节）——这里当「用户选的那张图」。 */
  const PNG = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )

  /** 材料面桩——只给图片那一支（文本那几支别的用例在验）。 */
  function imageMaterials(): Materials {
    return {
      load: async (requests: readonly MaterialRequest[]): Promise<MaterialLoad> => ({
        ok: true,
        materials: requests.map((request) => ({
          kind: 'image' as const,
          path: request.source,
          label: request.source,
          name: 'shot.png',
          mime: 'image/png',
          bytes: PNG,
        })),
      }),
      candidates: async () => ({ rows: [] }),
    }
  }

  test('送达：材料那几格落进条目，字节**另存 blob**（条目载荷里放不下字节）', async () => {
    const records = makeFauxRecords()
    const delivery = createRefDelivery({
      skills: stubSkills(),
      materials: imageMaterials(),
      blobs: records.blobs,
    })

    const loaded = await delivery.load([
      { kind: 'file', at: 4, marker: '@shot.png', source: '/ws/shot.png' },
    ])

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const ref = loaded.refs[0]
    expect(ref?.kind).toBe('image')
    if (ref?.kind !== 'image') return

    expect(ref.name).toBe('shot.png')
    expect(ref.mime).toBe('image/png')
    expect(ref.marker).toBe('@shot.png')
    expect(ref.source).toBe('/ws/shot.png')
    // 逐字节存进去了（引用不透明，按契约取回来验）
    expect([...(await records.blobs.get(ref.blob))]).toEqual([...PNG])
  })

  test('没接 blob 落点 ⇒ **这一条不跑**（不静默丢图发文字）', async () => {
    const delivery = createRefDelivery({ materials: imageMaterials() })

    const loaded = await delivery.load([
      { kind: 'file', at: 0, marker: '@shot.png', source: '/ws/shot.png' },
    ])

    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.reason).toContain('blob')
  })

  test('从历史取回的那一张：**不碰材料面**（源文件删了也取回得来）', async () => {
    let asked = 0
    const delivery = createRefDelivery({
      materials: {
        load: async (): Promise<MaterialLoad> => {
          asked += 1
          return { ok: false, reason: '不该走到这儿——历史那一张不按路径读' }
        },
        candidates: async () => ({ rows: [] }),
      },
    })

    const loaded = await delivery.load([
      {
        kind: 'image',
        at: 0,
        marker: '@shot.png',
        source: '/ws/shot.png',
        label: 'shot.png',
        name: 'shot.png',
        mime: 'image/png',
        blob: 'blob_7',
      },
    ])

    expect(asked).toBe(0) // **一次都没问材料面**（这正是「不依赖原路径」）
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const ref = loaded.refs[0]
    expect(ref?.kind === 'image' && ref.blob).toBe('blob_7')
  })

  test('图文混排：位置照旧按 `at` 排（图片那一处不挤掉别处）', async () => {
    const records = makeFauxRecords()
    const delivery = createRefDelivery({
      skills: stubSkills(),
      materials: imageMaterials(),
      blobs: records.blobs,
    })

    const loaded = await delivery.load([
      { kind: 'file', at: 20, marker: '@shot.png', source: '/ws/shot.png' },
      skillRef(2, '/review'),
    ])

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.refs.map((ref) => [ref.kind, ref.at])).toEqual([
      ['skill', 2],
      ['image', 20],
    ])
  })

  test('装配：用户消息成了**部件串**——图在它被说出来的那个位置，字节是它本体', async () => {
    const records = makeFauxRecords({ blobs: { blob_1: PNG } })
    records.appendEntry({
      kind: 'user',
      content: { text: '看 @shot.png 是什么问题' },
      payload: {
        refs: [
          {
            kind: 'image',
            at: 2,
            marker: '@shot.png',
            source: '/ws/shot.png',
            label: 'shot.png',
            name: 'shot.png',
            mime: 'image/png',
            blob: 'blob_1',
          },
        ],
      },
      at: AT,
    })

    const messages = await assembleContext({ records, session: 's1', systemPrompt: SYSTEM })
    const user = messages.find((one) => one.role === 'user')
    const content = user?.content

    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return

    // 图挂在「`@shot.png` 之后」那一格：前面是正文，然后是图，后面接着剩下的话
    const parts = content as readonly { type: string }[]
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(1)

    const image = content.find((part) => part.type === 'image')
    if (image?.type !== 'image') return
    expect(image.mime).toBe('image/png')
    expect([...image.data]).toEqual([...PNG])

    // 正文一个字不剥（引用那一段还在句子里）
    const text = content
      .map((part) => (part.type === 'text' ? part.text : '〔图〕'))
      .join('')
    expect(text).toContain('看 @shot.png')
    expect(text).toContain('是什么问题')
    expect(text.indexOf('@shot.png')).toBeLessThan(text.indexOf('〔图〕'))
    expect(text.indexOf('〔图〕')).toBeLessThan(text.indexOf('是什么问题'))
  })

  test('字节取不回来 ⇒ **抛**（不悄悄跳过那张图）', async () => {
    const records = makeFauxRecords() // 没有 blob_9 这一份
    records.appendEntry({
      kind: 'user',
      content: { text: '看 @shot.png' },
      payload: {
        refs: [
          {
            kind: 'image',
            at: 2,
            marker: '@shot.png',
            source: '/ws/shot.png',
            label: 'shot.png',
            name: 'shot.png',
            mime: 'image/png',
            blob: 'blob_9',
          },
        ],
      },
      at: AT,
    })

    // 抛（不是「少一张图照跑」）——调用方按「这一轮出错」处置
    await expect(assembleContext({ records, session: 's1', systemPrompt: SYSTEM })).rejects.toThrow()
  })
})
