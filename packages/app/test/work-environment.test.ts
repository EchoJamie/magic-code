import { expect, test } from 'bun:test'
import { createServer, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { createWorkEnvironment } from '../src/work-environment.ts'

test('响应头到达后取消或远端断流，挂起的读取必须结束', async () => {
  let upstream: ServerResponse | undefined
  const server = createServer((_request, response) => {
    upstream = response
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('first')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const work = createWorkEnvironment({})
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const mode of ['cancel', 'disconnect']) {
      const controller = new AbortController()
      const response = await work.fetch(url, { signal: controller.signal })
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
      const pending = reader.read()
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('读取未结束')), 1000)
      })])
      try {
        if (mode === 'cancel') controller.abort(); else upstream!.destroy()
        await expect(result).rejects.toThrow(mode === 'cancel' ? 'aborted' : 'terminated')
      } finally { clearTimeout(timer); reader.releaseLock() }
    }
  } finally {
    server.closeAllConnections()
    await work.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function proxy() {
  let hits = 0
  const sockets = new Set<Duplex>()
  const server = createServer()
  server.on('connect', (request, downstream, head) => {
    hits++
    const [host, port] = request.url!.split(':')
    const upstream = connect(Number(port), host)
    sockets.add(upstream); sockets.add(downstream)
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    upstream.on('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(downstream); downstream.pipe(upstream)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    hits: () => hits,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

test('工作使用各自代理快照；小写优先，缺项与 NO_PROXY 不落回 Engine 环境', async () => {
  const a = await proxy()
  const b = await proxy()
  const received: string[] = []
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    received.push(request.headers.get('authorization') ?? '')
    return new Response('ok')
  } })
  const first = createWorkEnvironment({ http_proxy: a.url, HTTP_PROXY: b.url, SECRET: 'first' })
  const second = createWorkEnvironment({ ALL_PROXY: b.url, SECRET: 'second' })
  const direct = createWorkEnvironment({})
  const excluded = createWorkEnvironment({ HTTP_PROXY: a.url, NO_PROXY: '127.0.0.1' })
  try {
    await Promise.all([first, second].map(async work => {
      const response = await work.fetch(endpoint.url, { headers: { authorization: work.env['SECRET']! } })
      expect(await response.text()).toBe('ok')
    }))
    expect(a.hits()).toBe(1)
    expect(b.hits()).toBe(1)
    expect(received.sort()).toEqual(['first', 'second'])
    for (const work of [direct, excluded]) expect(await (await work.fetch(endpoint.url)).text()).toBe('ok')
    expect(a.hits()).toBe(1)
    expect(b.hits()).toBe(1)
    expect(Object.isFrozen(first.env)).toBe(true)
    // Bun 会缓存原生 fetch 的全局代理；异常 Engine 环境放进独立进程，避免污染其它测试。
    const child = Bun.spawn([process.execPath, '-e', `
      import {createWorkEnvironment} from ${JSON.stringify(join(import.meta.dir, '../src/work-environment.ts'))};
      const work = createWorkEnvironment({});
      try { if (await (await work.fetch(Bun.argv[1])).text() !== 'ok') process.exitCode = 1 }
      finally { await work.close() }
    `, endpoint.url.toString()], { env: { ...process.env, http_proxy: 'http://127.0.0.1:1', no_proxy: '' }, stdout: 'ignore', stderr: 'pipe' })
    expect(await child.exited).toBe(0)

  } finally {
    await Promise.all([first, second, direct, excluded].map(work => work.close()))
    endpoint.stop(true)
    await Promise.all([a.close(), b.close()])
  }
})
