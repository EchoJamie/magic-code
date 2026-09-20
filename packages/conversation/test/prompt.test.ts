/**
 * 系统提示词 —— **Faux 校验**（工作分解 · 验收判据 M04：段齐 · 注入对 · 装配之逆 · 注入来源纪律）。
 *
 * 由旧结构 `kernel/test/u10.test.ts` 随 M04 迁入（判据一字未改，落点与 import 改指新包）。
 * 不需要模型、不需要端点：装配是纯函数，故这里直接以产物为证据——
 * 1. **段齐**——段结构四段都在、顺序即 `PROMPT_SECTIONS`、正文非空、边界锚唯一且严格递增；
 * 2. **注入对**——给定 cwd / platform / date，产物里看得到对应值；缺失（未给 / 空串 / 纯空白）报错；
 * 3. **段边界**——`splitSystemPrompt` 是装配之逆：往返逐块相符；产物被改即读不到该段（读取真读产物）；
 * 4. **注入来源纪律**——本单元不就地取材（源码里不得出现运行环境 / 时间读取）。
 *
 * 第 4 条是静态扫描（读源码文本）——测试用文件系统是测试的正常需求（scaffold.test.ts 同款做法）。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENVIRONMENT_BLOCK_ID,
  ENVIRONMENT_HEADING,
  PROJECT_RULES_BLOCK_ID,
  PROJECT_RULES_HEADING,
  PROMPT_RUNTIME_VARS,
  PROMPT_SECTIONS,
  PromptVarsError,
  SKILLS_BLOCK_ID,
  SKILLS_HEADING,
  buildPromptBlocks,
  buildSystemPrompt,
  sectionHeading,
  splitSystemPrompt,
} from '../src/prompt/index.ts'
import type { PromptBlockId, PromptRuntimeVar, PromptVars } from '../src/prompt/index.ts'

const VARS: PromptVars = { cwd: '/ws/magic-code', platform: 'darwin', date: '2026-09-16' }

/** 装配产物的块标识序——段结构四段（顺序即结构）+ 环境注入块（殿后）。 */
const BLOCK_IDS: PromptBlockId[] = [...PROMPT_SECTIONS, ENVIRONMENT_BLOCK_ID]

/**
 * 块标识 → 边界锚——三个追加块（环境 / 项目规约 / 技能目录）各有自己的标题，四段按
 * `sectionHeading` 算。后续块（项目规约 U32、技能目录 U33）由 `withProjectRules` /
 * `withSkillsCatalog` 追加，**不在** `buildPromptBlocks` 的产物里，故它们不进
 * `BLOCK_IDS`；这里的表先认全，免得日后加块时又漏一处。
 */
function headingOf(id: PromptBlockId): string {
  if (id === ENVIRONMENT_BLOCK_ID) return ENVIRONMENT_HEADING
  if (id === PROJECT_RULES_BLOCK_ID) return PROJECT_RULES_HEADING
  if (id === SKILLS_BLOCK_ID) return SKILLS_HEADING
  return sectionHeading(id)
}

// —— ① 段齐 ——

describe('M04 · 段齐', () => {
  test('四段尽在，顺序即段结构；环境注入块殿后', () => {
    const ids = buildPromptBlocks(VARS).map((block) => block.id)

    expect(ids).toEqual(BLOCK_IDS)
    expect(ids.slice(0, PROMPT_SECTIONS.length)).toEqual([...PROMPT_SECTIONS])
  })

  test('段结构未被改——四段，且不含环境块（环境是追加块，不是新段）', () => {
    expect(PROMPT_SECTIONS).toEqual(['identity', 'conduct', 'tools', 'permission'])
    expect(PROMPT_SECTIONS as readonly string[]).not.toContain(ENVIRONMENT_BLOCK_ID)
  })

  test('每段：边界锚唯一、正文非空、text 即「标题 + 正文」', () => {
    const blocks = buildPromptBlocks(VARS)

    const headings = blocks.map((block) => block.heading)
    expect(headings.every((heading) => heading.startsWith('## ') && heading.length > 3)).toBe(true)
    expect(new Set(headings).size).toBe(headings.length)

    for (const block of blocks) {
      expect(block.body.trim().length).toBeGreaterThan(0)
      expect(block.text).toBe(`${block.heading}\n${block.body}`)
      expect(block.text).toBe(block.text.trim())
    }
  })

  test('字符串产物：段标题按段结构序依次出现（唯一、严格递增）', () => {
    const prompt = buildSystemPrompt(VARS)
    const indexes = BLOCK_IDS.map((id) => prompt.indexOf(headingOf(id)))

    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(new Set(indexes).size).toBe(indexes.length)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)

    // 首段即身份——产物不含标题之前的散行
    expect(prompt.startsWith(sectionHeading('identity'))).toBe(true)
    // 产物无尾随空白——末块以正文收束
    expect(prompt).toBe(prompt.trimEnd())
  })
})

// —— ② 注入对 ——

describe('M04 · 注入对', () => {
  test('给定 cwd / platform / date，产物里看得到对应值（逐项一行）', () => {
    const prompt = buildSystemPrompt(VARS)

    expect(prompt).toContain(`- 工作目录：${VARS.cwd}`)
    expect(prompt).toContain(`- 平台：${VARS.platform}`)
    expect(prompt).toContain(`- 日期：${VARS.date}`)
  })

  test('注入块殿后，每项恰出现一次', () => {
    const prompt = buildSystemPrompt(VARS)
    const env = buildPromptBlocks(VARS).at(-1)

    expect(env?.id).toBe(ENVIRONMENT_BLOCK_ID)
    expect(env?.heading).toBe(ENVIRONMENT_HEADING)
    expect(prompt.lastIndexOf(ENVIRONMENT_HEADING)).toBeGreaterThan(
      prompt.lastIndexOf(sectionHeading('permission')),
    )

    for (const label of ['- 工作目录：', '- 平台：', '- 日期：']) {
      expect(prompt.split(label).length - 1).toBe(1)
    }
  })

  test('注入项齐项——覆盖段结构 PromptRuntimeVar 全量', () => {
    expect([...PROMPT_RUNTIME_VARS].sort()).toEqual(['cwd', 'date', 'platform'])
  })

  test('值按原样注入（不修剪），多余键被忽略', () => {
    const raw: PromptVars = { cwd: '  /ws  ', platform: 'linux', date: '2026-09-16' }
    const prompt = buildSystemPrompt(raw)

    expect(prompt).toContain('- 工作目录：  /ws  ')

    const withExtra = buildSystemPrompt({ ...VARS, extra: '不该出现' } as PromptVars)
    expect(withExtra).not.toContain('不该出现')
    expect(withExtra).toBe(buildSystemPrompt(VARS))
  })
})

// —— ③ 缺失行为（明确：报错，不静默降级） ——

describe('M04 · 缺失行为', () => {
  test('全缺 → PromptVarsError，报出全部缺项（按呈现顺序）', () => {
    const error = (() => {
      try {
        buildSystemPrompt({} as PromptVars)
      } catch (caught) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(PromptVarsError)
    expect((error as PromptVarsError).name).toBe('PromptVarsError')
    expect((error as PromptVarsError).missing).toEqual(['cwd', 'platform', 'date'])
    expect((error as PromptVarsError).message).toContain('系统提示词缺运行时注入值')
    expect((error as PromptVarsError).message).toContain('cwd、platform、date')
  })

  test('缺一项 → 只报缺的那项', () => {
    const error = (() => {
      try {
        buildSystemPrompt({ cwd: '/ws', platform: 'darwin' } as PromptVars)
      } catch (caught) {
        return caught as PromptVarsError
      }
      return undefined
    })()

    expect(error?.missing).toEqual(['date'])
  })

  test('空串 / 纯空白视同缺失', () => {
    expect(() => buildSystemPrompt({ ...VARS, platform: '' })).toThrow(PromptVarsError)
    expect(() => buildSystemPrompt({ ...VARS, cwd: '   ' })).toThrow(PromptVarsError)
  })

  test('JS 调用方传空（非对象）→ 报缺项，而非运行时报错', () => {
    expect(() => buildSystemPrompt(undefined as unknown as PromptVars)).toThrow(PromptVarsError)
    expect(() => buildPromptBlocks(undefined as unknown as PromptVars)).toThrow(PromptVarsError)
  })
})

// —— ④ 段边界（装配之逆） ——

describe('M04 · 段边界', () => {
  test('往返：split(build(vars)) 与 buildPromptBlocks(vars) 逐块相符', () => {
    const prompt = buildSystemPrompt(VARS)

    expect(splitSystemPrompt(prompt)).toEqual(buildPromptBlocks(VARS))
    // 拼接回原文——块划分无遗漏
    expect(splitSystemPrompt(prompt).map((block) => block.text).join('\n\n')).toBe(prompt)
  })

  test('边界读取真读产物——段标题被改写即读不到该段', () => {
    const mutated = buildSystemPrompt(VARS).replace(sectionHeading('tools'), '## 工具')
    const ids = splitSystemPrompt(mutated).map((block) => block.id)

    expect(ids).toEqual(['identity', 'conduct', 'permission', ENVIRONMENT_BLOCK_ID])
  })

  test('产物缺段即少块（无中生有不算数）', () => {
    const prompt = buildSystemPrompt(VARS)
    const withoutIdentity = prompt.slice(prompt.indexOf(sectionHeading('conduct')))

    expect(splitSystemPrompt(withoutIdentity).map((block) => block.id)).toEqual([
      'conduct',
      'tools',
      'permission',
      ENVIRONMENT_BLOCK_ID,
    ])
  })
})

// —— ⑤ 注入来源纪律（就地取材即失败） ——

describe('M04 · 注入来源纪律', () => {
  /** 禁止的就地取材点——运行环境 / 运行时 / 时钟。fs 触达另由 scaffold 守护（prompt/ 不在放行清单）。 */
  const FORBIDDEN: ReadonlyArray<readonly [token: string, pattern: RegExp]> = [
    ['process（环境变量 / 平台）', /\bprocess\b/],
    ['Bun（运行时读取）', /\bBun\b/],
    ['new Date（取当前时间）', /\bnew\s+Date\b/],
    ['Date.now（取当前时间）', /\bDate\s*\.\s*now\b/],
    ['globalThis（运行时全局）', /\bglobalThis\b/],
  ]

  test('源码不得出现运行环境 / 时间读取——注入来源只能由调用方给', () => {
    const dir = join(import.meta.dir, '..', 'src', 'prompt')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts'))

    // 守护面不得为空——目录改名 / 清空时宁可失败，也不要静默空转
    expect(files.length).toBeGreaterThan(0)

    const hits: string[] = []
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const [token, pattern] of FORBIDDEN) {
        if (pattern.test(source)) hits.push(`${file} → ${token}`)
      }
    }

    expect(hits).toEqual([])
  })
})

/** 类型层探针——`PromptVars` 要求齐项（缺项即编译期报错）。 */
export function varsRequireAllRuntimeVars(): void {
  const full: PromptVars = { cwd: '/ws', platform: 'darwin', date: '2026-09-16' }
  // @ts-expect-error 缺 date——类型层即拦
  const incomplete: PromptVars = { cwd: '/ws', platform: 'darwin' }
  // @ts-expect-error 值须为字符串
  const wrongType: PromptVars = { cwd: '/ws', platform: 'darwin', date: 20260916 }

  const ids: readonly PromptRuntimeVar[] = [...PROMPT_RUNTIME_VARS]
  void full
  void incomplete
  void wrongType
  void ids
}
