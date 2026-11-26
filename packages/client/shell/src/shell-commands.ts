/**
 * 命令解析的**静态面**——`/help` 文案、命令串引用、交代正文的纯解析。
 *
 * T3.4 SRP 拆分阶段一自 `shell.ts` 顶层搬出：纯搬移、行为不变。这一层**无状态**：
 * 输入是草稿与引用，输出是文案与判定；分发（`runSlash`）仍在外壳，这里只供料。
 */
import type { DraftRef } from './components/inline.ts'
import { COMMANDS } from './view.ts'

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
