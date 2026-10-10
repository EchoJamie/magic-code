/** 停止回环专用：生产 manager/launcher/executor，进程内原始消息连接的顺序屏障。 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command, KernelEvent, OwnedProcess } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { createShell } from '@magic/tui'
import { loadConfig } from '../src/config.ts'
import { connectManager } from '../src/run/client.ts'
import type { StoredRuns } from '../src/run/facts.ts'
import { createAgentLauncher } from '../src/run/launch.ts'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { terminalOptions } from '../src/run/terminal.ts'
import type { ExecutorToManager, ManagerToExecutor, Link } from '../src/run/wire.ts'
import { magicAt, removeDir, tempDir } from './tmp.ts'
import type { HttpCall, ModelReply } from './run-collaboration-fixture.ts'

type Launch = { gen: number; tokenHash: string; session: string | null; exited?: { order: number; reason: string }; owned: readonly OwnedProcess[] }
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
  const dataDir = magic.base
  for (const dir of [magic.base, workspace, dataDir]) mkdirSync(dir, { recursive: true })
  const journal: { order: number; at: number; kind: string; data: unknown }[] = []
  const mark = (kind: string, data: unknown = undefined) => {
    const order = journal.length + 1
    journal.push({ order, at: Date.now(), kind, data })
    return order
  }
  const calls: HttpCall[] = [], events: KernelEvent[] = [], commands: Command[] = [], errors: string[] = []
  const launches: Launch[] = [], packets: Packet[] = []
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
  writeFileSync(configPath, JSON.stringify({ dataDir, workspaceRoots: [workspace], models: {default: {provider: "controlled", model: 'entry-model'}, cantrip: {provider: "controlled", model: 'entry-model'}, spell: {provider: "controlled", model: 'member-model'}, arcane: {provider: "controlled", model: 'descendant-model'}},
    providers: { controlled: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-stop-only' } },
  }))
  const paths = runPathsOf(magic, tmpdir())
  const launcher = createAgentLauncher()
  const started = await startManager({ paths, magic, stopGraceMs: 3000, stopKillMs: 1000, launch: { spawn(request) {
    const row: Launch = { gen: request.gen, tokenHash: tokenHash(request.executionId), session: request.session, owned: [] }
    launches.push(row)
    let holdRequest = false, holdControl = false
    const queues = { request: [] as (() => void)[], control: [] as (() => void)[] }
    const release = (direction: 'request' | 'control') => {
      if (direction === 'request') holdRequest = false; else holdControl = false
      for (const forward of queues[direction].splice(0)) forward()
    }
    const receive = (message: ExecutorToManager | ManagerToExecutor, direction: Packet['direction'], send: () => void) => {
      const packet: Packet = { order: mark('wire-received', { gen: row.gen, direction, type: message.t }), gen: row.gen, direction, message }
      packets.push(packet)
      if (direction === 'executor-to-manager') {
        if (message.t === 'bound') row.session = message.session
        if (row.session === null && message.t === 'ev' && message.event.session !== null) row.session = message.event.session
        if (holdDelivery && gated === undefined && message.t === 'collaboration.request' && message.request.action === 'deliver') {
          holdRequest = true; holdControl = true
          gated = { packet, releaseRequest: () => release('request'), releaseControl: () => release('control') }
          mark('delivery-rpc-held', { gen: row.gen, session: row.session, packet: packet.order })
        }
      }
      const forward = () => { packet.forwarded = mark('wire-forwarded', { packet: packet.order }); send() }
      if (direction === 'executor-to-manager' ? holdRequest : holdControl) queues[direction === 'executor-to-manager' ? 'request' : 'control'].push(forward)
      else forward()
    }
    const link: Link<ManagerToExecutor> = {
      get closed() { return request.link.closed },
      close: () => request.link.close(), onClose: listener => request.link.onClose(listener),
      onMessage: listener => request.link.onMessage(message => receive(message, 'manager-to-executor', () => listener(message))),
      send(message) { receive(message as ExecutorToManager, 'executor-to-manager', () => request.link.send(message)); return !request.link.closed },
    }
    const ledger = { ...request.ledger,
      async add(input: Parameters<typeof request.ledger.add>[0]) { await request.ledger.add(input); row.owned = request.ledger.list() },
    }
    const agent = launcher.spawn({ ...request, link, ledger })
    mark('agent-started', { gen: row.gen, session: row.session })
    agent.onExit(reason => { row.exited = { order: mark('agent-onExit', { gen: row.gen, session: row.session, reason }), reason } })
    return agent
  } } })
  if (started.role !== 'manager') {
    server.stop(true); removeDir(paths.dir); removeDir(root)
    throw new Error(`管理者未启动：${started.role}`)
  }
  const manager = started.manager
  const store = createRecordsStore({ dataDir, workspace: [workspace] })
  const client = await connectManager(manager.socketPath, { cwd: workspace, label: name, expectedIdentity: manager.identity, environment: process.env })
  if (client === undefined) throw new Error('停止测试客户端连接失败')
  const terminal = (await terminalOptions({ client, cwd: workspace, magic, loaded: loadConfig({ path: configPath, magic }) }))
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
      server.stop(true)
      const evidence = process.env['MAGIC_COLLAB_STOP_EVIDENCE']
      if (evidence) {
        const dir = resolve(evidence); mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ proof: 'real-manager-local-agent-link-controlled-http', calls, events, commands, errors, launches, packets, journal, beforeCleanup, remainingAfterCleanup: manager.executors() }, null, 2))
      }
      store.close(); removeDir(paths.dir); removeDir(root)
    },
  }
}

export type StopRuntime = Awaited<ReturnType<typeof stopRuntime>>
