/**
 * 命令解析——`/help` 文案、命令串引用、交代正文的纯解析，以及 **slash 分发**（`runSlash`）。
 *
 * T3.4 SRP 拆分自 `shell.ts` 搬出：阶段一搬静态面（纯搬移）；阶段三搬分发
 * （`createSlashRouter`——原先闭包直摸的外壳状态改经 `SlashHost` 取存器进出，
 * 接线写法与既有 picker 工厂同一模式，行为不变）。
 * 这一层**返回待发的命令、自己不 `send`**（顺序由外壳的 `submit` 决定，见那段注）。
 */
import type { AgentId, Command, KernelEvent } from '@magic/contracts'
import { reasoningText } from './boards/capabilities/models.ts'
import { createModelSettings } from './boards/capabilities/model-settings.ts'
import { currentMember, workTabs } from './boards/conversation/collaboration.ts'
import type { DraftRef } from './components/inline.ts'
import { STATUS_TITLE, statusLines } from './shell-status.ts'
import { COMMANDS, appendOutput, appendReceipt, openPicker, type PageTurn, type ShellView } from './view.ts'

/** `/help` 沿用记录区输出；命令用法与候选共用登记表。 */
export const HELP_TITLE = '使用帮助'

const HELP_COMMAND_WIDTH = Math.max(...COMMANDS.map(command => command.name.length))

export const HELP_LINES: readonly string[] = [
  '输入任务描述开始工作；/ 查找命令，@ 引用文件或会话。',
  '命令：',
  ...COMMANDS.map(command => `  ${command.name.padEnd(HELP_COMMAND_WIDTH + 2)}${command.summary}`),
  '参数用法：',
  '  /rename <名称> · /skills [关键词] · /compact [本次重点]',
  '  /model connect              接入模型连接',
  '  /model manage               管理连接与档位',
  '  /model refresh [连接]       刷新模型列表',
  '  /mcp [服务器]               查看服务器详情',
  '  /mcp reconnect <服务器>     重连服务器',
  '快捷键：',
  '  Enter                发送',
  '  Shift+Enter          换行',
  '  Tab                  补全',
  '  ↑ / ↓                选择候选',
  '  Esc                  临时层返回；主输入运行中停止，保留草稿',
  '  Ctrl+R / /connect    重连当前会话并刷新',
  '  Ctrl+P / Ctrl+N      召回上一条 / 下一条输入',
  '  Ctrl+O               查看记录',
  '  Ctrl+T               展开或收起计划',
  '  Alt+Enter            选择本条输入用途',
  'Ctrl+C：工作中时选择停止、转后台或退出。',
  '空闲时 1 秒内连按两次 Ctrl+C 退出界面，App 继续运行。',
]

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * 一句交代里**用户说的话**——去掉已有的引用区间，再去掉句首那个还没绑上的技能名。
 *
 * 与 `bodyOf` 分开的理由：句首那个斜杠词**此刻还不是引用**（用户正按回车让它变成引用），
 * 故它自己那一截要从「有没有别的话」这笔账里去掉——不去掉的话，`/pdf` 单独一条会被
 * 当成「说了点什么」而直接发出去（一次一个字都没有的交代）。
 */
export function spokenOf(draft: string, refs: readonly DraftRef[], word: string): string {
  const spoken = bodyOf(draft, refs)

  return spoken.startsWith(word) ? spoken.slice(word.length) : spoken
}

export function submittable(draft: string, refs: readonly DraftRef[]): boolean {
  if (bodyOf(draft, refs).trim() !== '') return true

  return refs.some((ref) => ref.kind !== 'skill')
}

function bodyOf(draft: string, refs: readonly DraftRef[]): string {
  let out = ''
  let cursor = 0

  for (const ref of [...refs].sort((left, right) => left.start - right.start)) {
    out += draft.slice(cursor, Math.max(cursor, Math.min(ref.start, draft.length)))
    cursor = Math.max(cursor, Math.min(ref.end, draft.length))
  }

  return out + draft.slice(cursor)
}

/**
 * 模型之外的「等内核回话再开选择器」意图；模型入口由 model-settings 自持。
 *
 * ⚠️ **`'config'` 是唯一一个等三份答复的**（见 `CONFIG_READINGS`）：那一屏的四行里三行的
 * 当前值各有自己的读侧命令，缺一份那一格就只能写「还没问到」。
 */
export type PendingPicker =
  | 'session'
  | 'skills'
  | 'mcp'
  | 'web'
  | 'config'

/**
 * `/config` 开屏要问的那三份读数——**一份都不能少**（少一份，那一格就成了「还没问到」）。
 *
 * ⚠️ **命令与它回来的那一发事件成对写在一处**：分两处写（一处列命令、一处列事件）就有
 * 「加了一份读数、忘了加那条命令」那一类静默失配——而它的表现是**这一屏再也开不出来**
 * （等一份永远不来的答复），最难查的那一形。条数也从这一处取（`CONFIG_READINGS.length`）。
 */
export const CONFIG_READINGS: readonly {
  readonly command: Command
  readonly event: KernelEvent['kind']
}[] = [
  { command: { type: 'model.list' }, event: 'model.catalog' },
  { command: { type: 'mcp.list' }, event: 'mcp.catalog' },
  { command: { type: 'web.list' }, event: 'web.state' },
]

/**
 * 分发层要摸的外壳状态——**只给 slash 命令要动的那几格**，不递整个壳。
 * 取存器由外壳接线（同 picker 工厂的模式）；外壳那侧被写过的意图
 * （`waiting` / `configPending` / `mcpServer` / `turn` / `collaborationQuery`）住在壳上，
 * 这里只记账、不持有。
 */
export type SlashHost = {
  readonly isConnected: () => boolean
  readonly offlineCommands: () => readonly string[] | undefined
  readonly getView: () => ShellView
  readonly workspaceRoots: readonly string[] | undefined
  readonly setWaiting: (waiting: PendingPicker | null) => void
  readonly setSkillSeed: (seed: string) => void
  readonly setConfigPending: (pending: ReadonlySet<KernelEvent['kind']>) => void
  readonly setMcpServer: (server: string) => void
  readonly setTurn: (turn: { readonly kind: PageTurn; readonly label: string | null } | null) => void
  readonly setCollaborationQuery: (query: { readonly member?: AgentId } | null) => void
  readonly models: ReturnType<typeof createModelSettings>
  readonly noteResult: (from: ShellView, text: string) => ShellView
}

/**
 * slash 分发——**两种走法在这一处落定**。
 *
 * ⚠️ **返回待发的命令、自己不 `send`**（顺序见外壳 `submit` 里那段注）：进程内传输是
 * **同步**直连的——命令一发出，答复**当场**回到 `onEvent` 改视图；命令若发在 `commit`
 * **之前**，外层那次**基于旧快照**的 `commit` 会把答复的改动整个盖掉。
 * （`/model` 的选择器就这么一直开不出来：`model.catalog` 明明到了，又被盖回输入区。）
 */
export function createSlashRouter(host: SlashHost): (
  from: ShellView,
  text: string,
) => { readonly next: ShellView; readonly commands: readonly Command[]; readonly leaving: boolean } {
  const runSlash = (
    from: ShellView,
    text: string,
  ): { readonly next: ShellView; readonly commands: readonly Command[]; readonly leaving: boolean } => {
    const [word, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ').trim()
    // 命令把这一行整个吃掉了（交互配置型不带正文）——**引用也跟着走**：
    // 它们指向的那段文字已经不在草稿里了（留着就是「正文没了、材料还在」的暗带）。
    const cleared: ShellView = { ...from, draft: '', caret: 0, refs: [] }
    /** 本地这一下的改动 ＋ 待发的命令——两件一起交回调用方（它决定次序）。 */
    const only = (
      next: ShellView,
      ...commands: Command[]
    ): { next: ShellView; commands: readonly Command[]; leaving: boolean } => ({
      next,
      commands,
      leaving: false,
    })

    /**
     * **断线时先问连接、再动界面**：需要引擎的命令不在本地留下半开的页面或等待态——
     * 直接回一句说明、**草稿保留**（`submit` 见最后一行是回执就把草稿还原）。
     *
     * 判据取**这条命令要发的那些命令**是否都在 `offlineCommands` 里，而不是「断没断」：
     * 设置模式下 `mcp.list` 也由入口直接答，`/config` 因此照常可用；普通模式断线时它要等
     * 一份不会来的答复，才该拦。纯壳命令（`/help`、`/status`、`/exit`）不在表里。
     */
    const needs: readonly Command['type'][] = word === '/clear' ? ['session.new']
      : word === '/ps' ? ['collaboration.read', 'background.list']
        : word === '/resume' ? ['session.list']
          : word === '/rename' ? ['session.rename']
            : word === '/skills' ? ['skills.list']
              : word === '/config' ? ['model.list', 'mcp.list', 'web.list']
                : word === '/mcp' ? ['mcp.list']
                  : []
    const offline = (): { next: ShellView; commands: readonly Command[]; leaving: boolean } =>
      only(appendReceipt(cleared, `Engine 未连接，${word} 需要连接后使用；草稿保留`))
    if (!host.isConnected() && needs.length > 0 && !needs.every(type => host.offlineCommands()?.includes(type) === true)) return offline()

    // —— 本地结果进记录区，原文已按用户输入回显 ——
    if (word === '/help') return only(appendOutput(cleared, HELP_TITLE, HELP_LINES))
    if (word === '/status') return only(appendOutput(cleared, STATUS_TITLE, statusLines(from, host.workspaceRoots)))

    if (word === '/clear') {
      // 开一条新的——**清屏由内核那一声答复触发**（页号一变，渲染层就翻页，见
      // `components/app.ts`）：这一侧只发命令。内核忙时会把它挡回（`BUSY_NOTE`），
      // 那时活跃位不动、页也不翻，屏幕上落的是那行 note（见 `onEvent`）——
      // 说出来的话就都是真发生过的。
      //
      // ⚠️ **不带参数**：`/clear` 是个动作，不是一族动作的入口（`/session new` 那套
      // 「同一入口下挂动作」的姿势留给 `/model`）。多写的词照 `submit` 那一侧的老规矩
      // 如实回一句，不当交代发出去。
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/clear（不带参数）'))

      host.setTurn({ kind: 'new', label: null })
      return only(cleared, { type: 'session.new' })
    }

    if (word === '/ps') {
      if (arg) return only(appendReceipt(cleared, '用法：/ps'))
      host.setCollaborationQuery({})
      return only(openPicker(cleared, { source: 'collaboration', title: '整件工作', tabs: workTabs('collaboration'), rows: [], selected: 0, hint: '正在读取 · Tab/Shift+Tab 切换 · Esc 返回' }), { type: 'collaboration.read' }, { type: 'background.list' })
    }

    if (word === '/resume') {
      if (arg === '') {
          host.models.cancelOpen()
        host.setWaiting('session')
        return only(cleared, { type: 'session.list' })
      }
      // **`/resume <参数>` 先不做**（设计明文）：标题就是第一句交代，又长又会重名——
      // 「有参数」得先定一个不含糊的认法（序号？名字前缀？）。故如实说一句，
      // **不按字面猜一条切过去**（猜错就是「切到了另一条上」而用户以为敲的是名字）。
      return only(appendReceipt(cleared, '认得的用法：/resume——空着回车＝列出可选（带名字找那一路还没定）'))
    }

    if (word === '/rename') {
      // 名字取**这一行剩下的全部**（名字里可以有空格）；两头空白不算——空到没有
      // （`/rename` 或 `/rename   `）就照「没给」办，**不静默**（设计明文）。
      const title = arg.trim()
      if (title === '') return only(appendReceipt(cleared, '要改成什么？`/rename <文本>`'))
      // 还没有会话＝没有「当下这条」可改（空手开机就是这个状态）——如实说一句，不静默，
      // 也不替他把会话开出来（改名不是开张的动作）。
      if (from.sessionId === null) {
        return only(appendReceipt(cleared, '还没有会话可改名——先交代一句开张'))
      }
      return only(cleared, { type: 'session.rename', session: from.sessionId, title })
    }

    if (word === '/exit') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/exit（不带参数）'))
      // 本地这一下只有一个意图：停掉这条、然后走。**当场不留回执**——「停哪一条」那句话
      // 由停止编排那一头拼（`正在停「X」`），此处再印一句就是同一条事实说两遍
      // （设计：一屏上的提示各自说不同的东西）。
      return { next: cleared, commands: [], leaving: true }
    }

    if (word === '/skills') {
      host.models.cancelOpen()
      host.setWaiting('skills')
      host.setSkillSeed(arg)
      return only(cleared, { type: 'skills.list' })
    }

    if (word === '/web') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/web（不带参数）'))
      host.models.cancelOpen()
      host.setWaiting('web')
      return only(cleared, { type: 'model.list' }, { type: 'web.list' })
    }

    if (word === '/config') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/config（不带参数）'))
      host.models.cancelOpen()
      host.setWaiting('config')
      host.setConfigPending(new Set(CONFIG_READINGS.map(one => one.event)))
      return only(cleared, ...CONFIG_READINGS.map((one) => one.command))
    }

    if (word === '/effort') {
      if (arg !== '') {
        host.models.clearTarget()
        const effortMember = currentMember(from)
        if (effortMember !== undefined) host.models.target(effortMember.agent.agentId)
        // 纯校验（声明了什么就认什么）；结果按会话状态落：没有会话留在窗口，有会话发切换
        const outcome = host.models.validateReasoningArg(arg)
        if (!outcome.ok) return only(appendReceipt(cleared, outcome.note))
        if (host.getView().sessionId === null) {
          return only(host.noteResult({ ...cleared, modelChoice: { ...(cleared.modelChoice ?? {}), reasoning: outcome.setting } }, `已选定 ${reasoningText(outcome.setting)}；下一条消息起用它`))
        }
        return only(cleared, { type: 'model.switch', reasoning: outcome.setting })
      }
      // 已开着就原样刷新；否则登记作用对象（子会话只改该成员）
      if (!(from.dock.kind === 'picker' && from.dock.picker.source === 'model-reasoning')) {
        host.models.clearTarget()
        const effortMember = currentMember(from)
        if (effortMember !== undefined) host.models.target(effortMember.agent.agentId)
      }
      host.setWaiting(null)
      return only(cleared, host.models.openReasoning())
    }

    if (word === '/model') {
      const member = currentMember(from)
      // 切换器已开着 ⇒ 原样刷新，不动作用对象；否则登记作用对象（子会话只改该成员）。
      if (!(from.dock.kind === 'picker' && from.dock.picker.source === 'model-choice')) {
        host.models.clearTarget()
        if (member !== undefined) host.models.target(member.agent.agentId)
      }

      // 先登记开页意图，外层落下草稿后再发送；同步回执不能被旧视图覆盖。
      host.setWaiting(null)
      if (arg === 'refresh' || arg.startsWith('refresh ')) {
        return only(cleared, host.models.request('refresh', arg.slice('refresh'.length).trim()))
      }
      if (arg === 'connect' || arg === 'manage') return only(cleared, host.models.request(arg))
      if (arg === '') return only(cleared, host.models.openSwitcher())

      return only(appendReceipt(cleared, `认得的用法：/model · /model refresh [连接] · /model connect · /model manage`))
    }

    if (word === '/mcp') {
      // ⚠️ 按**完整命令词**认（`reconnect` / `reconnect <名字>`）：服务器名可以长成
      // `reconnect-db` 那样，`startsWith('reconnect')` 会把 `/mcp reconnect-db` 误当重连指令
      if (arg === 'reconnect' || arg.startsWith('reconnect ')) {
        const who = arg.slice('reconnect'.length).trim()
        if (who === '') return only(appendReceipt(cleared, '要重连哪一台？`/mcp reconnect <名字>`'))

          host.models.cancelOpen()
        host.setWaiting('mcp')
        host.setMcpServer(who)
        return only(cleared, { type: 'mcp.reconnect', server: who })
      }

      host.models.cancelOpen()
      host.setWaiting('mcp')
      host.setMcpServer(arg)
      return only(cleared, { type: 'mcp.list' })
    }

    return only(appendReceipt(cleared, `不认得的命令「${word}」——试试 /help，或到 /skills 里找`))
  }

  return runSlash
}
