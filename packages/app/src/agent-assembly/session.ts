import { createKnowledgeAccess, createMaterialReader } from '@magic/conversation'
import { defineKnowledgeTools, KNOWLEDGE_TOOL_NAMES, defineSourceTool } from '@magic/tools'
import type {
  AgentModelConfig,
  AgentRoleConfig,
  BackgroundChange,
  CollaborationReply,
  CollaborationRequest,
  EventSink,
  EventStamper,
  MagicHome,
  Materials,
  ModelGateway,
  ProjectRule,
  ProjectRules,
  RecordsService,
  Sandbox,
  SessionId,
  Skills,
  SudoAuth,
  Timestamp,
  ToolRuntime,
  WebSource,
  WorkspaceService,
} from '@magic/contracts'
import { CONSULTATION_TOOL_NAMES } from '@magic/contracts'
import type { ContextPolicy, ConversationSession, PromptVars } from '@magic/conversation'
import { createConversationSession, createPlanReader } from '@magic/conversation'
import { createProjectRules, createWorkingNotes,
  type BackgroundRegistry,
} from '@magic/execution'
import type { ModelRegistry } from '@magic/model'
import { createPageDistiller } from '@magic/model'
import { createPermissionGate } from '@magic/permission'
import type { RecordsStore } from '@magic/records'
import type { ToolDefinition } from '@magic/tools'
import {
  createToolRuntime,
  defineAgentTools,
  defineBackgroundTools,
  definePlanTools,
  defineSkillTool,
  defineWebFetchTool,
  defineWebSearchTool,
} from '@magic/tools'
import type { WebServiceRef } from '@magic/tools'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { bindModelChoice } from '../agent-models.ts'
import { createBackgroundSession } from '../background-session.ts'
import { createCollaborationBoundary } from '../collaboration-boundary.ts'
import type { LoadedConfig } from '@magic/config'
import { noModelRefusal } from '../run/observation.ts'
import type { WorkEnvironment } from '../work-environment.ts'
import { createStamper } from './events.ts'

/** 提示词注入项的环境来源——只放**环境**；`cwd` 是工作区默认根，两处必须同一个值。 */
export type EnvironmentVars = {
  /** 平台（注入项 `platform`）——缺省 `process.platform`。 */
  readonly platform?: string
  /** 日期（注入项 `date`）——缺省取 `now()` 的本地日期（`YYYY-MM-DD`）。 */
  readonly date?: string
}

/** 每个会话独占可变模型选择、闸门、工具、对话与后台收件。 */
export type AgentSession = {
  models: ModelRegistry | undefined
  readonly session: SessionId
  readonly records: RecordsService
  readonly gate: ReturnType<typeof createPermissionGate>
  readonly tools: ToolRuntime
  readonly service: ConversationSession
  readonly roleRules: ProjectRules
  readonly stamper: EventStamper
  readonly background: ReturnType<typeof createBackgroundSession> | undefined
}

/** 只接构造依赖；不持有当前展示目标、客户端目录或其他会话的可变状态。 */
export function createAgentSession(input: {
  session: SessionId
  magic: MagicHome
  context: Partial<ContextPolicy> | undefined
  prompt: EnvironmentVars | undefined
  webSource: WebSource | undefined
  modelGateway: ((stamper: EventStamper) => ModelGateway) | undefined
  collaboration: ((session: SessionId, request: CollaborationRequest) => Promise<CollaborationReply>) | undefined
  collaborationChanged: (() => void) | undefined
  loaded: LoadedConfig
  recordsStore: RecordsStore
  workspace: WorkspaceService
  sudoAuth: SudoAuth | undefined
  sink: EventSink
  now: () => Timestamp
  signal: AbortSignal
  network: WorkEnvironment
  executionId: string
  backgroundRuns: BackgroundRegistry | undefined
  sandbox: Sandbox
  projectRules: ProjectRules
  skills: Skills
  materials: Materials
  mcpTools: () => readonly ToolDefinition[]
  model: {
    create: (selection: AgentModelConfig | undefined, stamper: EventStamper) => ModelRegistry | undefined
    cantrip: (stamper: EventStamper) => ReturnType<typeof bindModelChoice>
    canDistill: () => boolean
    connections: () => number
    /** 网页服务读数（U94）——每次工具调用现取；未配置 / 缺凭据给一句可处置的话。 */
    webSource: () => WebServiceRef
  }
}): AgentSession {
  const {
    session, context, prompt, webSource, modelGateway,
    collaboration, collaborationChanged, loaded, recordsStore, workspace,
    sudoAuth, sink, now,
    signal, network, executionId, backgroundRuns,
    sandbox, projectRules, skills, materials, mcpTools, model,
  } = input
  const identity = recordsStore.collaboration.agentForSession(session)
  if (identity !== undefined) {
    if (JSON.stringify(identity.workspace) !== JSON.stringify(workspace.roots())) {
      throw new Error('成员工作区与本执行实例不同——须在成员持久工作区接回')
    }
  }
  const consulting = identity?.purpose === 'consultation'
  const records = recordsStore.serviceFor(session)
  const notes = createWorkingNotes(input.magic.base, session)
  const noteToolNames = ['read', 'write', 'edit', 'ls', 'grep', 'glob']
  const ownNoteCall = (call: import('@magic/contracts').ToolCall) => call.external === undefined && noteToolNames.includes(call.name) && typeof call.args.path === 'string' && notes.resolve(call.args.path) !== undefined
  const stamper = createStamper({ records, session, now })
  const sessionModels = model.create(identity?.model, stamper)
  const currentAcceptsImages = (): boolean | undefined => {
    const registry = opened.models
    const selected = registry?.current()
    return selected === undefined ? undefined : registry?.capabilityOf(selected.provider, selected.model)?.image
  }
  /**
   * 两项网页工具共用这一份读数：装配注入的替身（测试）优先；否则按当前配置现取。
   * 注入替身也给出与真实服务相同的「已配置」形状，便于整条装配用例。
   */
  const webService = (): WebServiceRef => webSource === undefined
    ? model.webSource()
    : { ok: true, web: webSource, provider: 'injected', scope: 'injected' }

  const webFetchTool = defineWebFetchTool({
    web: webService,
    distiller: () => {
      if (!model.canDistill()) return undefined
      try {
        const selected = model.cantrip(stamper)
        if ('failure' in selected) throw new Error(selected.failure)
        return createPageDistiller(selected)
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { distill: async () => ({ ok: false as const, kind: 'failed' as const, reason }) }
      }
    },
  })
  const webSearchTool = defineWebSearchTool({ web: webService })
  const gate = createPermissionGate({ sink, stamper, now })

  const planReader = createPlanReader({
    records,
    session,
  })
  const origin = consulting && identity.createdBy !== undefined ? recordsStore.collaboration.getAgent(identity.createdBy) : undefined
  if (consulting && origin === undefined) throw new Error('咨询缺少可信的发起会话')
  const originRole = origin?.role ? loaded.config.agentRoles?.[origin.role] : undefined
  if (origin?.role && originRole === undefined) throw new Error(`未知发起角色「${origin.role}」`)
  const sourceReader = origin === undefined ? planReader : createPlanReader({
    records: recordsStore.serviceFor(origin.sessionId), session: origin.sessionId,
  })
  const planTools = definePlanTools(sourceReader).filter(tool => !consulting || tool.spec.name !== 'plan_update')
  const knowledge = recordsStore.knowledge
  const knowledgeMaterial = (source: import('@magic/contracts').MemorySource & { readonly limit?: number }, evidence?: readonly import('@magic/contracts').MemorySource[]) => {
    const references = records.inputs.list().filter(row => row.state === 'consumed' || row.state === 'included')
      .flatMap(row => row.input.refs?.filter((ref): ref is Extract<import('@magic/contracts').InputRef, { kind: 'session' }> => ref.kind === 'session') ?? [])
    return createMaterialReader({ records, session, references, ...(evidence === undefined ? {} : { allowedSources: evidence }) })(source)
  }
  const knowledgeTools = defineKnowledgeTools(createKnowledgeAccess({ records: knowledge, writable: !consulting, material: knowledgeMaterial }), !consulting)
  const currentRole = (): AgentRoleConfig | undefined => {
    const actor = recordsStore.collaboration.agentForSession(session)
    if (actor?.purpose === 'consultation' || !actor?.role) return undefined
    const role = Object.hasOwn(loaded.config.agentRoles ?? {}, actor.role) ? loaded.config.agentRoles?.[actor.role] : undefined
    if (role === undefined) throw new Error(`未知角色「${actor.role}」`)
    return role
  }
  const coordination = collaboration === undefined ? undefined : createCollaborationBoundary({
    records: recordsStore.collaboration, session, runId: executionId,
    materials: records, knowledge: recordsStore.knowledge, ownNoteCall,
    model: () => opened.models?.current() as AgentModelConfig | undefined,
    tools: () => tools.definitions().map(tool => tool.name),
    now, changed: () => collaborationChanged?.(),
  })
  const background = backgroundRuns === undefined ? undefined : createBackgroundSession({
    runs: backgroundRuns, session, execution: executionId,
    begin: () => coordination?.begin({ id: crypto.randomUUID(), name: 'exec', args: { background: true } }) ?? (() => undefined),
    stopped: () => signal.aborted || coordination?.boundary.admit() !== undefined,
    changed: view => sink.emit(stamper.stamp('background.state', view)),
    deliver(finish, ref) {
      const input = { ref, text: backgroundNoticeText(finish), notice: true as const, background: finish }
      if (signal.aborted || coordination?.boundary.admit() !== undefined) {
        records.inputs.accept(input, now())
        records.inputs.hold(ref, '执行范围已停止；后台终态仅记录')
      } else {
        service.submit(input)
      }
      const accepted = records.inputs.get(ref) !== undefined
      if (accepted && !('state' in finish)) sink.emit(stamper.stamp('exec.background.done', finish))
      return accepted
    },
  })
  const agentTools = consulting || collaboration === undefined ? [] : defineAgentTools({
    request: async (request) => {
      if (request.action === 'deliver' && (background?.waiting() || records.inputs.list().some(
        row => row.input.background !== undefined && (row.state === 'pending' || row.state === 'consumed'),
      ))) {
        return Promise.resolve({ ok: false as const, reason: '仍有后台结果等待或尚未处理，不能交付最终结果' })
      }
      coordination?.actor()
      const reply = await collaboration!(session, request)
      return coordination === undefined ? reply : coordination.projectReply(request, reply)
    },
  })

  const businessToolVisible = (name: string): boolean => {
    if (name === 'source_read') return true
    if (!consulting && (name === 'plan_read' || name === 'plan_update')) return true
    if ((KNOWLEDGE_TOOL_NAMES as readonly string[]).includes(name)) return !consulting || name !== 'knowledge_update'
    if (consulting) return CONSULTATION_TOOL_NAMES.includes(name) && (originRole?.tools === undefined || originRole.tools.includes(name))
    const allowed = currentRole()?.tools
    return allowed === undefined || allowed.includes(name)
      || ((name === 'background_stop' || name === 'background_wait') && allowed.includes('exec'))
      || (name.startsWith('agent_') && agentTools.some(tool => tool.spec.name === name))
  }
  const sourceTool = defineSourceTool(source => {
    const references = records.inputs.list().filter(row => row.state === 'consumed' || row.state === 'included').flatMap(row => row.input.refs?.filter((ref): ref is Extract<import('@magic/contracts').InputRef, { kind: 'session' }> => ref.kind === 'session') ?? [])
    return createMaterialReader({ records, session, references })(source)
  })
  const toolVisible = (name: string) => noteToolNames.includes(name) || businessToolVisible(name)
  const businessAllowed = (call: import('@magic/contracts').ToolCall) => ownNoteCall(call) || businessToolVisible(call.name)
  const skillTool = defineSkillTool(skills)
  const rawTools = createToolRuntime({
    beginExecution: (call) => {
      signal.throwIfAborted()
      if (!businessAllowed(call) || (consulting && call.external !== undefined)) throw new Error(`当前执行者没有开放工具 ${call.name}`)
      return coordination?.begin(call) ?? (() => undefined)
    },
    sandbox,
    notes,
    workspace,
    gate: {
      ...gate,
      decide: (call, context, ref, callSignal) => businessAllowed(call) && (!consulting || call.external === undefined)
        ? gate.decide(call, context, ref, callSignal === undefined ? signal : AbortSignal.any([signal, callSignal])) : Promise.resolve('reject'),
    },
    sink,
    stamper,
    // 大块转存经记录域公开面（blob 写权唯一归它）
    blobs: records.blobs,
    tools: () => consulting ? [sourceTool, ...knowledgeTools, ...planTools, webFetchTool]
      // 咨询只保留 Fetch——新增 Search 不自动扩大咨询的授权面
      : [skillTool, sourceTool, ...knowledgeTools, ...planTools, webFetchTool, webSearchTool, ...mcpTools(), ...agentTools, ...defineBackgroundTools()],

    trashAvailable: commandOnPath('trash', network.env),

    ...(background === undefined ? {} : { background: background.port }),
    ...(sudoAuth === undefined ? {} : { sudoAuth }),
  })
  const validateRoleTools = (): void => {
    const known = new Set(rawTools.definitions().map(tool => tool.name))
    // 网页工具按配置可能暂时 `unavailable`（未配置 / 缺凭据）——角色里点名它们
    // 不该把整条会话变成「未知工具」错误：它们仍在注册表里，只是此刻不送模型。
    known.add('web_fetch')
    known.add('web_search')
    for (const name of currentRole()?.tools ?? []) {
      if (!known.has(name)) throw new Error(`角色引用未知或不可用工具「${name}」`)
    }
  }
  const tools: ToolRuntime = {
    ...rawTools,
    definitions: () => {
      validateRoleTools()
      return rawTools.definitions().filter(tool => toolVisible(tool.name))
    },
  }
  // 复用规约读取与送达预查：每次请求、工具批次都读取当前材料，不建立内容快照。
  const roleRules: ProjectRules = {
    async load(targets, operationSignal) {
      validateRoleTools()
      const role = consulting ? originRole : currentRole()
      const actor = recordsStore.collaboration.agentForSession(session)
      const base = role?.guidanceFiles === undefined ? (await projectRules.load(targets, operationSignal)) : (await createProjectRules({
        workspace,
        sources: [...(loaded.config.rules?.sources ?? []), ...role.guidanceFiles],
        linkSources: loaded.config.rules?.linkSources ?? [],
      }).load(targets, operationSignal))
      if (role?.guidanceFiles?.length && (base.truncated || base.problems.some(problem => problem.kind === 'error'))) {
        throw new Error(`角色指导文件未完整加载：${base.problems.map(problem => `${problem.path}：${problem.message}`).join('；')}`)
      }
      const documents: ProjectRule[] = []
      const add = (path: string, name: string, text: string) => documents.push({
        kind: 'source', path, name, text, root: null, scope: null, paths: [],
      })
      if (role !== undefined) add(`${loaded.path}#agentRoles.${consulting ? origin!.role : actor!.role}`, `角色：${role.name}`, role.instructions)
      const catalog = role?.skills?.length ? (await skills.discover(operationSignal)).skills : []
      for (const reference of role?.skills ?? []) {
        const matches = catalog.filter(skill => skill.path === reference || skill.name === reference)
        if (matches.length !== 1) throw new Error(`角色技能「${reference}」${matches.length === 0 ? '未知或不可达' : '有多个来源，请使用明确路径'}`)
        const skill = matches[0]!
        const read = (await skills.readMain(skill.name, skill.path, operationSignal))
        if (!read.ok) throw new Error(`角色技能「${reference}」不可读：${read.reason}`)
        add(join(skill.path, 'SKILL.md'), `角色技能：${skill.name}（${skill.label}）`, read.material.text)
      }
      return { ...base, documents: [...base.documents, ...documents] }
    },
  }
  // 替身网关每条会话只构造一次；真实网关由本会话的显式换模更新。
  const fixed = sessionModels ?? modelGateway?.(stamper) ?? missingGateway()
  const gateway: ModelGateway = {
    stream: (request, streamOptions) => {
      // 检查最终请求，覆盖经共享约束引入的其他会话图片，不能只检查本次输入 refs。
      if (currentAcceptsImages() === false && request.messages.some(message => message.role === 'user'
        && typeof message.content !== 'string' && message.content.some(part => part.type === 'image'))) {
        throw new Error('当前成员模型明确不支持图片；请切换支持图片的模型或移除图片')
      }
      const finish = coordination?.begin()
      const actor = recordsStore.collaboration.agentForSession(session)
      const delegation = actor?.collaborationId === undefined ? undefined
        : recordsStore.collaboration.listDelegations(actor.collaborationId)
          .find(one => one.assigneeId === actor.agentId && one.state === 'accepted')
      try {
        const stream = (opened.models ?? fixed).stream(request, streamOptions)
        let responseText = ''
        const events = (async function*() {
          for await (const event of stream.events) {
            if (event.kind === 'model.delta' && event.data.channel === 'text') responseText += event.data.text
            yield event.kind === 'model.usage' && delegation !== undefined
              ? { ...event, data: { ...event.data, delegationId: delegation.delegationId } }
              : event
          }
        })()
        const result = stream.result.then(value => {
          if (consulting && (!value.complete || value.finishReason === 'length' || value.finishReason === 'content-filter'
            || value.finishReason === 'error' || value.finishReason === 'other')) {
            throw new Error(`咨询回复未完整结束（${value.finishReason ?? '流中断'}）`)
          }
          if (consulting && !value.toolCalls?.length && responseText.trim() === '') throw new Error('咨询返回空正文，未形成建议')
          return value
        }).finally(() => finish?.())
        return { ...stream, events, result }
      } catch (error) { finish?.(); throw error }
    },
  }

  const service = createConversationSession({
    knowledge,
    onInput: () => background?.cancelWait(),
    collaboration: coordination?.boundary,
    purpose: identity?.purpose,
    consultationAvailable: agentTools.length > 0 && toolVisible('consult_arcane'),
    session,
    notes,
    continuationGateway: { stream: (request, options) => (opened.models ?? fixed).stream(request, options) },
    noteTools: currentNotes => createToolRuntime({ sandbox, workspace, notes: currentNotes,
      gate: createPermissionGate({ sink: { emit() {} }, stamper, now }), sink: { emit() {} }, stamper, blobs: records.blobs, trashAvailable: false }),
    capacity: () => {
      const selected = opened.models?.current()
      return selected === undefined ? {} : { ...opened.models?.capacityOf(selected.provider, selected.model), identity: JSON.stringify(selected) }
    },
    prompt: promptVarsOf(workspace, prompt, now),
    gateway,
    tools,
    records,
    sink,
    stamper,
    now,
    rules: roleRules,
    skills,
    materials,
    context,
    submitRefusal: () => {
      const reason = noModelRefusal({
        connections: model.connections(),
        hasModel: opened.models === undefined || opened.models.current() !== undefined,
      })
      // ⚠️ **这一条被拦下时稿子不还回输入行**：下一步要敲的是 `/model connect`
      // 那条命令，稿子挡在输入行上它就会接在稿子尾巴上（见 `SubmitRefusal`）。
      return reason === undefined ? undefined : { reason, keepDraft: false }
    },
    acceptsImages: currentAcceptsImages,
    ...(backgroundRuns === undefined ? {} : { background: () => background?.port.running() ?? [] }),
  })

  const opened: AgentSession = { background, session, records, gate, tools, service, stamper, roleRules, models: sessionModels }
  return opened
}

function backgroundNoticeText(finish: BackgroundChange): string {
  if ('state' in finish) return `〔后台命令停止未确认〕${finish.id} · ${finish.command}\n${finish.reason}\n完整输出在 ${finish.outputPath}\n命令仍需确认，不得另起等效命令。`
  const how =
    finish.stopped === true
      ? '后台命令已停掉'
      : finish.ok
        ? '后台命令跑完了'
        : '后台命令结束了（非正常退出）'
  const code = finish.exit === null ? '退出码读不到' : `exit ${finish.exit}`
  const first = finish.command.split('\n', 1)[0]?.trim() ?? ''
  const shown = first.length > 80 ? `${first.slice(0, 80)}…` : first

  return [
    `〔${how}〕${finish.id}（${code}）· ${shown}`,
    `完整输出在 ${finish.outputPath}`,
    ...(finish.reason ? [finish.reason] : []),
    ...(finish.stoppedBy === 'user' ? ['用户主动停止；不得将此当作普通失败立即重启等效命令。'] : []),
  ].join('\n')
}

/** 本地日期（`YYYY-MM-DD`）——提示词的注入项 `date` 取它（用户的一天，不是 UTC 的一天）。 */
function localDate(at: Timestamp): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function commandOnPath(name: string, environment = process.env): boolean {
  const path = environment['PATH']
  if (path === undefined) return false

  for (const dir of path.split(':')) {
    if (dir === '') continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // 这个目录里没有它 / 它不可执行——看下一个
    }
  }

  return false
}

function promptVarsOf(
  workspace: WorkspaceService,
  prompt: EnvironmentVars | undefined,
  now: () => Timestamp,
): PromptVars {
  return {
    cwd: workspaceLineOf(workspace),
    platform: prompt?.platform ?? process.platform,
    date: prompt?.date ?? localDate(now()),
  }
}

function workspaceLineOf(workspace: WorkspaceService): string {
  const roots = workspace.roots()
  const first = roots[0] as string // 注册面保证 ≥ 1 条（空列表在执行域已被拒）
  const rest = roots.slice(1)

  return rest.length === 0
    ? first
    : `${first}（默认根——相对路径与新文件落它） · 另注册：${rest.join(' · ')}`
}

/** 装配期就该定好的事——走到这儿＝`modelGateway` 给了却是空的（类型上的不可能）。 */
function missingGateway(): never {
  throw new Error('模型网关没造出来——`AssembleOptions.modelGateway` 给了空值')
}
