/**
 * U33 · 技能在对话域的那一半 —— **送达 · 展开 · 回执**。
 *
 * 三件各咬一处：
 * - **装配**（`assembleContext`）：技能材料随**它那一条**用户条目摆进上下文，
 *   重放走同一条路（不重新读文件）；载荷里那条坏了的**不当作材料**；
 * - **送达**（`createSkillsDelivery`）：按身份取主文，取不到**整条失败**（不换同名项）。
 *
 * 域内件测试（相对路径取 `../src/…`）——真装配 · 真工具那条路由
 * `packages/app/test/skills.test.ts` 咬。
 */

import { describe, expect, test } from 'bun:test'
import type { Skill, SkillCatalog, SkillRead, Skills, UsedSkillEntry } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { assembleContext, userPayloadOf } from '../src/context.ts'
import { createSkillsDelivery } from '../src/skills.ts'
import { renderSkillsBlock, sourceLabelOf, withSkillsCatalog } from '../src/prompt/skills.ts'

const SESSION = 's1'
const AT = 1_700_000_000_000
const SYSTEM = '## 身份\n你是 Magic Code。'

const PDF: Skill = {
  name: 'pdf',
  description: '处理 PDF：抽文本、填表、合并',
  path: '/ws/.magic/skills/pdf',
  source: 'project',
  origin: 'magic',
}

/** 一条技能材料（落账形态）——四条身份 ＋ 正文。 */
function used(text = '正文：先数页数。'): UsedSkillEntry {
  return { name: 'pdf', source: PDF.path, label: '项目 .magic/skills', version: 'v1-8', text }
}

/** 桩来源口——`discover` 给一份固定目录，`readMain` 按给的答复回。 */
function stubSkills(
  read: (name: string, path: string) => SkillRead = () => ({
    ok: true,
    material: { skill: PDF, version: 'v1-8', text: '正文：先数页数。' },
  }),
  catalog: SkillCatalog = { skills: [PDF], problems: [] },
): Skills {
  return {
    discover: () => catalog,
    readMain: read,
    readReference: () => ({ ok: false, reason: '没用到' }),
  }
}

// ══ 装配（条目 → 模型消息）════════════════════════════════════════════

describe('U33 · 装配：材料随它那一条交代进上下文', () => {
  test('材料在用户的话**之前**；两半都取自同一条条目（重放逐字复原）', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '照它做' }, payload: { skills: [used()] }, at: AT })

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM })
    const user = messages.filter((message) => message.role === 'user')

    expect(user).toHaveLength(1)
    expect(user[0]?.content).toBe(
      '〔本次使用技能：pdf（来源 项目 .magic/skills）〕\n正文：先数页数。\n\n照它做',
    )
  })

  test('纯文本条目一字不加（没有载荷就没有材料）', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '普通一句' }, at: AT })

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM })
    const user = messages.filter((message) => message.role === 'user')

    expect(user[0]?.content).toBe('普通一句')
  })

  test('载荷里那条**名字或正文缺了**的——不当作材料（不送半条上去）', () => {
    // 类型层已经不收这种形态（`UsedSkillEntry` 四件齐全）——故这里按「从库里读回来
    // 的一条**坏行**」喂：真库里出现这种行只可能是盘上的旧数据 / 手改过的库
    const broken: unknown = { skills: [{ name: 'pdf', source: '/p' }] }
    expect(userPayloadOf(broken as never)).toEqual([])

    // 标签缺了照收（它只影响「来源怎么念」，不影响材料本身）——缺席时补空串，不编
    const noLabel: unknown = { skills: [{ name: 'pdf', source: '/p', version: 'v1', text: '正文' }] }
    expect(userPayloadOf(noLabel as never)).toEqual([
      { name: 'pdf', source: '/p', label: '', version: 'v1', text: '正文' },
    ])
    // 不是 `user` 那一份形状的载荷——一律当没有（工具条目的载荷支也走这条）
    expect(userPayloadOf({ name: 'exec', args: {} })).toEqual([])
    expect(userPayloadOf(undefined)).toEqual([])
  })
})

// ══ 送达 ═════════════════════════════════════════════════════════════

describe('U33 · 送达：取主文', () => {
  test('按**身份**取（名字 ＋ 来源路径两件都给来源口）', () => {
    const asked: string[] = []
    const delivery = createSkillsDelivery(
      stubSkills((name, path) => {
        asked.push(`${name}@${path}`)
        return { ok: true, material: { skill: PDF, version: 'v1-8', text: '正文' } }
      }),
    )

    const load = delivery.load([{ name: 'pdf', path: PDF.path }])

    expect(load).toEqual({
      ok: true,
      used: [{ name: 'pdf', source: PDF.path, label: '项目 .magic/skills', version: 'v1-8', text: '正文' }],
    })
    expect(asked).toEqual([`pdf@${PDF.path}`])
  })

  test('一条取不到——**整条失败**（不换同名项、不跳过它继续）', () => {
    const delivery = createSkillsDelivery(
      stubSkills(() => ({ ok: false, reason: '来源 /ws/.magic/skills/pdf 上已经没有「pdf」了' })),
    )

    const load = delivery.load([{ name: 'pdf', path: PDF.path }])

    expect(load.ok).toBe(false)
    if (load.ok) return
    expect(load.reason).toContain('pdf')
  })

  test('目录（仅元数据）接在系统提示词末尾；一个技能都没有就不接', () => {
    const delivery = createSkillsDelivery(stubSkills())

    const withCatalog = delivery.promptFor(SYSTEM)
    expect(withCatalog.startsWith(SYSTEM)).toBe(true)
    expect(withCatalog).toContain('## 可用技能')
    expect(withCatalog).toContain('`pdf`')
    expect(withCatalog).toContain('处理 PDF：抽文本、填表、合并')
    // 正文没有提前送（发现那一步只读元数据）
    expect(withCatalog).not.toContain('先数页数')

    const empty = createSkillsDelivery(stubSkills(undefined, { skills: [], problems: [] }))
    expect(empty.promptFor(SYSTEM)).toBe(SYSTEM)
  })
})

// ══ 目录块 ═══════════════════════════════════════════════════════════

describe('U33 · 目录块', () => {
  test('同名两个来源——**才**把目录补上（来源用于区分同名对象时须保留）', () => {
    const same: Skill[] = [PDF, { ...PDF, path: '/home/me/.magic/skills/pdf', source: 'user' }]

    const body = renderSkillsBlock({ skills: same, problems: [] })?.body ?? ''

    expect(body).toContain('/ws/.magic/skills/pdf')
    expect(body).toContain('/home/me/.magic/skills/pdf')

    const single = renderSkillsBlock({ skills: [PDF], problems: [] })?.body ?? ''
    expect(single).not.toContain('/ws/.magic/skills/pdf')
  })

  test('坏的照报（`error`）· 取舍不报（`choice`）', () => {
    const block = renderSkillsBlock({
      skills: [PDF],
      problems: [
        { path: '/ws/.magic/skills/broken', kind: 'error', message: '没有 SKILL.md' },
        { path: '/ws/.agents/skills/pdf', kind: 'choice', message: '原生那份顶掉了它' },
      ],
    })

    expect(block?.body).toContain('没能读进来的技能')
    expect(block?.body).toContain('没有 SKILL.md')
    expect(block?.body).not.toContain('顶掉了它')
  })

  test('来源标签：作用域 ＋ 入口两段（同名时人才分得清）', () => {
    expect(sourceLabelOf(PDF)).toBe('项目 .magic/skills')
    expect(sourceLabelOf({ ...PDF, source: 'user', origin: 'agents' })).toBe('用户 .agents/skills')
    expect(sourceLabelOf({ ...PDF, source: 'configured' })).toBe('配置来源 .magic/skills')
  })

  test('没有可说的就不接块（一个都没发现、也没出过问题）', () => {
    expect(renderSkillsBlock({ skills: [], problems: [] })).toBeUndefined()
    expect(withSkillsCatalog(SYSTEM, { skills: [], problems: [] })).toBe(SYSTEM)
  })
})
