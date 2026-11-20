import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from '../src/diagnostic-log.ts'

async function readLines(log: DiagnosticLog, dataDir: string): Promise<Record<string, unknown>[]> {
  await log.flush()
  await log.close()
  const name = (await readdir(join(dataDir, 'logs'))).find(file => file.endsWith('.jsonl'))
  if (name === undefined) throw new Error('没有写出日志文件')
  const text = await readFile(join(dataDir, 'logs', name), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

test('连接诊断字段真的落盘——不只是类型里有', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magic-diag-'))
  try {
    const log = new DiagnosticLog('manager', dir, 'info')
    log.write('error', 'link.terminated', { conn: 7, bytes: 13_175_290, by: 'peer', reason: 'send-backlog' })
    log.write('warn', 'link.closed.silent', { by: 'local' })
    const [terminated, silent] = await readLines(log, dir)

    expect(terminated).toMatchObject({
      event: 'link.terminated', level: 'error', conn: 7, bytes: 13_175_290, by: 'peer', reason: 'send-backlog',
    })
    expect(silent).toMatchObject({ event: 'link.closed.silent', by: 'local' })
    expect('reason' in silent!).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reason 只收代码内短句——超长与控制字符不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magic-diag-'))
  try {
    const log = new DiagnosticLog('manager', dir, 'info')
    log.write('warn', 'long.reason', { reason: 'x'.repeat(121) })
    log.write('warn', 'control.reason', { reason: 'line\nbreak' })
    log.write('warn', 'short.reason', { reason: '发送积压' })
    const [long, control, short] = await readLines(log, dir)

    expect('reason' in long!).toBe(false)
    expect('reason' in control!).toBe(false)
    expect(short).toMatchObject({ event: 'short.reason', reason: '发送积压' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
