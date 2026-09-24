/**
 * U33 · `skill` 工具 —— **受限读取入口**这一件（工具域这一半）。
 *
 * 判据：**一个工具取两形**（主文 / 来源内的引用）· **名字就是完整的地址**（同名只留一条，
 * 见下）· **读不到照实说** · 抬头把「技能说明」与「工作区里读到的数据」分开。
 *
 * ⚠️ **判据二变**（U58 · 2026-09-25）：原判「**不静默挑同名**」——那时工具有一个 `source`
 * 参数，名字不唯一就回填列出各来源让模型指明。同名在**发现那一层**只留一条之后那个参数
 * 收掉了（它的唯一由头就是同名），故这里改成咬「**按名字取，取到次序里靠前的那一份**」。
 *
 * 本文件用**桩 `Skills` 端口**（工具域不碰文件系统，边界归执行域）——真盘上的那条路
 * 由 `packages/execution/test/skills.test.ts`（来源面）与
 * `packages/app/test/skills.test.ts`（真装配 · 真工具）各咬一半。
 */

import { describe, expect, test } from 'bun:test'
import type { Skill, SkillCatalog, SkillRead, Skills } from '@magic/contracts'
import { defineSkillTool } from '../src/skill-tool.ts'

const PDF: Skill = {
  name: 'pdf',
  description: '处理 PDF',
  path: '/sk/pdf',
  source: 'project',
  origin: 'magic',
  label: '项目 .magic/skills',
}
const OTHER: Skill = { ...PDF, name: 'other', path: '/sk/other' }

/** 一个记着「问了什么」的桩——判据看它（工具有没有把模型的意图原样转过去）。 */
function stubSkills(skills: readonly Skill[], read?: (name: string, path: string, relative?: string) => SkillRead) {
  const asked: string[] = []

  const port: Skills = {
    discover: (): SkillCatalog => ({ skills: [...skills], problems: [] }),
    readMain: (name, path) => {
      asked.push(`main:${name}@${path}`)
      return read?.(name, path) ?? { ok: true, material: { skill: PDF, text: '主文正文' } }
    },
    readReference: (name, path, relative) => {
      asked.push(`ref:${name}@${path}/${relative}`)
      return read?.(name, path, relative) ?? { ok: true, material: { skill: PDF, text: '引用正文' } }
    },
  }

  return { port, asked }
}

/** 跑一次工具调用——返回面向模型的那份文本。 */
async function run(port: Skills, args: Readonly<Record<string, unknown>>) {
  const tool = defineSkillTool(port)
  return tool.run(args, { sandbox: undefined as never, signal: undefined, onOutput: undefined })
}

describe('U33 · skill 工具', () => {
  test('只给名字＝取主文；带上 relative＝取那份引用（两次都走同一个来源口）', async () => {
    const { port, asked } = stubSkills([PDF])

    const main = await run(port, { name: 'pdf' })
    expect(main.ok).toBe(true)
    expect(main.output).toContain('主文正文')
    // 抬头：是哪一份——技能说明与读出来的数据从这一行起分得开
    // （**不带来源**：名字已唯一，路径对模型是没有信息量的额外字——2026-09-25 用户裁）
    expect(main.output).toContain('〔技能主文：pdf〕')

    const reference = await run(port, { name: 'pdf', relative: 'references/x.md' })
    expect(reference.ok).toBe(true)
    expect(reference.output).toContain('引用正文')
    expect(reference.output).toContain('〔技能引用 references/x.md：pdf〕')

    expect(asked).toEqual(['main:pdf@/sk/pdf', 'ref:pdf@/sk/pdf/references/x.md'])
  })

  test('名字唯一时按名字归位（身份由发现结果给——不用模型编路径）', async () => {
    const { port, asked } = stubSkills([PDF, OTHER])

    await run(port, { name: 'other' })

    expect(asked).toEqual(['main:other@/sk/other'])
  })

  /**
   * 清单里真出现同名（**真实来源不会给**——`skills.discover` 按同名只留一条）：
   * 取靠前那一份。这里**不另立一套判定**（U49：两处各判一遍必然分叉），
   * 靠前就是发现层的次序（次序即优先级）。
   */
  test('清单里真出现同名 ⇒ 取**靠前那一份**（不在此处另判一次）', async () => {
    const { port, asked } = stubSkills([PDF, { ...PDF, path: '/sk/dup' }])

    const outcome = await run(port, { name: 'pdf' })

    expect(outcome.ok).toBe(true)
    expect(asked).toEqual(['main:pdf@/sk/pdf'])
  })

  /**
   * **参数表里没有 `source` 这一格**（U58 收掉的那一个）：多给的键不当回事——
   * 读的东西仍由**发现结果**定，模型编一个路径进来也不认。
   */
  test('多给一个 `source` 也不作数——按名字归位（读哪儿由发现结果定）', async () => {
    const { port, asked } = stubSkills([PDF])

    await run(port, { name: 'pdf', source: '/elsewhere/pdf' })

    expect(asked).toEqual(['main:pdf@/sk/pdf'])
  })

  test('没有这个技能：回填列出可用的（空清单时说清「这次一个都没发现」）', async () => {
    const some = await run(stubSkills([PDF, OTHER]).port, { name: 'nope' })
    expect(some.ok).toBe(false)
    expect(some.output).toContain('没有「nope」这个技能')
    expect(some.output).toContain('pdf')
    expect(some.output).toContain('other')

    const none = await run(stubSkills([]).port, { name: 'nope' })
    expect(none.ok).toBe(false)
    expect(none.output).toContain('一个技能都没发现')
  })

  test('来源口说读不到——**原样照实说**（工具不替它编第二种说法）', async () => {
    const { port } = stubSkills([PDF], () => ({
      ok: false,
      reason: '技能「pdf」那一处现在不是一个目录了（/sk/pdf）——来源没了就是没了',
    }))

    const outcome = await run(port, { name: 'pdf' })

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('技能「pdf」那一处现在不是一个目录了（/sk/pdf）——来源没了就是没了')
  })

  test('参数不成形：name 缺 / 空，relative 给了个非串——**未执行**', async () => {
    const { port, asked } = stubSkills([PDF])

    expect(await run(port, {})).toMatchObject({ ok: false })
    expect(await run(port, { name: '  ' })).toMatchObject({ ok: false })
    expect((await run(port, { name: 'pdf', relative: 7 })).output).toContain('relative')
    expect(asked).toEqual([])
  })
})
