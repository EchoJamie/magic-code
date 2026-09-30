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
  const discoveryPath = hostDiscoveryPath(sandbox.home)
  let closed = false
  /** 收摊那一刻它是不是**早就死了**（见下面 `close()` 里那段注）——落进 `host.json` 当证据。 */
  let alreadyGone = false
  const save = async () => {
    writeFileSync(join(evidence, 'host.json'), JSON.stringify({ pid: child.pid, sandbox: sandbox.root, code: child.exitCode, signal: child.signalCode, alreadyGone, messages }, null, 2))
    writeFileSync(join(evidence, 'host.stderr.log'), await errors)
  }
  /**
   * **还在不在**——⚠️ **不能只看 `exitCode`**：被信号带走的进程 `exitCode` 恒为 `null`
   * （信号在 `signalCode` 里）。这一条与 `driver.ts` 的 `shutDown` 同一把尺子，那边的注里
   * 记着实测：只看前者会把「早就退了的」当成「还活着」。
   */
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null

  const close = async (how: 'shutdown' | 'eof' = 'shutdown') => {
    if (closed) return
    closed = true
    /**
     * **要它停之前它就已经不在了**（用例自己把它杀了的那条路，如 `frames-u100-tui.ts`
     * 的「失联」那一幕：它按沙地路径认出管理者、`SIGKILL` 掉，再量界面）。
     *
     * 原预期 → 新预期（U109 收尾）：
     *
     * - 原预期：无论它先前是死是活，`close()` 都发一句 `host.shutdown` 并**要求回一句
     *   `host.stopped`**，否则抛「隔离宿主未确认停止」。
     * - 为何变：对**已经死掉**的宿主，那句要求**无物可确认**——信写不进一个死进程，
     *   回执也永远不会来。原来的写法在这里必然抛，而那一抛在 U109 之前是**没人接的
     *   rejection**（外借沙地那条 `dispose` 包装里少一个 `await`，见 `ui/driver.ts`），
     *   于是 `frames-u100-tui.ts` 那一支**在最后一步炸掉**——**红的是我这一下的漏 awaits，
     *   不是这一场戏**。补上 `await` 之后它改成**当场抛给调用方**，才看清根因在这儿。
     * - 新预期：**「要它停」之前它就已经不在了 ⇒ 不要求回执**（记进 `host.json` 的
     *   `alreadyGone`，证据照留）；**还在的话，要求一个字不少**（原来那套照旧）。
     * - 判据没松：这条改的是**装置对「已经死掉的宿主」该怎么收尾**，不是「宿主该不该
     *   活着收摊」——正常那一趟（活着 ⇒ 发停止 ⇒ 等 `host.stopped` ⇒ 核销）一字未动。
     */
    alreadyGone = gone()
    try {
      if (!alreadyGone) {
        if (how === 'eof') child.stdin.end()
        else child.stdin.write(JSON.stringify({ t: 'host.shutdown', request: 'fixture-close' }) + '\n')
      }
      const code = await bounded(child.exited, '隔离宿主未在期限内核销', 15_000)
      await reading
      if (!alreadyGone && (code !== 0 || !messages.some((one) => one.t === 'host.stopped'))) {
        throw new Error(`隔离宿主未确认停止：${JSON.stringify(messages)}`)
      }
    } finally {
      // 只操作本夹具创建并持有的进程句柄；异常仍保留证据并向调用方抛出。
      if (!gone()) { child.kill('SIGKILL'); await child.exited }
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
