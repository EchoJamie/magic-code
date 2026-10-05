/** 停止回环专用：生产 manager/launcher/executor，原认证连接上的透明字节屏障。 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command, KernelEvent, OwnedProcess } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { createShell } from '@magic/tui'
import { loadConfig } from '../src/config.ts'
import { connectManager } from '../src/run/client.ts'
import type { StoredRuns } from '../src/run/facts.ts'
import { createProcessLauncher } from '../src/run/launch.ts'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { terminalOptions } from '../src/run/terminal.ts'
import type { ExecutorToManager, ManagerToExecutor } from '../src/run/wire.ts'
import { magicAt, removeDir, tempDir } from './tmp.ts'
import type { HttpCall, ModelReply } from './run-collaboration-fixture.ts'

type Launch = { gen: number; tokenHash: string; pid?: number; session: string | null; exited?: { order: number; reason: string }; owned: readonly OwnedProcess[] }
type Packet = { order: number; gen: number; direction: 'executor-to-manager' | 'manager-to-executor'; message: ExecutorToManager | ManagerToExecutor; forwarded?: number }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

export async function stopRuntime(name: string, respond: (call: HttpCall) => ModelReply | Promise<ModelReply>, holdDelivery = false) {
  const root = realpathSync(tempDir('magic-stop-'))
  const magic = magicAt(root)
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  for (const dir of [magic.base, workspace, dataDir]) mkdirSync(dir, { recursive: true })
  const journal: { order: number; at: number; kind: string; data: unknown }[] = []
  const mark = (kind: string, data: unknown = undefined) => {
    const order = journal.length + 1
    journal.push({ order, at: Date.now(), kind, data })
    return order
  }
  const calls: HttpCall[] = [], events: KernelEvent[] = [], commands: Command[] = [], errors: string[] = []
  const launches: Launch[] = [], packets: Packet[] = []
  const tokens = new Map<string, Launch>() // 只认生产启动器的原 token，证据不输出凭据。
  const sockets = new Set<Socket>()
  let closing = false
  let gated: { packet: Packet; releaseRequest(): void; releaseControl(): void } | undefined
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>
    const model = String(body['model'])
    const call = { at: Date.now(), model, index: calls.filter(one => one.model === model).length, body }
    calls.push(call); mark('http-request', { model, index: call.index })
    try {
      const reply = await respond(call)
      mark('http-response-released', { model, index: call.index, reply })
      const toolCalls = 'tools' in reply ? reply.tools : 'tool' in reply ? [reply] : []
      const delta = 'text' in reply ? { content: reply.text } : { tool_calls: toolCalls.map((one, index) => ({ index, id: `stop-${model}-${call.index}-${index}`, type: 'function', function: { name: one.tool, arguments: JSON.stringify(one.args) } })) }
      const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ id: `stop-${model}-${call.index}`, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
      return new Response(chunk(delta) + chunk({}, 'text' in reply ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } catch (error) { errors.push(String(error)); return new Response(String(error), { status: 500 }) }
  } })
  const configPath = join(magic.base, 'config.json')
  writeFileSync(configPath, JSON.stringify({ dataDir, workspaceRoots: [workspace], modelAliases: {default: {provider: "controlled", model: 'entry-model'}, cantrip: {provider: "controlled", model: 'entry-model'}, spell: {provider: "controlled", model: 'member-model'}, arcane: {provider: "controlled", model: 'descendant-model'}},
    providers: { controlled: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-stop-only' } },
  }))
  const paths = runPathsOf(magic, dataDir, tmpdir())
  const proxyPath = join(paths.dir, 's.sock')
  mkdirSync(paths.dir, { recursive: true })
  const proxy = createServer(front => {
    const back = connect(paths.socket)
    sockets.add(front); sockets.add(back)
    let owner: Launch | undefined
    let holdRequest = false, holdControl = false
    const queues = { request: [] as { raw: string; packet?: Packet }[], control: [] as { raw: string; packet?: Packet }[] }
    const forward = (socket: Socket, row: { raw: string; packet?: Packet }) => {
      if (row.packet) row.packet.forwarded = mark('wire-forwarded', { packet: row.packet.order })
      socket.write(row.raw) // 转发原字节，不重造请求、不改变单方向顺序。
    }
    const release = (direction: 'request' | 'control') => {
      if (direction === 'request') holdRequest = false; else holdControl = false
      const destination = direction === 'request' ? back : front
      for (const row of queues[direction].splice(0)) forward(destination, row)
    }
    const receive = (socket: Socket, direction: 'executor-to-manager' | 'manager-to-executor') => {
      let pending = ''
      socket.setEncoding('utf8')
      socket.on('data', text => {
        pending += text
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n') + 1
          const raw = pending.slice(0, end); pending = pending.slice(end)
          const message = JSON.parse(raw) as ExecutorToManager | ManagerToExecutor
          if (message.t === 'hello' && direction === 'executor-to-manager') {
            owner = tokens.get(message.token)
            if (owner === undefined) throw new Error('屏障连接不属于本测试生产启动的 executor')
            mark('authenticated-original-channel', { gen: owner.gen, pid: owner.pid, session: owner.session })
          }
          const packet = owner === undefined || message.t === 'hello' ? undefined : {
            order: mark('wire-received', { gen: owner.gen, direction, type: message.t }), gen: owner.gen, direction, message,
          }
          if (packet) packets.push(packet)
          if (owner && direction === 'executor-to-manager') {
            if (message.t === 'bound') owner.session = message.session
            if (owner.session === null && message.t === 'ev' && message.event.session !== null) {
              owner.session = message.event.session
              mark('session-from-original-event', { gen: owner.gen, pid: owner.pid, session: owner.session, packet: packet?.order })
            }
            if (message.t === 'owned') owner.owned = message.processes
            if (holdDelivery && gated === undefined && message.t === 'collaboration.request' && message.request.action === 'deliver') {
              if (packet === undefined) throw new Error('交付没有生产身份')
              holdRequest = true; holdControl = true
              gated = { packet, releaseRequest: () => release('request'), releaseControl: () => release('control') }
              mark('delivery-rpc-held', { gen: owner.gen, pid: owner.pid, session: owner.session, packet: packet.order })
            }
          }
          const row = { raw, packet }
          if (direction === 'executor-to-manager') {
            if (holdRequest) queues.request.push(row); else forward(back, row)
          } else if (holdControl) queues.control.push(row); else forward(front, row)
        }
      })
    }
    receive(front, 'executor-to-manager'); receive(back, 'manager-to-executor')
    for (const [socket, peer] of [[front, back], [back, front]] as const) {
      socket.on('error', error => { if (!closing) mark('socket-error', { gen: owner?.gen, message: String(error) }) })
      socket.on('close', () => { sockets.delete(socket); peer.end() })
    }
  })
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPath, resolve) })
  const launcher = createProcessLauncher()
  const started = await startManager({ paths, dataDir, magic, stopGraceMs: 3000, stopKillMs: 1000, launch: { spawn(request) {
    const row: Launch = { gen: request.gen, tokenHash: tokenHash(request.token), session: request.session, owned: [] }
    tokens.set(request.token, row)
    const child = launcher.spawn({ ...request, socket: proxyPath })
    row.pid = child.pid; launches.push(row)
    mark('executor-spawned', { gen: row.gen, pid: row.pid, session: row.session })
    child.onExit(reason => { row.exited = { order: mark('executor-onExit', { gen: row.gen, pid: row.pid, session: row.session, reason }), reason } })
    return child
  } } })
  if (started.role !== 'manager') {
    proxy.close(); server.stop(true); removeDir(paths.dir); removeDir(root)
    throw new Error(`管理者未启动：${started.role}`)
  }
  const manager = started.manager
  const store = createRecordsStore({ dataDir, workspace: [workspace] })
  const client = await connectManager(manager.socketPath, { cwd: workspace, label: name, expectedIdentity: manager.identity, environment: process.env })
  if (client === undefined) throw new Error('停止测试客户端连接失败')
  const terminal = terminalOptions({ client, cwd: workspace, magic, loaded: loadConfig({ path: configPath, magic }) })
  const shell = createShell({ ...terminal.transport, send(command) { commands.push(command); terminal.transport.send(command) } }, terminal)
  terminal.onGone?.(() => shell.hostGone())
  client.onEvent(event => {
    events.push(event)
    if (event.kind === 'tool.decision.request' && event.data.name.startsWith('agent_')) client.send({ type: 'decision.answer', id: event.id, decision: 'approve' })
  })
  client.onLine(line => mark('client-line', line))
  const collaboration = () => { const id = shell.getView().sessionId; return id === null ? undefined : store.collaboration.collaborationForSession(id) }
  const members = () => { const work = collaboration(); return work === undefined ? [] : store.collaboration.listMembers(work.collaborationId) }
  const delegations = () => { const work = collaboration(); return work === undefined ? [] : store.collaboration.listDelegations(work.collaborationId) }
  // kind/why 只在真实 ended 后落盘；摘要比对原启动 token，不把认证凭据输出到证据。
  const storedRuns = () => (JSON.parse(readFileSync(paths.runs, 'utf8')) as StoredRuns).runs.map(({ executionId, ...run }) => ({
    ...run, tokenHash: executionId === undefined ? undefined : tokenHash(executionId),
  }))
  const wait = async (what: string, condition: () => boolean | Promise<boolean>, timeout = 10000) => {
    const end = Date.now() + timeout
    while (!(await condition())) {
      if (Date.now() > end) throw new Error(`等不到 ${what}: ${JSON.stringify({ launches, calls: calls.map(({ model, index }) => ({ model, index })), errors, events: events.slice(-3), journal: journal.slice(-8) })}`)
      await Bun.sleep(10)
    }
  }
  const pick = (value: string) => {
    const dock = shell.getView().dock
    if (dock.kind !== 'picker') throw new Error('停止入口不是选择器')
    const at = dock.picker.rows.findIndex(row => row.value === value)
    if (at < 0) throw new Error(`停止入口没有 ${value}`)
    for (let i = 0; i < (at - dock.picker.selected + dock.picker.rows.length) % dock.picker.rows.length; i++) shell.key({ kind: 'down' })
    shell.key({ kind: 'enter' })
  }
  return { root, workspace, manager, store, client, shell, calls, events, commands, errors, launches, packets, journal, mark, wait, pick, collaboration, members, delegations, storedRuns,
    gate: () => gated,
    async openStop() {
      shell.key({ kind: 'tab' })
      await wait('根 TUI 整体停止菜单', () => { const dock = shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    },
    async snapshot() {
      const work = collaboration()
      return { collaboration: work, members: members(), delegations: delegations(), waits: work && store.collaboration.listWaits(work.collaborationId),
        messages: work && store.collaboration.listMessages(work.coordinatorId),
        entries: Object.fromEntries(await Promise.all(members().map(async agent => [agent.sessionId, await Array.fromAsync(store.readEntries(agent.sessionId))]))),
        runs: manager.runs(), storedRuns: storedRuns(),
        executions: work && store.collaboration.listExecutions(work.collaborationId), remainingExecutors: manager.executors() }
    },
    async close() {
      gated?.releaseRequest(); gated?.releaseControl()
      const beforeCleanup = await this.snapshot()
      shell.dispose(); client.close(); manager.stop('停止回环测试清场'); await manager.waitUntilExit()
      closing = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
      server.stop(true)
      const evidence = process.env['MAGIC_COLLAB_STOP_EVIDENCE']
      if (evidence) {
        const dir = resolve(evidence); mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ proof: 'real-manager-original-authenticated-socket-production-executor-controlled-http', calls, events, commands, errors, launches, packets, journal, beforeCleanup, remainingAfterCleanup: manager.executors() }, null, 2))
      }
      store.close(); removeDir(paths.dir); removeDir(root)
    },
  }
}

export type StopRuntime = Awaited<ReturnType<typeof stopRuntime>>
