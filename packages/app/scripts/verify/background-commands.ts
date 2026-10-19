/** 核对后台命令列表、详情、结束、停止与草稿保留。 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiSession } from '../../test/ui/driver.ts'

// 可复跑的真 PTY 检查；成功后清理截图、原始帧和沙地，失败保留具体诊断。
const artifacts = mkdtempSync(join(tmpdir(), 'magic-u124-pty-'))
const finish = join(artifacts, 'finish')
const copied = join(artifacts, 'clipboard')
writeFileSync(join(artifacts, 'pbcopy'), '#!/bin/sh\ncat > "$U124_COPY_FILE"\n', { mode: 0o755 })
const ui = await createUiSession({ columns: 200, rows: 40, label: 'background-commands-', artifacts, env: { PATH: `${artifacts}:${process.env.PATH}`, U124_COPY_FILE: copied }, argv: ['--allow-all'], turns: [
  { kind: 'tool', name: 'exec', args: { cmd: `while [ ! -f '${finish}' ]; do sleep 0.02; done; printf 后台测试完成`, background: true }, following: [
    { name: 'exec', args: { cmd: 'sleep 90 # 中文常驻服务', background: true } },
  ] },
  { kind: 'tool', name: 'background_wait', args: { ids: ['bg-1'] } },
  { kind: 'text', text: 'U124_RESULT_RECEIVED', chunks: 1, chunkDelayMs: 0 },
  { kind: 'text', text: 'U124_USER_STOP_UNDERSTOOD', chunks: 1, chunkDelayMs: 0 },
] })
let passed = false
const capture = async (label: string) => {
  const frame = await ui.capture({ label })
  assert.equal(frame.rows, 40)
  const screen = await ui.screen()
  const contentAt = screen.lines.findLastIndex(line => line.text.includes('个后台命令运行中'))
  assert.equal(screen.lines.slice(Math.max(0, contentAt)).some(line => line.wrapped), false, `${label} 当前交互区不应自动折行`)
  console.log(frame.text)
}
try {
  await ui.send('后台测试与持续服务'); await ui.key('enter')
  await ui.wait({ text: '等待后台结果' })
  await ui.wait({ text: '2 个后台命令运行中' })
  await capture('200-等待后台结果')
  await ui.send('/ps'); await ui.key('enter'); await ui.wait({ text: '[协作成员]' })
  await ui.key('tab'); await ui.wait({ text: '[后台命令]' })
  await capture('200-命令列表')
  await ui.key('enter'); await ui.wait({ text: '后台命令 bg-1' })
  await ui.key('enter'); await ui.wait({ text: '已复制完整输出路径' })
  assert(readFileSync(copied, 'utf8').endsWith('/bg-1.log'))
  await capture('200-命令详情')
  await ui.resize(100, 40); await ui.wait({ writtenFrame: 100 })
  await capture('100-命令详情')
  writeFileSync(finish, '')
  await ui.wait({ text: 'bg-1 已结束' })
  await capture('100-自然结束保持详情')
  assert.equal(ui.requests().filter(one => one.path.endsWith('/chat/completions')).length, 3)
  await ui.key('esc'); await ui.wait({ text: '[后台命令]' })
  await ui.key('enter'); await ui.wait({ text: '后台命令 bg-2' })
  await ui.key('down'); await ui.key('enter'); await ui.wait({ text: '后台命令 bg-2 · 已停掉 bg-2' })
  await capture('100-明确单项停止')
  await ui.key('esc'); await ui.wait({ text: '没有后台命令' })
  await ui.key('esc'); await ui.wait({ absent: '没有后台命令' }); await ui.wait({ text: '○ 空闲' })
  await ui.send('保留中文草稿🙂'); await ui.wait({ text: '保留中文草稿🙂' }); await ui.key('left')
  await ui.key('tab'); await ui.wait({ text: '[协作成员]' })
  await ui.key('tab'); await ui.wait({ text: '[后台命令]' })
  await ui.send('\x1b[Z'); await ui.wait({ text: '[协作成员]' })
  await ui.key('esc'); await ui.wait({ text: '保留中文草稿🙂' })
  await capture('100-双tab返回草稿')
  passed = true
} finally {
  await ui.close()
  if (passed) rmSync(artifacts, { recursive: true, force: true })
  else console.error(`PTY 诊断：${artifacts}`)
}
