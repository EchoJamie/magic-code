/**
 * U41 · **供应商端点夹具的自证**（界面线）——「这把尺子先在一个已知答案的样本上跑通」。
 *
 * `对表.md`·取证那条写死了：**下结论之前，先拿一个已知答案的样本验一验方法本身**。
 * 留帧装置里的夹具正是「方法」——它要是会撒谎（认证没查、分页没切、错状态回成 200），
 * 后面每一条界面判据都跟着不可信，**而且看起来更可信**（它长得像真在验）。
 *
 * 故本文件只做一件事：**逐条把夹具自己的行为钉住**——列表形状 · 认证三态 · 刷新换一批 ·
 * 翻页 · 限流与断连 · 迟到 · 详情有无 · 出站模型名 · 脱敏。
 *
 * ⚠️ 这里**不测产品**：产品那一头（`/model` 的交互）在同名装置的帧里、
 * 以及 `packages/tui/test/spec.u41*.test.ts` 里判。
 */

import { describe, expect, test } from 'bun:test'
import { startProviderFixture } from '../scripts/frames-provider-models.fixture.ts'
import type { ProviderFixture } from '../scripts/frames-provider-models.fixture.ts'

const KEY = 'sk-fake-u41-not-a-real-key'

/** 起一台、跑一段、**一定停服**（端口跟着释放——判据 6 的同一条纪律）。 */
async function withFixture(
  options: Parameters<typeof startProviderFixture>[0],
  body: (fixture: ProviderFixture) => Promise<void>,
): Promise<void> {
  const fixture = startProviderFixture(options)

  try {
    await body(fixture)
  } finally {
    await fixture.stop()
  }
}

/** 带凭据地打一次列表。 */
function list(fixture: ProviderFixture, query = '', key: string | null = KEY): Promise<Response> {
  return fetch(`${fixture.baseURL}/models${query}`, {
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
  })
}

type Listed = { readonly object?: string; readonly data?: readonly { readonly id?: string }[]; readonly next?: string }

describe('供应商夹具 · 列表那一头', () => {
  test('回的是列表形状，两端都能取到（带 /v1 与不带都认）', async () => {
    await withFixture({ vendor: 'minimax', key: KEY }, async (fixture) => {
      const listed = (await (await list(fixture, '', KEY)).json()) as Listed
      expect(listed.object).toBe('list')
      expect(listed.data?.map((one) => one.id)).toEqual(['MiniMax-M3', 'MiniMax-Text-01'])

      // DeepSeek 的官方地址不带 `/v1`——**同一台服务器换个写法**照样认（见夹具头注）
      const bare = await fetch(`${fixture.bareURL}/models`, { headers: { authorization: `Bearer ${KEY}` } })
      expect(bare.status).toBe(200)
      expect(fixture.listCalls()).toBe(2)
    })
  })

  test('刷新换一批：第一次两条、第二次三条（「新增的刷新之后可选」靠它）', async () => {
    await withFixture(
      {
        vendor: 'minimax',
        key: KEY,
        lists: [
          { kind: 'ok', models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-Text-01' }] },
          {
            kind: 'ok',
            models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-Text-01' }, { id: 'MiniMax-M4' }],
          },
        ],
      },
      async (fixture) => {
        const first = (await (await list(fixture)).json()) as Listed
        const second = (await (await list(fixture)).json()) as Listed

        expect(first.data).toHaveLength(2)
        expect(second.data?.map((one) => one.id)).toContain('MiniMax-M4')
      },
    )
  })

  test('翻页那一格：给了才切，一次一页、下一页游标在 `next` 里', async () => {
    await withFixture(
      {
        vendor: 'minimax',
        key: KEY,
        models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
        pagination: { style: 'page', size: 2 },
      },
      async (fixture) => {
        const one = (await (await list(fixture, '?page=0&page_size=2')).json()) as Listed
        const two = (await (await list(fixture, '?page=1&page_size=2')).json()) as Listed

        expect(one.data?.map((it) => it.id)).toEqual(['m1', 'm2'])
        expect(one.next).toBe('1')
        expect(two.data?.map((it) => it.id)).toEqual(['m3'])
        expect(two.next).toBeUndefined()
        // 收到的查询串照记（「适配到底怎么翻的」照它说，不凭印象）
        expect(fixture.requests().at(-1)?.query).toBe('?page=1&page_size=2')
      },
    )
  })

  test('不给翻页那一格就一次给全（不静默切页）', async () => {
    await withFixture(
      { vendor: 'minimax', key: KEY, models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] },
      async (fixture) => {
        // 请求里带了 page 参数也**照给全**——默认那一档只声明「一次给全」，不假装翻页
        const listed = (await (await list(fixture, '?page=1&page_size=2')).json()) as Listed

        expect(listed.data).toHaveLength(3)
      },
    )
  })
})

describe('供应商夹具 · 认证那一头', () => {
  test('带对 key 才放行；不带 / 带错都 401', async () => {
    await withFixture({ vendor: 'minimax', key: KEY }, async (fixture) => {
      expect((await list(fixture)).status).toBe(200)
      expect((await list(fixture, '', 'sk-wrong')).status).toBe(401)
      expect((await list(fixture, '', null)).status).toBe(401)
      // 三态留痕（脱敏）：ok / mismatch / missing
      expect(fixture.requests().map((one) => one.auth)).toEqual(['ok', 'mismatch', 'missing'])
    })
  })

  test('「一律拒绝」那一档：连对得上也拒（认证失败那条路的现场）', async () => {
    await withFixture({ vendor: 'minimax', key: KEY, rejectAuth: true }, async (fixture) => {
      expect((await list(fixture)).status).toBe(401)
      // **只打了一次**——「认证失败停在该连接上，不轮试其它地址或凭据」正是这条
      expect(fixture.listCalls()).toBe(1)
    })
  })

  test('不配 key ＝ 不检查凭据，但**照样留痕**（`not-required`）', async () => {
    await withFixture({ vendor: 'deepseek' }, async (fixture) => {
      expect((await list(fixture, '', null)).status).toBe(200)
      expect(fixture.requests()[0]?.auth).toBe('not-required')
    })
  })

  test('脱敏：请求轨迹里一个 key 字节都没有', async () => {
    await withFixture({ vendor: 'minimax', key: KEY }, async (fixture) => {
      await list(fixture)
      await list(fixture, '', 'sk-wrong')

      const dump = JSON.stringify(fixture.requests())
      expect(dump).not.toContain(KEY)
      expect(dump).not.toContain('sk-wrong')
    })
  })
})

describe('供应商夹具 · 失败与迟到', () => {
  test('限流：429 ＋ `Retry-After`，**旧列表不会被它清空**（清不清是适配的事，夹具只如实回）', async () => {
    await withFixture(
      {
        vendor: 'minimax',
        key: KEY,
        lists: [
          { kind: 'ok', models: [{ id: 'm1' }] },
          { kind: 'error', status: 429, message: 'rate limited', retryAfter: 60 },
        ],
      },
      async (fixture) => {
        expect((await list(fixture)).status).toBe(200)
        const limited = await list(fixture)

        expect(limited.status).toBe(429)
        expect(limited.headers.get('retry-after')).toBe('60')
      },
    )
  })

  test('断连：没有可用答复 `fetch` 或读体当场抛（网络那一种失败）', async () => {
    await withFixture(
      { vendor: 'minimax', key: KEY, lists: [{ kind: 'cut' }] },
      async (fixture) => {
        // 两形都算——**请求本身抛**（连接没建起来）与**读体抛**（头出去了正文没了），
        // 对调用方是同一件事：这条答复不可用。夹具的 `cut` 走的是后者（实测）。
        let thrown = false
        try {
          const answer = await list(fixture)
          await answer.text()
        } catch {
          thrown = true
        }

        expect(thrown).toBe(true)
        // 抛了也留着痕——「问过了、没答上来」与「压根没问」是两件事
        expect(fixture.listCalls()).toBe(1)
      },
    )
  })

  test('迟到：`slow` 那一回合真的等，等完接着回下一回合（不是空答复）', async () => {
    await withFixture(
      {
        vendor: 'minimax',
        key: KEY,
        lists: [{ kind: 'slow', ms: 120 }, { kind: 'ok', models: [{ id: 'late' }] }],
      },
      async (fixture) => {
        const started = Date.now()
        const listed = (await (await list(fixture)).json()) as Listed

        expect(Date.now() - started).toBeGreaterThanOrEqual(100)
        expect(listed.data?.map((one) => one.id)).toEqual(['late'])
      },
    )
  })
})

describe('供应商夹具 · 详情那一头', () => {
  test('MiniMax 有单模型详情；DeepSeek **没有**（404，不伪造）', async () => {
    await withFixture({ vendor: 'minimax', key: KEY }, async (fixture) => {
      const detail = await fetch(`${fixture.baseURL}/models/MiniMax-M3`, {
        headers: { authorization: `Bearer ${KEY}` },
      })

      expect(detail.status).toBe(200)
      expect(((await detail.json()) as { id?: string }).id).toBe('MiniMax-M3')
    })

    await withFixture({ vendor: 'deepseek', key: KEY }, async (fixture) => {
      const detail = await fetch(`${fixture.baseURL}/models/deepseek-chat`, {
        headers: { authorization: `Bearer ${KEY}` },
      })

      expect(detail.status).toBe(404)
      // 端点认出来了（记的是 `/models/deepseek-chat`）——**不是**「路径没认出来」那种 404
      expect(fixture.requests()[0]?.endpoint).toBe('/models/deepseek-chat')
    })
  })
})

describe('供应商夹具 · 聊天那一头', () => {
  test('SSE 里回的 model ＝ **实际出站的那一条**（选择与出站一致看它）', async () => {
    await withFixture(
      { vendor: 'minimax', key: KEY, chat: [{ kind: 'text', text: '好。', chunks: 2 }] },
      async (fixture) => {
        const answer = await fetch(`${fixture.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'MiniMax-M4', messages: [{ role: 'user', content: '在吗' }] }),
        })

        expect(answer.status).toBe(200)
        const wire = await answer.text()
        expect(wire).toContain('data: ')
        expect(wire).toContain('[DONE]')
        expect(fixture.requests().at(-1)?.model).toBe('MiniMax-M4')
      },
    )
  })

  test('用量帧按供应商的原始字段名原样带出（不替它归一）', async () => {
    await withFixture(
      {
        vendor: 'deepseek',
        key: KEY,
        chat: [
          {
            kind: 'text',
            text: '想过了。',
            usage: {
              prompt_tokens: 100,
              prompt_cache_hit_tokens: 40,
              completion_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 12 },
            },
          },
        ],
      },
      async (fixture) => {
        const wire = await (
          await fetch(`${fixture.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-reasoner', messages: [] }),
          })
        ).text()

        expect(wire).toContain('prompt_cache_hit_tokens')
        expect(wire).toContain('reasoning_tokens')
      },
    )
  })
})
