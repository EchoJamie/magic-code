/** 真正的测试宿主：持有 stdin 生命连接，发布同一隔离 HOME 的发现记录并负责收尾。 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostDiscovery, HostResponse } from '@magic/contracts'
import { hostDiscoveryPath } from '../src/run/host-discovery.ts'
import { publishHostDiscovery } from './resident-cli-fixture.ts'
import type { Sandbox } from './ui/sandbox.ts'
import { tempDir } from './tmp.ts'

async function bounded<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function startResidentHost(sandbox: Sandbox, evidence = tempDir('resident-host-evidence-'), cli = join(import.meta.dir, '../src/cli.ts')) {
  mkdirSync(evidence, { recursive: true })
  const app = join(sandbox.root, 'Test Host.app')
  mkdirSync(app, { recursive: true })
  const child = Bun.spawn([
    process.execPath, cli, '--internal-manager',
    '--host-instance', `core-test-${crypto.randomUUID()}`, '--app', app,
  ], { cwd: sandbox.workspace, env: sandbox.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const messages: HostResponse[] = []
  let diagnostic = ''
  const errors = (async () => {
    const decoder = new TextDecoder()
    for await (const bytes of child.stderr) diagnostic += decoder.decode(bytes, { stream: true })
    return diagnostic
  })()
  let ready: Extract<HostResponse, { t: 'host.ready' }> | undefined
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffered = ''
    for await (const bytes of child.stdout) {
      buffered += decoder.decode(bytes, { stream: true })
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        const message = JSON.parse(line) as HostResponse
        messages.push(message)
        if (message.t === 'host.ready') ready = message
      }
    }
  })()
  const discoveryPath = hostDiscoveryPath(sandbox.home, true)
  let closed = false
  const save = async () => {
    writeFileSync(join(evidence, 'host.json'), JSON.stringify({ pid: child.pid, sandbox: sandbox.root, code: child.exitCode, messages }, null, 2))
    writeFileSync(join(evidence, 'host.stderr.log'), await errors)
  }
  const close = async (how: 'shutdown' | 'eof' = 'shutdown') => {
    if (closed) return
    closed = true
    try {
      if (child.exitCode === null) {
        if (how === 'eof') child.stdin.end()
        else child.stdin.write(JSON.stringify({ t: 'host.shutdown', request: 'fixture-close' }) + '\n')
      }
      const code = await bounded(child.exited, '隔离宿主未在期限内核销', 15_000)
      await reading
      if (code !== 0 || !messages.some((one) => one.t === 'host.stopped')) {
        throw new Error(`隔离宿主未确认停止：${JSON.stringify(messages)}`)
      }
    } finally {
      // 只操作本夹具创建并持有的进程句柄；异常仍保留证据并向调用方抛出。
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await reading
      await save()
      rmSync(discoveryPath, { force: true })
    }
  }
  try {
    const deadline = Date.now() + 5_000
    while (ready === undefined && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10)
    if (ready === undefined) throw new Error(`隔离宿主未就绪：${JSON.stringify(messages)}`)
    const discovery: HostDiscovery = { ...ready.identity, socket: ready.socket, base: ready.base, app }
    publishHostDiscovery(discoveryPath, discovery)
    return { pid: child.pid, discovery, evidence, close,
      // manager 每次 spawn 的诊断为创建计数；配合真实进程数可抓到已经回收的瞬时执行者。
      executorStarts: () => [...diagnostic.matchAll(/起了执行者 第 /gu)].length,
    }
  } catch (error) {
    try { await close() } catch { /* 原始启动错误优先，完整宿主错误已落证据。 */ }
    throw error
  }
}
