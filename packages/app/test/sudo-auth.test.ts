/**
 * sudo 的 UI→Engine 瞬时通道（U129）——密码只在答复那一跳经过，不落任何事件。
 */

import { describe, expect, test } from 'bun:test'
import type { ExecutorToManager } from '@magic/contracts'
import { createSudoAuth } from '@magic/host'

function harness(validate?: Parameters<typeof createSudoAuth>[0]['validate']) {
  const sent: ExecutorToManager[] = []
  const port = createSudoAuth({
    link: { send: (message) => { sent.push(message); return true } },
    cwd: '/work/proj',
    env: { PATH: '/usr/bin:/bin' },
    ...(validate === undefined ? {} : { validate }),
  })
  const request = (): Extract<ExecutorToManager, { t: 'sudo.request' }> => {
    const found = sent.find((one) => one.t === 'sudo.request')
    if (found === undefined || found.t !== 'sudo.request') throw new Error('没有发出 sudo.request')
    return found
  }
  return { port, sent, request }
}

describe('sudo 认证端口', () => {
  test('请求里只有命令，没有密码', async () => {
    const { port, request } = harness(async () => ({ ok: true }))
    const answer = port.auth.authenticate({ command: 'sudo ls /root' })
    expect(request()).toMatchObject({ t: 'sudo.request', command: 'sudo ls /root' })
    expect(JSON.stringify(request())).not.toContain('password')
    port.answer({ t: 'sudo.answer', requestId: request().requestId, password: 'secret' })
    expect(await answer).toEqual({ ok: true })
  })

  test('密码只交给认证那一跳（带 cwd / env），不写回消息', async () => {
    const seen: { password: string; cwd: string; env?: Readonly<Record<string, string>> }[] = []
    const { port, request, sent } = harness(async (password, input) => {
      seen.push({ password, cwd: input.cwd, ...(input.env === undefined ? {} : { env: input.env }) })
      return { ok: false, detail: 'Sorry, try again.' }
    })
    const answer = port.auth.authenticate({ command: 'sudo ls' })
    port.answer({ t: 'sudo.answer', requestId: request().requestId, password: 'wrong' })

    expect(await answer).toEqual({ ok: false, reason: 'failed', detail: 'Sorry, try again.' })
    expect(seen).toEqual([{ password: 'wrong', cwd: '/work/proj', env: { PATH: '/usr/bin:/bin' } }])
    expect(sent.some((message) => JSON.stringify(message).includes('wrong'))).toBe(false)
  })

  test('取消 = 失败且不调认证', async () => {
    let called = 0
    const { port, request } = harness(async () => { called += 1; return { ok: true } })
    const answer = port.auth.authenticate({ command: 'sudo ls' })
    port.answer({ t: 'sudo.answer', requestId: request().requestId, cancelled: true })
    expect(await answer).toEqual({ ok: false, reason: 'cancelled' })
    expect(called).toBe(0)
  })

  test('轮收束 / 收摊取消在途认证，并告诉管理者', async () => {
    const { port, request, sent } = harness(async () => ({ ok: true }))
    const answer = port.auth.authenticate({ command: 'sudo ls' })
    port.cancelAll()
    expect(await answer).toEqual({ ok: false, reason: 'cancelled' })
    expect(sent.some((message) => message.t === 'sudo.cancel' && message.requestId === request().requestId)).toBe(true)
  })

  test('迟到的答复静默忽略', async () => {
    const { port } = harness(async () => ({ ok: true }))
    port.answer({ t: 'sudo.answer', requestId: 'not-a-request', password: 'x' })
    expect(true).toBe(true)
  })
})
