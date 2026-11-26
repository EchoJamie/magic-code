/**
 * `/status` 正文与状态行选择器标题的**本地文案**——渲染分治的静态面。
 *
 * T3.4 SRP 拆分阶段一自 `shell.ts` 顶层搬出：纯搬移、行为不变（调用点只有外壳的
 * `/status` 与状态行选择器，见 `shell.ts`）。`/status` **本地就能答**——模型 / 用量 /
 * 会话都在外壳手上，不必问内核。
 */
import { usageLabel } from './components/lines.ts'
import { configReasoningOf, reasoningText } from './boards/capabilities/models.ts'
import { durationText, roundDuration } from './boards/conversation/round.ts'
import type { ShellView } from './view.ts'

/**
 * `/status` 的正文——**本地就能答**（模型 / 用量 / 会话都在外壳手上，不必问内核）。
 *
 * 设计（2026-11-22 用户定稿）：**无标签列**——内容的形状自明（8 位十六进制＋标题＝会话、
 * 绝对路径＝工作区、档位开头＝模型组合、`输入 x/y`＝用量）；**不抄状态行**——面板给的是
 * 行上放不下的那一层（全路径、连接、思考档、回合时长）；**没消息不占行**——出错才有 ▲ 行，
 * 「未见异常」那种话不存在；**0 是事实**——新会话的用量就是 `0/…`。
 */
export function statusLines(view: ShellView, launchRoots?: readonly string[]): readonly string[] {
  const { status, sessionId, catalog, modelCurrent } = view
  const active = catalog.find(one => one.id === sessionId)

  // 身份：**完整 id 独占一行**（用户 2026-11-22 裁定——要能整段复制），标题另起一行；
  // 还没有会话就如实说「新会话」。
  const identity = sessionId === null
    ? ['新会话']
    : [sessionId, ...(active?.title === undefined ? [] : [active.title])]

  // 工作区：会话**锚定的那组根**（[0]＝默认根；多根＝联合作用域，全列）；
  // 还没有会话 ⇒ 启动目录那组。旧账缺席（列加上之前落账的）＝不编，整行不出现。
  const roots = active?.workspace ?? (sessionId === null ? launchRoots : undefined)
  const workspace = roots === undefined || roots.length === 0 ? undefined : roots.join(' ＋ ')

  // 模型组合：档位 · 连接 / 型号 · 思考档（思考显示的就是值：`high` / `默认` / `off` / `≤8k`）。
  // 没钉思考设置 ＝ 跟默认走 ⇒ 解析供应商声明的默认档；钉了就用钉的那一档。
  const setting = configReasoningOf(modelCurrent) ?? { mode: 'default' as const }
  const support = modelCurrent === null
    ? undefined
    : view.models.find(one => one.provider === modelCurrent.provider)?.effectiveReasoning?.[modelCurrent.model]
  const head = [status.model ?? undefined, modelCurrent === null ? undefined : `${modelCurrent.provider} / ${modelCurrent.model}`]
  const model = head.some(one => one !== undefined)
    ? [...head, reasoningText(setting, support)].filter(one => one !== undefined).join(' · ')
    : undefined

  // 计量：用量与状态行 ④ **同一个口径**（`usageLabel`，两处各报各的迟早分叉）；
  // 时长＝最近一轮（跑着实时，闲着是刚跑完那轮；新会话没有轮次就不提）。
  const usage = usageLabel(status.usage, status.window)
  const round = view.round === null ? null : roundDuration(view.round, view.turnDuration, Date.now())
  const metering = [
    usage === null ? undefined : `输入 ${usage}`,
    round === null ? undefined : `本轮 ${durationText(round)}`,
  ].filter(one => one !== undefined).join(' · ')

  return [
    ...identity,
    workspace,
    model,
    metering,
    // 「连得上不」只说实话：最近一次模型调用**出错**就点名（那是外壳看得见的事实）；
    // 未见异常**不占行**（没消息不占行）。
    ...(status.state === 'error' ? ['▲ 上一次模型调用没成'] : []),
  ].filter((one): one is string => one !== undefined && one !== '')
}

export const STATUS_TITLE = '此刻'

export const STATUSLINE_TITLE = '状态行放哪几格'
