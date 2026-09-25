/**
 * U06 · 定义与注册 —— 机制的第一件（定义 · 注册）。
 *
 * 判据（任务书 · 退出条件）——
 * - **危险归类**：`exec` 声明为 `by-call`（按命令解析）；**实际的按调用判定归权限域**
 *   （机械分析）——本域**只声明归类、不替它判**。故这里的断言只钉「声明」，
 *   且另有用例钉「本域没往闸门塞任何判定结论」。
 * - **定义随每次调用送模型**：规格须**可序列化**（JSON 往返不变），否则送不出去。
 */

import { describe, expect, test } from 'bun:test'
import { TOOLSET_V1 } from '@magic/contracts'
import type { ToolDefinition } from '../src/index.ts'
import { makeToolDeps } from './helpers.ts'

/** 一个最小的自定义工具——验「注册」这条机制真的通。 */
function pokeTool(log: string[]): ToolDefinition {
  return {
    spec: {
      name: 'poke',
      summary: '戳一下',
      parameters: { type: 'object', properties: { who: { type: 'string' } } },
      danger: { level: 'light' },
    },
    run: (args) => {
      log.push(String(args.who))
      return Promise.resolve({ ok: true, output: '戳了' })
    },
  }
}

describe('U06 · 定义与注册', () => {
  test('definitions() 出七件——顺序与名称 / 描述 / 危险归类逐字段照工具集 v1 的冻结表', () => {
    const { runtime } = makeToolDeps()

    // 一件不漏、一件不多、次序照表（U13 到站后默认集＝工具集 v1）
    expect(
      runtime.definitions().map((d) => ({ name: d.name, summary: d.summary, danger: d.danger })),
    ).toEqual(
      TOOLSET_V1.map((row) => ({ name: row.name, summary: row.summary, danger: row.danger })),
    )
  })

  test('参数键——六件的键名与必填位照契约「参数键」注锚定（键名不带方言）', () => {
    const { runtime } = makeToolDeps()

    const keysOf = (name: string): { properties: string[]; required: unknown } => {
      const parameters = runtime.definitions().find((d) => d.name === name)?.parameters
      return {
        properties: Object.keys((parameters?.properties ?? {}) as Record<string, unknown>),
        required: parameters?.required,
      }
    }

    expect(keysOf('read')).toEqual({ properties: ['path'], required: ['path'] })
    expect(keysOf('write')).toEqual({ properties: ['path', 'content'], required: ['path', 'content'] })
    expect(keysOf('edit')).toEqual({
      properties: ['path', 'old', 'new'],
      required: ['path', 'old', 'new'],
    })
    expect(keysOf('grep')).toEqual({ properties: ['pattern', 'path'], required: ['pattern'] })
    expect(keysOf('glob')).toEqual({ properties: ['pattern', 'path'], required: ['pattern'] })
    expect(keysOf('ls')).toEqual({ properties: ['path'], required: [] })
  })

  test('七件的参数模式都可序列化（送模型＝JSON 往返不变）', () => {
    const { runtime } = makeToolDeps()

    for (const definition of runtime.definitions()) {
      expect(definition.parameters).toEqual(JSON.parse(JSON.stringify(definition.parameters)))
    }
  })

  test('危险归类＝「按调用判定（按命令解析）」——本域只声明，不判定', () => {
    const { runtime } = makeToolDeps()

    expect(runtime.definitions()[0]?.danger).toEqual({ level: 'by-call', note: '按命令解析' })
  })

  test('参数模式＝可序列化的 JSON Schema，命令键锚定单一键 cmd', () => {
    const { runtime } = makeToolDeps()
    const parameters = runtime.definitions()[0]?.parameters
    expect(parameters).toBeDefined()

    // 送模型＝可序列化：JSON 往返后逐字段不变（函数 / 类实例混进去就会在这儿现形）
    expect(parameters).toEqual(JSON.parse(JSON.stringify(parameters)))

    expect(parameters?.type).toBe('object')
    expect(parameters?.required).toEqual(['cmd'])
    const properties = parameters?.properties as Record<string, { type?: string }> | undefined
    expect(properties?.cmd?.type).toBe('string')

    // **命令还是那一个键**——不再有候选集（技术方案 · 工具：参数键部分锚定）。
    //
    // ⚠️ **U70 改了这一条**（改的是判据、不是口径）：`exec` 现在还有第二个键
    // `background`——设计 · 工具执行与权限「**`exec` 有「后台」那一形**」第一格明写
    // 「`exec` 的一个布尔参数（**不新造工具**）」。
    // 原判据「键只有一个」在新行为下不再成立；**收窄后的判据是「命令键仍是 `cmd`、
    // 新键只有这一个、且它是布尔」**——放宽的部分如实写在这儿，没有偷偷松掉。
    expect(Object.keys(properties ?? {})).toEqual(['cmd', 'background'])
    expect(properties?.background?.type).toBe('boolean')
  })

  test('默认集＝工具集 v1 七件（阶段 1 的「仅 exec」随 U13 到站作废）；追加仍是追加', () => {
    const log: string[] = []
    const { runtime } = makeToolDeps({ tools: [pokeTool(log)] })

    expect(runtime.definitions()).toHaveLength(8) // 七件默认 ＋ 一件追加
    expect(runtime.definitions().at(-1)?.name).toBe('poke')
  })

  test('注册：自定义工具进 definitions，且真能分发到它的执行体', async () => {
    const log: string[] = []
    const { runtime, sandbox } = makeToolDeps({ tools: [pokeTool(log)] })

    expect(runtime.definitions().map((d) => d.name)).toEqual([
      'exec',
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'ls',
      'poke',
    ])

    const outcome = await runtime.invoke({ id: 'c1', name: 'poke', args: { who: '阿吉' } }, {})
    expect(log).toEqual(['阿吉'])
    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe('戳了')
    expect(sandbox.execs).toHaveLength(0) // 与沙箱无关的工具不该碰沙箱
  })

  test('注册：重名即拒——不静默覆盖（覆盖＝最难查的一类假绿）', () => {
    const log: string[] = []
    expect(() => makeToolDeps({ tools: [pokeTool(log), pokeTool(log)] })).toThrow(/重名/)
  })

  test('注册：名为空即拒——定义面不许出现无名工具', () => {
    expect(() =>
      makeToolDeps({
        tools: [
          {
            spec: { name: '', summary: '无名', parameters: {}, danger: { level: 'light' } },
            run: () => Promise.resolve({ ok: true, output: '' }),
          },
        ],
      }),
    ).toThrow(/名/)
  })
})
