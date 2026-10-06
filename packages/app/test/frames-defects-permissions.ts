/** 第 1/2 项用户路径：真 CLI/PTY、本地模型、隔离 HOME 与根外文件。 */
import { strict as assert } from 'node:assert'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'

const columns = Number(process.argv[2] ?? 100)
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'magic-permission-pty-')))
const target = join(outside, 'approved.txt'), sibling = join(outside, 'neighbor.txt')
const original = `READ_UNIQUE_${randomUUID()}\n`
const neighbor = `DENIED_SECRET_${randomUUID()}\n`
const tail = `WRITE_TAIL_${randomUUID()}`
const content = ['WRITE_BEGIN：完整待写入正文', '', ...Array.from({ length: 72 }, (_, i) =>
  `  第 ${String(i + 1).padStart(3, '0')} 行：保留原有空白与逐行内容，批准后逐字核对。`), '', tail, ''].join('\n')
writeFileSync(target, original); writeFileSync(sibling, neighbor)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let ui: Awaited<ReturnType<typeof createUiSession>> | undefined
let failure: unknown
const evidence: Record<string, unknown> = { columns, rows: 40, target, sibling, originalSha256: hash(original), expectedSha256: hash(content) }

try {
  ui = await createUiSession({
    columns, rows: 40, label: `20261007-permissions-${columns}`,
    artifacts: join(REPO_ROOT, '.ui-runs/defects-20261007'),
    turns: [
      { kind: 'tool', name: 'read', args: { path: target } },
      { kind: 'text', text: 'READ_APPROVED_FINISHED', chunks: 1 },
      { kind: 'tool', name: 'read', args: { path: sibling } },
      { kind: 'text', text: 'READ_DENIED_FINISHED', chunks: 1 },
      { kind: 'tool', name: 'write', args: { path: target, content } },
      { kind: 'text', text: 'WRITE_FINISHED', chunks: 1 },
    ],
  })
  const session = ui
  writeFileSync(join(ui.runDir, 'expected-write.txt'), content)
  writeFileSync(join(ui.runDir, 'before-write.txt'), original)
  const requests = () => session.requests().filter(one => one.path.endsWith('/chat/completions'))
  const toolReplies = (index: number) => {
    const messages = requests()[index]?.body['messages'] as { role: string; content: unknown }[] | undefined
    assert(messages, `缺少第 ${index + 1} 次模型请求`)
    return messages.filter(one => one.role === 'tool')
  }
  async function ask(text: string, tool: string, file: string) {
    await session.send(text); await session.key('enter')
    await session.wait({ text: `${tool} · 待决策` }, { timeoutMs: 15000 })
    await session.wait({ text: '↑↓ 选择' })
    const frame = await session.capture({ label: `${tool}-${file}-unselected` })
    const material = frame.lines.filter(line => line.startsWith(' │ ')).map(line => line.slice(3)).join('')
    assert(material.includes(file), '审批材料应保留折行后的完整文件名')
    assert(frame.text.includes('○ 批准这一次'))
    assert(frame.text.includes('○ 拒绝这一次'))
    assert(!frame.text.includes('总是允许'))
    return frame
  }

  const readCard = await ask('读取指定的工作区外单文件。', 'read', 'approved.txt')
  assert(readCard.text.includes('只读该文件'))
  assert(readCard.text.includes('根外'))
  assert.equal(requests().length, 1)
  await ui.key('down', { until: { text: '› 批准这一次' } })
  await ui.wait({ absent: '○ 批准这一次' })
  const readSelected = await ui.capture({ label: 'read-explicit-approve-selected' })
  assert(readSelected.text.includes('│ › 批准这一次'))
  await ui.key('enter'); await ui.wait({ text: 'READ_APPROVED_FINISHED' }); await ui.wait({ text: '○ 空闲' })
  assert.equal(requests().length, 2)
  assert(JSON.stringify(toolReplies(1)).includes(original.trim()))
  await ui.key('ctrl+o'); await ui.wait({ text: 'PgUp/PgDn 翻页' }); await ui.wait({ text: original.trim() })
  await ui.capture({ label: 'read-real-unique-marker-in-tool-result' })
  await ui.key('esc'); await ui.wait({ absent: 'PgUp/PgDn 翻页' }); await ui.wait({ text: '○ 空闲' })
  evidence['readApproved'] = { marker: original.trim(), modelToolReplies: toolReplies(1), fileUnchanged: readFileSync(target, 'utf8') === original }

  await ask('再读取相邻的另一个文件。', 'read', 'neighbor.txt')
  assert.equal(requests().length, 3)
  assert(!JSON.stringify(requests()).includes(neighbor.trim()))
  await ui.key('up', { until: { text: '› 拒绝这一次' } })
  await ui.wait({ absent: '○ 拒绝这一次' })
  const rejectSelected = await ui.capture({ label: 'neighbor-explicit-reject-selected' })
  assert(rejectSelected.text.includes('│ › 拒绝这一次'))
  await ui.key('enter'); await ui.wait({ text: 'READ_DENIED_FINISHED' }); await ui.wait({ text: '○ 空闲' })
  assert.equal(requests().length, 4)
  const refused = JSON.stringify(toolReplies(3).at(-1))
  assert(refused.includes('已拒绝') && refused.includes('未执行'))
  assert(!JSON.stringify(requests()).includes(neighbor.trim()))
  assert.equal(readFileSync(sibling, 'utf8'), neighbor)
  await ui.key('ctrl+o'); await ui.wait({ text: 'PgUp/PgDn 翻页' }); await ui.wait({ text: '未执行' })
  await ui.capture({ label: 'neighbor-refused-not-executed' })
  await ui.key('esc'); await ui.wait({ absent: 'PgUp/PgDn 翻页' }); await ui.wait({ text: '○ 空闲' })
  evidence['neighborRejected'] = { modelToolReply: toolReplies(3).at(-1), uniqueMarkerAbsentFromAllRequests: true, fileUnchanged: true }

  let page = await ask('用已指定的长正文覆盖第一个文件，等待我的明确批准。', 'write', 'approved.txt')
  assert.equal(requests().length, 5)
  assert.equal(readFileSync(target, 'utf8'), original)
  assert(!page.text.includes(tail), '尾标记必须位于初始视口之外')
  const pages = [page.text]
  // 逐页等材料水位变化；不连发按键，也不靠固定延时猜渲染已结束。
  for (let index = 1; !page.text.includes(tail) && index <= 30; index += 1) {
    const waterline = page.text.match(/材料 \d+–\d+\/\d+/)?.[0]
    assert(waterline, '长材料必须提供分页水位')
    await ui.key('pageDown', { until: { absent: waterline } })
    page = await ui.capture({ label: `write-material-page-${index + 1}` })
    assert(page.text.includes('write · 待决策'))
    assert(page.text.includes('○ 批准这一次'))
    assert.equal(readFileSync(target, 'utf8'), original)
    pages.push(page.text)
  }
  assert(page.text.includes(tail), '审批卡内必须翻到完整正文尾部')
  for (const line of content.split('\n').filter(line => line.trim())) {
    assert(pages.some(text => text.includes(line.trim())), `审批分页遗漏正文：${line}`)
  }
  assert.equal(requests().length, 5)
  writeFileSync(join(ui.runDir, 'approval-pages.txt'), pages.join('\n\n--- 下一帧 ---\n\n'))
  writeFileSync(join(ui.runDir, 'before-approve.txt'), readFileSync(target))
  await ui.key('down', { until: { text: '› 批准这一次' } })
  await ui.wait({ absent: '○ 批准这一次' })
  const writeSelected = await ui.capture({ label: 'write-tail-visible-explicit-approve-selected' })
  assert(writeSelected.text.includes('│ › 批准这一次'))
  assert(writeSelected.text.includes(tail))
  assert.equal(readFileSync(target, 'utf8'), original)
  await ui.key('enter'); await ui.wait({ text: 'WRITE_FINISHED' }); await ui.wait({ text: '○ 空闲' })
  assert.equal(requests().length, 6)
  const actual = readFileSync(target, 'utf8')
  assert.equal(actual, content)
  assert.equal(readFileSync(sibling, 'utf8'), neighbor)
  writeFileSync(join(ui.runDir, 'actual-write.txt'), actual)
  await ui.capture({ label: 'write-finished-exact-fs-content' })
  evidence['writeApproved'] = { pages: pages.length, fullNonemptyLinesVisible: true, tail, unchangedBeforeEveryPageAndApproval: true, exactContentAfterApproval: true, actualSha256: hash(actual), modelToolReply: toolReplies(5).at(-1) }
  evidence['requests'] = requests()
  evidence['facts'] = ui.facts()
  await ui.quit()
} catch (error) {
  failure = error
  evidence['error'] = error instanceof Error ? error.stack : String(error)
} finally {
  if (ui !== undefined) {
    evidence['close'] = await ui.close()
    const raw = readFileSync(join(ui.runDir, 'raw.bin'))
    const output = readFileSync(join(ui.runDir, 'output.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { at: number; offset: number; length: number })
    writeFileSync(join(ui.runDir, 'permissions.cast'), [JSON.stringify({ version: 2, width: columns, height: 40, title: 'Permission user paths; original PTY timestamps' }),
      ...output.map(one => JSON.stringify([one.at / 1000, 'o', raw.subarray(one.offset, one.offset + one.length).toString('utf8')]))].join('\n') + '\n')
    writeFileSync(join(ui.runDir, 'permission-facts.json'), JSON.stringify(evidence, null, 2))
    console.log(ui.runDir)
  }
  rmSync(outside, { recursive: true, force: true })
}
if (failure !== undefined) throw failure
