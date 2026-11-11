import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

function logFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return `日志写入失败${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `（${code}）` : ''}，请检查目录权限与磁盘空间`
}
import { LOG_LEVELS, isLogLevel, type LogLevel } from '@magic/contracts'

/** Only structural identifiers enter files. Text, errors, config and wire payloads do not. */
export type LogFields = Partial<Record<'hostInstance' | 'serviceInstance' | 'session' | 'run' | 'request', string>> & { count?: number; debugMode?: boolean; previousDebugMode?: boolean; logLevel?: LogLevel; previousLogLevel?: LogLevel; settingSource?: 'app' | 'cli' | 'config' }
export class DiagnosticLog {
  readonly directory: string
  private level: LogLevel
  private queue: string[] = []
  private pumping: Promise<void> | undefined
  private file: FileHandle | undefined
  private path = ''
  private size = 0
  private part = 0
  private dropped = 0
  private closed = false
  private readonly start = `${Date.now()}-${crypto.randomUUID()}`
  problem: string | undefined
  constructor(readonly component: 'manager' | 'executor', dataDir: string, level: LogLevel, private readonly limits = { file: 10 * 1024 * 1024, total: 100 * 1024 * 1024, queue: 1024 }) {
    this.directory = join(dataDir, 'logs'); this.level = level
    this.startPump()
  }
  setLevel(level: LogLevel): void { this.level = level }
  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (this.closed || LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(this.level)) return
    if (this.queue.length >= this.limits.queue) {
      this.dropped++
      const low = level === 'error' || level === 'warn' ? this.queue.findIndex(line => /"level":"(info|debug|trace)"/.test(line)) : -1
      if (low < 0) return
      this.queue.splice(low, 1)
    }
    // Event names are code-owned tokens, never prose supplied by a provider/tool/user.
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(event)) return
    const safe: Record<string, unknown> = {}
    for (const key of ['hostInstance', 'serviceInstance', 'session', 'run', 'request'] as const) {
      const value = fields[key]
      if (value !== undefined && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) safe[key] = value
    }
    if (Number.isSafeInteger(fields.count)) safe.count = fields.count
    for (const key of ['debugMode', 'previousDebugMode'] as const) if (typeof fields[key] === 'boolean') safe[key] = fields[key]
    for (const key of ['logLevel', 'previousLogLevel'] as const) if (isLogLevel(fields[key])) safe[key] = fields[key]
    if (fields.settingSource && ['app', 'cli', 'config'].includes(fields.settingSource)) safe.settingSource = fields.settingSource
    this.queue.push(JSON.stringify({ time: Date.now(), level, component: this.component, event, message: ({ 'manager.started': '管理者已启动', 'manager.stopped': '管理者已停止', 'executor.started': '执行者已启动', 'executor.stopped': '执行者已停止', 'executor.failed': '执行者启动失败', 'diagnostics.applied': '诊断设置已采用', 'settings.ack': '收到执行者设置回执', 'native.settings.apply': '收到设置修改', 'native.settings.result': '设置处理完成' } as Record<string, string>)[event] ?? event, pid: process.pid, ...safe }) + '\n')
    this.startPump()
  }
  private startPump(): void {
    this.pumping ??= this.pump().finally(() => { this.pumping = undefined; if (this.queue.length) this.startPump() })
  }
  private async rotate(): Promise<void> {
    if (this.file) { await this.file.close(); this.file = undefined; await rename(this.path, this.path.replace('.active.jsonl', '.jsonl')) }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error('日志目录不可用')
    await chmod(this.directory, 0o700)
    this.path = join(this.directory, `${this.component}-${process.pid}-${this.start}-${this.part++}.active.jsonl`)
    this.file = await open(this.path, 'wx', 0o600); this.size = 0
    await this.prune()
  }
  private async prune(): Promise<void> {
    const files = await Promise.all((await readdir(this.directory)).filter(name => /^(app|manager|executor)-.*\.jsonl$/.test(name)).map(async name => {
      const path = join(this.directory, name)
      try {
        const info = await stat(path)
        // A crashed writer has no open file; preserve active or reused PIDs conservatively.
        if (name.endsWith('.active.jsonl')) {
          const pid = Number(name.split('-')[1])
          try { process.kill(pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              const closed = path.replace('.active.jsonl', '.jsonl')
              await rename(path, closed)
              return { path: closed, name: name.replace('.active.jsonl', '.jsonl'), size: info.size, time: info.mtimeMs }
            }
          }
        }
        return { path, name, size: info.size, time: info.mtimeMs }
      } catch { return undefined }
    }))
    const present = files.filter(f => f !== undefined)
    let total = present.reduce((sum, f) => sum + f.size, 0)
    for (const file of present.filter(f => !f.name.endsWith('.active.jsonl')).sort((a, b) => a.time - b.time)) {
      if (total <= this.limits.total - this.limits.file) break
      try { await unlink(file.path); total -= file.size } catch { /* another writer may have pruned it */ }
    }
  }
  private async pump(): Promise<void> {
    try {
      if (!this.file) await this.rotate()
      while (this.queue.length) {
        const line = this.queue.shift()!
        const bytes = Buffer.byteLength(line)
        if (!this.file || this.size + bytes > this.limits.file) await this.rotate()
        await this.file!.write(line); this.size += bytes; this.problem = undefined
        if (this.dropped && LOG_LEVELS.indexOf(this.level) >= LOG_LEVELS.indexOf('warn')) {
          const count = this.dropped; this.dropped = 0
          this.queue.push(JSON.stringify({ time: Date.now(), level: 'warn', component: this.component, event: 'log.dropped', message: 'log.dropped', pid: process.pid, count }) + '\n')
        }
      }
    } catch (error) { this.problem = logFailure(error); this.queue.length = 0 }
  }
  async flush(): Promise<void> { while (this.pumping) await this.pumping }
  async close(): Promise<void> {
    this.closed = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const drain = this.finish()
    await Promise.race([drain, new Promise<void>(resolve => { timer = setTimeout(() => { this.problem = '日志排空超时'; resolve() }, 2_000) })])
    if (timer) clearTimeout(timer)
  }
  private async finish(): Promise<void> {
    await this.flush()
    try { if (this.file) { await this.file.close(); this.file = undefined; await rename(this.path, this.path.replace('.active.jsonl', '.jsonl')); await this.prune() } } catch { this.problem = '日志关闭失败' }
  }
}
