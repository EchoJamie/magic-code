/** 真 manager/socket/子进程 executor；只有模型 HTTP 响应受控。 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command, KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { createShell } from '@magic/tui'
import { connectManager } from '../src/run/client.ts'
import { createProcessLauncher } from '../src/run/launch.ts'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { terminalOptions } from '../src/run/terminal.ts'
import { loadConfig } from '../src/config.ts'
import { magicAt, removeDir, tempDir } from './tmp.ts'

export type ModelReply = ({ readonly text: string } | { readonly tool: string; readonly args: Record<string, unknown> } | { readonly tools: readonly { readonly tool: string; readonly args: Record<string, unknown> }[] }) & { readonly finish?: string; readonly usage?: Record<string, number>; readonly httpStatus?: number; readonly malformed?: true }
export type HttpCall = { readonly at: number; readonly model: string; readonly index: number; readonly body: Record<string, unknown> }
export function latch() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

export async function collaborationRuntime(name: string, respond: (call: HttpCall) => ModelReply | Promise<ModelReply>, options: { readonly allowAll?: true } = {}) {
  const root = realpathSync(tempDir('magic-collab-run-'))
  const magic = magicAt(root)
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  for (const dir of [magic.base, workspace, dataDir]) mkdirSync(dir, { recursive: true })
  const calls: HttpCall[] = []
  const errors: string[] = []
  const events: KernelEvent[] = []
  const commands: Command[] = []
  const lines: string[] = []
  const processStarts: { pid: number | undefined; session: string | null; at: number; identity: string }[] = []
  const processExits: { pid: number | undefined; at: number; reason: string }[] = []
  const closedViews: { at: number; livePids: (number | undefined)[]; exitedPids: (number | undefined)[] }[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    try {
      if (request.method === 'GET') return Response.json({ data: [{ id: 'entry-model' }, { id: 'member-model' }, { id: 'descendant-model' }] })
      const body = await request.json() as Record<string, unknown>
      const model = String(body['model'])
      const call = { at: Date.now(), body, model, index: calls.filter(one => one.model === model).length }
      calls.push(call)
      const reply = await respond(call)
      if (reply.httpStatus !== undefined) return Response.json({ error: { message: 'controlled upstream failure', type: 'controlled' } }, { status: reply.httpStatus })
      if (reply.malformed) return new Response('data: {invalid-json}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      const toolCalls = 'tools' in reply ? reply.tools : 'tool' in reply ? [reply] : []
      const delta = 'text' in reply ? { content: reply.text } : {
        tool_calls: toolCalls.map((one, index) => ({ index, id: `controlled-${model}-${call.index}-${index}`, type: 'function', function: { name: one.tool, arguments: JSON.stringify(one.args) } })),
      }
      const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ id: `response-${model}-${call.index}`, object: 'chat.completion.chunk', created: 1, model,
        ...(reply.usage === undefined ? {} : { usage: reply.usage }), choices: [{ index: 0, delta, ...(finish === undefined ? {} : { finish_reason: finish }) }] })}\n\n`
      return new Response(chunk(delta) + chunk({}, reply.finish ?? ('text' in reply ? 'stop' : 'tool_calls')) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } catch (error) {
      errors.push(String(error))
      return new Response(String(error), { status: 500 })
    }
  } })
  const configPath = join(magic.base, 'config.json')
  writeFileSync(configPath, JSON.stringify({ dataDir, workspaceRoots: [workspace], models: {default: {provider: "controlled", model: 'entry-model'}, cantrip: {provider: "controlled", model: 'entry-model'}, spell: {provider: "controlled", model: 'member-model'}, arcane: {provider: "controlled", model: 'descendant-model'}},
    providers: { controlled: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-controlled-only' } },
  }))
  const paths = runPathsOf(magic, dataDir, tmpdir())
  const launcher = createProcessLauncher()
  const started = await startManager({ paths, dataDir, magic, launch: { spawn(request) {
    const child = launcher.spawn({ ...request, ...(options.allowAll === true ? { allowAll: true } : {}) })
    if (process.env['MAGIC_COLLAB_RUN_EVIDENCE']) {
      const identity = Bun.spawnSync(['/bin/ps', '-p', String(child.pid), '-o', 'pid=,ppid=,pgid=,lstart=,args=']).stdout.toString().replace(/--token \S+/g, '--token [redacted]')
      processStarts.push({ pid: child.pid, session: request.session, at: Date.now(), identity })
    }
    child.onExit(reason => processExits.push({ pid: child.pid, at: Date.now(), reason }))
    return child
  } },
    stopGraceMs: 1000, stopKillMs: 1000 })
  if (started.role !== 'manager') { server.stop(true); removeDir(root); throw new Error(`管理者未启动：${started.role}`) }
  const manager = started.manager
  const store = createRecordsStore({ dataDir, workspace: [workspace] })
  const client = await connectManager(manager.socketPath, { cwd: workspace, label: name,
    expectedIdentity: manager.identity, environment: process.env })
  if (client === undefined) {
    manager.stop('连接失败'); await manager.waitUntilExit(); store.close(); server.stop(true); removeDir(root)
    throw new Error('客户端连不上管理者')
  }
  const terminal = terminalOptions({ client, cwd: workspace, magic, loaded: loadConfig({ path: configPath, magic }) })
  const transport = terminal.transport
  const shell = createShell({ ...transport, send(command) { commands.push(command); transport.send(command) } }, terminal)
  terminal.onGone?.(() => shell.hostGone())
  const windows: { readonly shell: ReturnType<typeof createShell>; readonly client: NonNullable<Awaited<ReturnType<typeof connectManager>>>; readonly events: KernelEvent[]; readonly commands: Command[] }[] = []
  const answered = new Set<number>()
  client.onLine(text => lines.push(text))
  client.onEvent(item => {
    events.push(item)
    if (item.kind === 'collaboration.view' && item.data.collaboration?.state === 'closed') {
      closedViews.push({ at: Date.now(), livePids: manager.executors().map(one => one.pid), exitedPids: processExits.map(one => one.pid) })
    }
    // 测试用户仅批准控制工具，普通工具仍由测试步骤明确裁决。
    if (item.kind === 'tool.decision.request' && item.data.name.startsWith('agent_') && !answered.has(item.id)) {
      answered.add(item.id)
      client.send({ type: 'decision.answer', id: item.id, decision: 'approve' })
    }
  })
  const session = () => shell.getView().sessionId
  const collaboration = () => { const id = session(); return id === null ? undefined : store.collaboration.collaborationForSession(id) }
  const members = () => { const row = collaboration(); return row === undefined ? [] : store.collaboration.listMembers(row.collaborationId) }
  const member = () => members().find(one => one.agentId !== collaboration()?.coordinatorId)
  const delegation = () => { const row = collaboration(); return row === undefined ? undefined : store.collaboration.listDelegations(row.collaborationId)[0] }
  const wait = async (what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 12000): Promise<void> => {
    const until = Date.now() + timeoutMs
    while (!(await ok())) {
      if (Date.now() >= until) throw new Error(`等不到 ${what}\n${JSON.stringify({ calls: calls.map(({ model, index }) => ({ model, index })), errors, lines, runs: manager.runs(), last: events.filter(one => one.kind !== 'collaboration.view').slice(-8) })}`)
      await Bun.sleep(20)
    }
  }
  const pick = (value: string, target = shell) => {
    const dock = target.getView().dock
    if (dock.kind !== 'picker') throw new Error('当前不是选择器')
    const at = dock.picker.rows.findIndex(row => row.value === value)
    if (at < 0) throw new Error(`没有选项 ${value}`)
    for (let i = 0; i < (at - dock.picker.selected + dock.picker.rows.length) % dock.picker.rows.length; i++) target.key({ kind: 'down' })
    target.key({ kind: 'enter' })
  }
  const closeWindows = () => {
    shell.dispose(); client.close()
    for (const window of windows) { window.shell.dispose(); window.client.close() }
  }
  return { root, magic, workspace, dataDir, calls, errors, events, commands, lines, processExits, closedViews, manager, store, client, shell, closeWindows,
    session, collaboration, members, member, delegation, wait, pick,
    requests: (model = 'entry-model') => calls.filter(call => call.model === model),
    async openMember(target = shell) {
      target.key({ kind: 'tab' })
      await wait('协作列表', () => { const dock = target.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
      pick(member()!.agentId, target)
      await wait('成员完整阅读', () => { const dock = target.getView().dock; return dock.kind === 'picker' && dock.picker.reader?.key === `${member()!.agentId}:records` })
      target.key({kind:'memberMenu'})
      await wait('成员操作', () => { const dock=target.getView().dock;return dock.kind==='picker'&&dock.picker.source==='collaboration-member' })
    },
    async openWindow() {
      const another = await connectManager(manager.socketPath, { cwd: workspace, session: session()!, label: `${name}-second`,
        expectedIdentity: manager.identity, environment: process.env })
      if (another === undefined) throw new Error('第二个 TUI 连不上同一管理者')
      const commands: Command[] = []
      const events: KernelEvent[] = []
      const options = terminalOptions({ client: another, cwd: workspace, magic, loaded: loadConfig({ path: configPath, magic }), session: session()! })
      const transport = options.transport
      const shell = createShell({ ...transport, send(command) { commands.push(command); transport.send(command) } }, options)
      options.onGone?.(() => shell.hostGone())
      another.onEvent(event => events.push(event))
      const window = { client: another, shell, events, commands }
      windows.push(window)
      another.send({ type: 'session.list' })
      another.send({ type: 'collaboration.read' })
      await wait('第二个 TUI 接回原工作', () => shell.getView().sessionId === session() && shell.getView().collaboration?.collaboration !== undefined)
      return window
    },
    async close() {
      closeWindows()
      manager.stop('受控协作回环结束')
      await manager.waitUntilExit()
      const evidence = process.env['MAGIC_COLLAB_RUN_EVIDENCE']
      if (evidence) {
        const dir = resolve(evidence); mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ proof: 'real-manager-socket-executor-controlled-http', allowAll: options.allowAll === true, calls, events, commands, errors, lines, processExits, closedViews,
          windows: windows.map(window => ({ conn: window.client.conn, events: window.events, commands: window.commands })),
          processStarts, globalRemainingForSandbox: Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,lstart=,args=']).stdout.toString().split('\n').filter(line => line.includes(root)).map(line => line.replace(/--token \S+/g, '--token [redacted]')),
          inputFacts:members().map(member=>({session:member.sessionId,inputs:store.serviceFor(member.sessionId).inputs.list()})), remainingExecutors: manager.executors(), socket: manager.socketPath }, null, 2))
      }
      store.close(); server.stop(true)
      removeDir(paths.dir); removeDir(root)
    },
  }
}

export const spawnMember: ModelReply = { tool: 'agent_spawn', args: { operationId: 'spawn-member', name: '实现', responsibility: '独立检查回调', scope: '回调兼容',
  body: [{ kind: 'text', text: '核对回调兼容；先判断是否接受，问题明确回报入口。' }], model: { choice: 'spell' }, modelReason: '独立执行回调兼容检查' } }
export const requestText = (call: HttpCall | undefined): string => JSON.stringify(call?.body['messages'])
