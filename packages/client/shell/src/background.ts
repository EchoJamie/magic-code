import type { BackgroundCommand, BackgroundTarget, BackgroundView } from '@magic/contracts'
import { sanitizeForDisplay } from '@magic/contracts'
import { collaborationRow } from './collaboration.ts'
import type { Picker } from './view.ts'

export const backgroundKey = (target: BackgroundTarget): string => JSON.stringify([target.execution, target.session, target.id])
export const backgroundState = (command: BackgroundCommand): string => command.state === 'stopping' ? '停止中' : command.state === 'unconfirmed' ? '停止未确认' : '运行中'
export function backgroundPicker(view: BackgroundView | undefined, selected?: string): Picker {
  const rows = (view?.commands ?? []).map(command => collaborationRow(backgroundKey(command), command.command,
    `${command.member ? `${command.member} · ` : ''}${backgroundState(command)} · ${command.id}`))
  return { source: 'background', title: '协作成员  │  [后台命令]', rows,
    selected: Math.max(0, rows.findIndex(row => row.value === selected)),
    hint: `${view?.unknown ? '状态待确认；保留最近已知命令' : rows.length ? '整件工作 · 按启动顺序' : '没有后台命令'}\nTab/Shift+Tab 切换 · ↑↓ 选择 · Enter 详情 · Esc 返回` }
}
export function backgroundDetail(command: BackgroundCommand, view: BackgroundView | undefined, previous?: BackgroundView['result']): Picker {
  const current = view?.commands.find(one => backgroundKey(one) === backgroundKey(command))
  const result = view?.result && backgroundKey(view.result.target) === backgroundKey(command) ? view.result : previous
  const finish = result?.outcome.ok ? result.outcome.finish : undefined
  const state = result?.outcome.ok ? result.outcome.note : result?.outcome.ok === false ? `停止未确认：${result.outcome.reason}`
    : view?.unknown ? '状态待确认' : current ? backgroundState(current) : '已经结束'
  return { source: 'background-detail', title: `后台命令 ${command.id} · ${state}`, selected: 0,
    rows: [collaborationRow('copy', '复制完整输出路径'),
      ...(current && !view?.unknown && current.state !== 'stopping' ? [collaborationRow('stop', `${current.state === 'unconfirmed' ? '重试停止' : '停止'} ${command.id}`, command.command)] : []),
      collaborationRow('back', '返回后台命令列表')],
    detail: [command.command, `归属：${command.member ?? '主 Agent'}${command.agent ? ` · ${command.agent}` : ''}`,
      `会话：${command.session}`, `执行代次：${command.execution}`, `后台 id：${command.id}`, `输出：${command.outputPath}`,
      ...(current?.reason ? [current.reason] : []), ...(finish ? [`结果：${finish.stopped ? '已停止' : finish.ok ? '正常结束' : '异常退出'} · exit ${finish.exit ?? '未知'}`, ...(finish.reason ? [finish.reason] : [])] : [])].map(sanitizeForDisplay),
    hint: '↑↓ 选择 · Enter 执行 · PgUp/PgDn 阅读详情 · Esc 返回' }
}
