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
  test('definitions() 出 exec 一条——名称 / 描述 / 危险归类逐字段照工具集 v1 的冻结行', () => {
    const { runtime } = makeToolDeps()
    const definitions = runtime.definitions()

    expect(definitions.map((d) => d.name)).toEqual(['exec'])

    const row = TOOLSET_V1.find((r) => r.name === 'exec')
    expect(definitions[0]?.summary).toBe(row?.summary)
    expect(definitions[0]?.danger).toEqual(row?.danger)
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

    // 单一键——不再有候选集（技术方案 · 工具：参数键部分锚定）
    expect(Object.keys(properties ?? {})).toEqual(['cmd'])
  })

  test('阶段 1 集＝仅 exec——不顺手把工具集 v1 的其余六件做进来（归 U13）', () => {
    const { runtime } = makeToolDeps()

    expect(runtime.definitions()).toHaveLength(1)
    expect(runtime.definitions().map((d) => d.name)).toEqual(['exec'])
  })

  test('注册：自定义工具进 definitions，且真能分发到它的执行体', async () => {
    const log: string[] = []
    const { runtime, sandbox } = makeToolDeps({ tools: [pokeTool(log)] })

    expect(runtime.definitions().map((d) => d.name)).toEqual(['exec', 'poke'])

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
