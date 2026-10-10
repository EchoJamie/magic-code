import type { Command, ControlTransport, EventDataOf, EventKind, KernelEvent, MagicHome, ModelSelectionRef, ModelSwitchRequest, SettingsAction, WorkspaceService } from '@magic/contracts'
import { createSettings } from '../settings.ts'
import { createWorkEnvironment } from '../work-environment.ts'
import { configStamp } from '../cache-access.ts'
import { loadConfig } from '../config.ts'
import { createWorkspaceService } from '@magic/execution'
import { modelCatalog, providerCatalog, readGrantView, grantsTrouble } from './observation.ts'

/** 文件动作在 TUI 执行；运行命令继续使用原连接。 */
export function terminalSettings(transport: ControlTransport, magic: MagicHome, workspace: WorkspaceService, initial?: ModelSwitchRequest): ControlTransport {
  const listeners = new Set<(event: KernelEvent) => void>()
  const environment = Object.freeze({ ...process.env })
  let selection: ModelSelectionRef | undefined
  let session = ''
  let queue = Promise.resolve()
  let grants: EventDataOf['grants.catalog'] | undefined
  let grantStamp: string | null = null
  let unsubscribe: (() => void) | undefined
  const receive = (event: KernelEvent) => {
    if (event.kind === 'session.state') {
      const active = event.data.active
      if (session !== active) grants = undefined
      const roots = event.data.sessions.find(one => one.id === active)?.workspace
      if (roots?.length) workspace = createWorkspaceService({ roots })
    }
    session = event.session
    if (event.kind === 'model.catalog') selection = event.data.current
    if (event.kind === 'model.switched' && event.data.ok && event.data.provider && event.data.model) selection = { choice: event.data.choice ?? selection?.choice ?? 'default', provider: event.data.provider, model: event.data.model, ...(event.data.reasoning === undefined ? {} : { reasoning: event.data.reasoning }) }
    if (event.kind === 'grants.catalog') {
      const path = `${magic.base}/grants.json`, before = configStamp(path)
      const local = readGrantView(magic, createWorkspaceService({ roots: [event.data.workspace] }))
      if (configStamp(path) === before) {
        grantStamp = before; grants = { ...event.data, ...local.view }
        event = { ...event, data: grants }
      }
    }
    for (const listener of listeners) listener(event)
  }
  const emit = <K extends EventKind>(kind: K, data: EventDataOf[K]) => {
    const event = { id: 0, turn: null, at: Date.now(), session, kind, data } as KernelEvent
    for (const listener of listeners) listener(event)
  }
  const local = new Set<Command['type']>(['model.list', 'provider.list', 'provider.save', 'provider.remove', 'model.configure', 'model.refresh', 'prefs.set', 'grants.list', 'grants.revoke'])
  async function handle(command: Command) {
    const network = createWorkEnvironment(environment)
    const settings = createSettings({ magic, environment: network.env, fetch: network.fetch })
    let note: string | undefined
    try {
      let action: SettingsAction | undefined
      switch (command.type) {
        case 'provider.save': case 'provider.remove': case 'model.configure': case 'prefs.set': action = command; break
        case 'model.refresh': {
          const provider = command.provider ?? selection?.provider ?? loadConfig({ magic }).config.models?.default?.provider
          if (!provider) throw new Error('尚未选择可刷新的供应商')
          action = { type: 'model.refresh', provider }; break
        }
        case 'grants.revoke': {
          const workspace = command.workspace ?? grants?.workspace
          if (!workspace) throw new Error('请先读取要撤销的工作区授权')
          action = { ...command, workspace, grantStamp }; break
        }
      }
      if (action) note = await settings.apply(action, configStamp(`${magic.base}/config.json`))
    } catch (error) { note = error instanceof Error ? error.message : String(error) }
    try {
      if (command.type === 'prefs.set') {
        const config = loadConfig({ magic }).config
        emit('prefs.state', { statusLine: config.statusLine, reducedMotion: config.motion?.reduced === true, note })
      } else if (command.type === 'grants.list' || command.type === 'grants.revoke') {
          const path = `${magic.base}/grants.json`, before = configStamp(path)
          const local = readGrantView(magic, grants ? createWorkspaceService({ roots: [grants.workspace] }) : workspace)
          if (configStamp(path) !== before) throw new Error('授权在读取期间已改变，请重新读取')
          const problem = [note, grantsTrouble(local.path, local.unreadable), local.note].filter(Boolean).join('；')
          grantStamp = before; grants = { ...local.view,
            ...(grants?.decisions ? { decisions: grants.decisions } : {}),
            ...(grants?.history ? { history: grants.history } : {}), ...(problem ? { note: problem } : {}) }
          emit('grants.catalog', grants)
      } else {
        const reader = await settings.catalog(selection, selection ? undefined : initial)
        if (command.type.startsWith('provider.')) emit('provider.catalog', providerCatalog(reader, note))
        else emit('model.catalog', { ...modelCatalog(reader, loadConfig({ magic }).config.models), ...(note === undefined ? {} : { note }) })
      }
    } catch (error) {
      const failure = [note, error instanceof Error ? error.message : String(error)].filter(Boolean).join('；')
      emit('provider.catalog', { entries: [], vendors: [], note: failure })
    } finally { await network.close() }
  }
  return {
    offlineCommands: [...local],
    send(command) {
      if (!local.has(command.type)) { transport.send(command); return }
      if (command.type === 'grants.list') transport.send(command)
      queue = queue.then(() => handle(command)).catch(error => emit('provider.catalog', { entries: [], vendors: [], note: String(error) }))
    },
    subscribe(listener) {
      listeners.add(listener)
      unsubscribe ??= transport.subscribe(receive)
      return () => { listeners.delete(listener); if (listeners.size === 0) { unsubscribe?.(); unsubscribe = undefined } }
    },
  }
}
