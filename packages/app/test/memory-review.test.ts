import { expect, test } from 'bun:test'
import { bindSessionReferences } from '@magic/conversation'
import { attachShell } from '../src/index.ts'
import { makeStage, lastModel } from './support.ts'

for (const covered of [false, true]) test(`固定引用首次提供最近 8 条真实原文，新覆盖标记不充当历史摘要（覆盖=${covered}）`, async () => {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: '已读引用' }] })
  const shell = attachShell(app.shell)
  try {
    const records = app.records.serviceFor('source')
    const ids = Array.from({ length: 20 }, (_, index) => records.appendEntry({ kind: 'user', content: { text: `历史要求 ${index}。` }, at: index }))
    if (covered) records.coverage.publish({ previousSummary: null, from: ids[0]!, through: ids[18]!, notesSaved: true, at: 30 })
    const bound = await bindSessionReferences({ text: '@来源', refs: [{ kind: 'session', source: 'source', at: 0, marker: '@来源' }] }, records)
    await shell.submit(bound)
    const input = lastModel(stage).requests[0]!.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    expect(input).not.toContain('接续材料已保存于本会话工作笔记')
    expect(input).not.toContain('历史要求 0。')
    expect(input).not.toContain('历史要求 11。')
    expect(input).toContain('历史要求 12。')
    expect(input).toContain('历史要求 19。')
    expect(input.match(/· user · user/g)).toHaveLength(8)
    expect(input).toContain(`未带入的未覆盖记录范围：#1 至 #${ids[12]! - 1}`)
    expect(input).toContain('source_read 指定 session=source、entry=记录编号')
  } finally { shell.dispose(); app.close(); stage.dispose() }
})
