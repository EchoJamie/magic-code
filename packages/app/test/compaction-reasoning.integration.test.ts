/** 页面提炼仍保持既有独立模型绑定；当前笔记压缩不使用此链。 */
import { describe, expect, test } from 'bun:test'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureRequest } from './ui/fixture.ts'
import type { ProviderConfig } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { createPageDistiller } from '@magic/model'
import { bindModelChoice } from '../src/agent-models.ts'
const chatsOf = (fixture: Fixture): readonly FixtureRequest[] => fixture.requests().filter(request => request.path.endsWith('/chat/completions'))

describe('D56 · 内务绑定与提炼出站', () => {
  test.each(['minimax', 'custom'])('%s：默认思考只发一次，正文分离且保留页面代码', async kind => {
    const fixture = startFixture({ turns: [{ kind: 'text', reasoning: '内部提炼思考', text: '使用 <think>code</think>，版本 2。', chunks: 1, chunkDelayMs: 0 }] })
    try {
      const model = kind === 'minimax' ? 'MiniMax-M2.7-highspeed' : 'custom-distill'
      const config: ProviderConfig = { protocol: 'chat-completions', apiKey: FAKE_API_KEY, baseURL: fixture.baseURL,
        ...(kind === 'minimax' ? { vendor: 'minimax' } : { modelOverrides: { [model]: { reasoningSupport: { default: 'on', disable: false } } } }),
      }
      const bound = bindModelChoice({ options: { providers: { local: config }, stamper: makeTestStamper(), env: {} },
        configuredModels: { cantrip: { provider: 'local', model } }, request: { choice: 'cantrip' } })
      if ('failure' in bound) throw new Error(bound.failure)
      const outcome = await createPageDistiller({ gateway: bound.gateway }).distill({ url: 'https://example.com/doc', page: '版本 2，代码 <think>code</think>', prompt: '版本与代码是什么？' }, {})
      expect(outcome).toMatchObject({ ok: true, answer: '使用 <think>code</think>，版本 2。' })
      const requests = chatsOf(fixture)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body['model']).toBe(model)
      expect(requests[0]?.body['thinking']).toBeUndefined()
      expect(requests[0]?.body['reasoning_effort']).toBeUndefined()
      expect(requests[0]?.body['tools']).toBeUndefined()
    } finally { await fixture.stop() }
  })

  test('绑定后改连接配置，已绑定请求稳定，下一次使用新配置', async () => {
    const a = startFixture({ turns: [{ kind: 'text', text: 'A', chunks: 1, chunkDelayMs: 0 }] })
    const b = startFixture({ turns: [{ kind: 'text', text: 'B', chunks: 1, chunkDelayMs: 0 }] })
    try {
      const config = { vendor: 'minimax', protocol: 'chat-completions', apiKey: FAKE_API_KEY, baseURL: a.baseURL } satisfies ProviderConfig
      const options = { providers: { local: config }, stamper: makeTestStamper(), env: {} }
      const bind = () => bindModelChoice({ options, configuredModels: { cantrip: { provider: 'local', model: 'MiniMax-M2.7-highspeed' } }, request: { choice: 'cantrip' } })
      const first = bind()
      config.baseURL = b.baseURL
      const second = bind()
      if ('failure' in first || 'failure' in second) throw new Error('绑定失败')
      for (const bound of [first, second]) {
        const stream = bound.gateway.stream({ messages: [{ role: 'user', content: '摘要' }] }, {})
        for await (const _ of stream.events) { /* 完整消费 */ }
        expect((await stream.result).complete).toBe(true)
      }
      expect(chatsOf(a)).toHaveLength(1)
      expect(chatsOf(b)).toHaveLength(1)
      expect(first.identity).not.toBe(second.identity)
    } finally { await a.stop(); await b.stop() }
  })
})
