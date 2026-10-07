import type { CollaborationClient, CollaborationRequest, MessagePart } from '@magic/contracts'
import type { ToolDefinition } from './registry.ts'

export const AGENT_TOOL_NAMES = ['agent_list', 'agent_spawn', 'agent_message', 'agent_wait', 'agent_control', 'consult_arcane'] as const
const text = { type: 'string', minLength: 1 } as const
const strings = { type: 'array', items: text } as const
const bodySchema = { type: 'array', minItems: 1, items: {
  type: 'object', properties: { kind: { enum: ['text', 'entry'] }, text,
    ref: { type: 'object', properties: { sessionId: text, entryId: { type: 'integer', minimum: 1 } }, required: ['sessionId', 'entryId'], additionalProperties: false }, label: text },
  required: ['kind'], additionalProperties: false,
} } as const
const modelSchema = { type: 'object', properties: { choice: { enum: ['default', 'cantrip', 'spell', 'arcane'] },
  reasoning: { type: 'object', properties: { mode: { enum: ['default', 'off', 'level', 'budget'] }, level: text, budgetTokens: { type: 'integer', minimum: 1 } }, required: ['mode'], additionalProperties: false },
}, additionalProperties: false } as const

/** 工具只呈现模型入口；sender、工作区、授权与当前委派由宿主绑定。 */
export function defineAgentTools(client: CollaborationClient): readonly ToolDefinition[] {
  return [
    tool('consult_arcane', '就具体问题请 Arcane 在后台只读查证并给建议。仅提交相关材料或原始引用；立即返回受理标识，可继续独立步骤，依赖意见时用 agent_wait，撤回复用 agent_control。重试复用 operationId。',
      { operationId: text, question: text, body: bodySchema, reasoning: modelSchema.properties.reasoning }, ['operationId', 'question'], args => ({
        action: 'consult', operationId: required(args, 'operationId'), question: required(args, 'question'),
        ...(args.body === undefined ? {} : { body: body(args.body) }),
        ...(args.reasoning === undefined ? {} : { reasoning: reasoning(args.reasoning) }),
      })),
    tool('agent_list', '查看本次协作的成员、明确委派和等待；不创建成员、不启动查看对象。', {}, [], () => ({ action: 'list' })),
    tool('agent_spawn', '分出需要独立上下文的一份工作。说明职责、修改范围、结果和约束；成员继承本工作区，先接受再执行。重试复用 operationId。',
      { operationId: text, name: text, role: text, responsibility: text, scope: text, body: bodySchema, model: modelSchema, modelReason: text },
      ['operationId', 'name', 'responsibility', 'scope', 'body'], args => {
        const model = args.model
        if (model !== undefined && (!object(model) || Object.keys(model).some(key => !['choice', 'reasoning'].includes(key)) || (model.choice !== undefined && !['default', 'cantrip', 'spell', 'arcane'].includes(String(model.choice))))) throw new Error('model 只接受配置的默认模型或模型档位，以及独立思考设置')
        if (object(model) && model.choice !== undefined && optional(args, 'modelReason') === undefined) throw new Error('选择模型档位须说明与任务相关的 modelReason')
        return { action: 'spawn', operationId: required(args, 'operationId'), name: required(args, 'name'), responsibility: required(args, 'responsibility'), scope: required(args, 'scope'), body: body(args.body),
          ...(optional(args, 'role') === undefined ? {} : { role: optional(args, 'role')! }),
          ...(optional(args, 'modelReason') === undefined ? {} : { modelReason: optional(args, 'modelReason') }),
          ...(model === undefined ? {} : { model: model as Extract<CollaborationRequest, { action: 'spawn' }>['model'] }),
        } as CollaborationRequest
      }),
    tool('agent_message', '同工作成员的通信：已有discussionRoot可省recipients，默认送该讨论参与者；新问题明确点名，不广播全体。询问/告知不抢占工作；委派需明确接受；结果包含结论、产物、验证及未解决项。已接收不等于已纳入请求或接受。',
      { action: { enum: ['send', 'delegate', 'respond', 'deliver', 'receive', 'read'] }, operationId: text, recipients: strings, recipient: text,
        purpose: { enum: ['inform', 'question', 'reply', 'decision'] }, body: bodySchema,
        replyTo: { type: 'integer' }, discussionRoot: { type: 'integer' }, startDiscussion: { type: 'boolean' }, scope: text,
        delegation: { type: 'integer' }, response: { enum: ['accept', 'reject', 'clarify'] }, reason: text,
        conclusion: text, artifacts: strings, verified: strings, unresolved: strings, message: { type: 'integer' }, discussion: { type: 'boolean' } },
      ['action'], args => messageRequest(args)),
    tool('agent_wait', '确实依赖结果时登记有期限的持久等待并让出推进。消息/超时会唤起；不用反复查询，不阻塞其他成员。',
      { operationId: text, agents: strings, message: { type: 'integer' }, expectation: text, deadline: { type: 'number', description: '截止点，Unix 毫秒' } },
      ['operationId', 'agents', 'expectation', 'deadline'], args => ({ action: 'wait', operationId: required(args, 'operationId'), agents: list(args, 'agents'), expectation: required(args, 'expectation'), deadline: number(args, 'deadline'),
        ...(args.message === undefined ? {} : { message: number(args, 'message') }),
      })),
    tool('agent_control', '撤回指定委派及其继续分发，或由协调者整体停止/收尾。收尾须核验结果，回复结束不代表已交付。',
      { action: { enum: ['stop', 'close'] }, delegation: { type: 'integer' }, reason: text }, ['action'], args => {
        if (args.action === 'close') return { action: 'close' }
        if (args.action !== 'stop') throw new Error('action 须是 stop 或 close')
        return { action: 'stop', reason: required(args, 'reason'), ...(args.delegation === undefined ? {} : { delegation: number(args, 'delegation') }) }
      }),
  ]

  function tool(name: string, summary: string, properties: Record<string, unknown>, requiredFields: readonly string[], parse: (args: Readonly<Record<string, unknown>>) => CollaborationRequest): ToolDefinition {
    return { spec: { name, summary, parameters: { type: 'object', properties, required: requiredFields, additionalProperties: false }, danger: { level: 'light' } },
      async run(args) {
        try {
          if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new Error('包含未声明参数；身份、授权和工作区不能由消息指定')
          const request = parse(args)
          const reply = await client.request(request)
          return reply.ok ? { ok: true, output: (request.action === 'consult' ? '咨询受理回执（不表示顾问已完成）：\n' : '') + JSON.stringify(reply.value),
            ...(request.action === 'wait' && object(reply.value) && reply.value.ok === true
              && object(reply.value.wait) && reply.value.wait.state === 'waiting' ? { halt: true as const } : {}),
          } : { ok: false, output: reply.reason }
        } catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error) } }
      },
    }
  }
}

function messageRequest(args: Readonly<Record<string, unknown>>): CollaborationRequest {
  switch (args.action) {
    case 'send': {
      const purpose = args.purpose
      if (purpose !== 'inform' && purpose !== 'question' && purpose !== 'reply' && purpose !== 'decision') throw new Error('通信 purpose 无效')
      return { action: 'send', operationId: required(args, 'operationId'), recipients: args.recipients === undefined && args.discussionRoot !== undefined ? [] : list(args, 'recipients'), purpose, body: body(args.body),
        ...(args.replyTo === undefined ? {} : { replyTo: number(args, 'replyTo') }),
        ...(args.discussionRoot === undefined ? {} : { discussionRoot: number(args, 'discussionRoot') }),
        ...(args.startDiscussion === true ? { startDiscussion: true } : {}),
      }
    }
    case 'delegate': return { action: 'delegate', operationId: required(args, 'operationId'), recipient: required(args, 'recipient'), scope: required(args, 'scope'), body: body(args.body) }
    case 'respond': {
      const response = args.response
      if (response !== 'accept' && response !== 'reject' && response !== 'clarify') throw new Error('response 须是 accept/reject/clarify')
      return { action: 'respond', operationId: required(args, 'operationId'), delegation: number(args, 'delegation'), response,
        ...(optional(args, 'reason') === undefined ? {} : { reason: optional(args, 'reason')! }),
      }
    }
    case 'deliver': return { action: 'deliver', operationId: required(args, 'operationId'), delegation: number(args, 'delegation'), conclusion: required(args, 'conclusion'), artifacts: list(args, 'artifacts'), verified: list(args, 'verified'), unresolved: list(args, 'unresolved') }
    case 'receive': return { action: 'receive', delegation: number(args, 'delegation') }
    case 'read': return { action: 'read', message: number(args, 'message'), ...(args.discussion === true ? { discussion: true } : {}) }
    default: throw new Error('未知的成员通信动作')
  }
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function required(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} 须是非空文本`)
  return value
}
function optional(args: Readonly<Record<string, unknown>>, key: string): string | undefined { return args[key] === undefined ? undefined : required(args, key) }
function number(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 须是正整数`)
  return value
}
function list(args: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) throw new Error(`${key} 须是文本数组`)
  return value as string[]
}
function body(value: unknown): readonly MessagePart[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('body 须是有序正文数组')
  return value.map(part => {
    if (!object(part)) throw new Error('正文项须是对象')
    if (Object.keys(part).some(key => !['kind', 'text', 'ref', 'label'].includes(key))) throw new Error('正文项包含未声明字段')
    if (part.kind === 'text') return { kind: 'text', text: required(part, 'text') }
    if (part.kind === 'entry' && object(part.ref)) {
      if (Object.keys(part.ref).some(key => !['sessionId', 'entryId'].includes(key))) throw new Error('记录引用包含未声明字段')
      return { kind: 'entry', ref: { sessionId: required(part.ref, 'sessionId'), entryId: number(part.ref, 'entryId') },
        ...(optional(part, 'label') === undefined ? {} : { label: optional(part, 'label')! }),
      }
    }
    throw new Error('正文项只接受 text 或可回查记录引用 entry')
  })
}

function reasoning(value: unknown): NonNullable<Extract<CollaborationRequest, { action: 'consult' }>['reasoning']> {
  if (!object(value) || Object.keys(value).some(key => !['mode', 'level', 'budgetTokens'].includes(key))) throw new Error('reasoning 只接受独立思考设置')
  switch (value.mode) {
    case 'default': case 'off': return { mode: value.mode }
    case 'level': return { mode: 'level', level: required(value, 'level') }
    case 'budget': return { mode: 'budget', budgetTokens: number(value, 'budgetTokens') }
    default: throw new Error('reasoning.mode 无效')
  }
}
