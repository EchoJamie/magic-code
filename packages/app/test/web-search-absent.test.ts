/**
 * U94 · `web_search` 的注册条件——**配了网页服务才送进模型工具表**。
 *
 * 域内用例能证明的是「默认集里没有它」；模型真正看见的那一份是装配拼出来的。
 * 故两条判据都看**真发出去的那份请求**：
 * - 未配置 `web` ⇒ 没有 `web_search` / `web_fetch`；
 * - 有效配置 ⇒ 两项都在（工具表不是空的，避免「什么都没看」的假绿）。
 */

import { describe, expect, test } from 'bun:test'
import { attachShell } from '../src/index.ts'
import { lastModel, makeStage } from './support.ts'

/** 一条合格的网页服务连接（官方 DeepSeek，无自定义地址）。 */
const WEB_CONFIG = {
  providers: {
    local: { protocol: 'chat-completions', baseURL: 'https://example.invalid/v1', apiKey: 'FAKE_LOCAL' },
    web: { vendor: 'deepseek', apiKey: 'FAKE_WEB' },
  },
  models: {
    default: { provider: 'local', model: 'entry' },
    cantrip: { provider: 'local', model: 'distill' },
    spell: { provider: 'local', model: 'entry' },
    arcane: { provider: 'local', model: 'entry' },
  },
  web: { provider: 'web' },
} as const

async function toolNamesOf(stage: ReturnType<typeof makeStage>): Promise<readonly string[]> {
  const assembly = stage.assemble({ turns: [{ text: '好' }] })
  const shell = attachShell(assembly.shell, { timeoutMs: 10_000 })
  try {
    await shell.submit('随便说一句')
    return (lastModel(stage).requests[0]?.tools ?? []).map((tool) => tool.name)
  } finally {
    shell.dispose()
    assembly.close()
  }
}

describe('未配置网页服务', () => {
  test('真装配跑一轮：送给模型的请求里没有 web_search / web_fetch', async () => {
    const stage = makeStage()
    try {
      const names = await toolNamesOf(stage)

      expect(names).not.toContain('web_search')
      expect(names).not.toContain('web_fetch')
      // 清单本身不是空的——不然上面两条是「什么都没看」的假绿
      expect(names.length).toBeGreaterThan(0)
    } finally {
      stage.dispose()
    }
  })
})

describe('配置了网页服务', () => {
  test('两项工具都在模型工具表里', async () => {
    const stage = makeStage({ config: WEB_CONFIG })
    try {
      const names = await toolNamesOf(stage)

      expect(names).toContain('web_fetch')
      expect(names).toContain('web_search')
    } finally {
      stage.dispose()
    }
  })

  test('手工改出的悬空引用：配置照常加载，只让网页工具不可用', async () => {
    const stage = makeStage({ config: { ...WEB_CONFIG, web: { provider: 'ghost' } } })
    try {
      const names = await toolNamesOf(stage)

      expect(names).not.toContain('web_fetch')
      expect(names).not.toContain('web_search')
      // 别的工作照常（清单不是空的）
      expect(names).toContain('exec')
    } finally {
      stage.dispose()
    }
  })
})
