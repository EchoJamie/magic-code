/**
 * 新库首启引导——旧库只备份移走，不读取、不迁移、不回填。
 *
 * 0.2.0 的记录库不保证与 0.1.0 兼容。启动前发现 `records.db` 不是 schema 2：
 * 1. 整个数据目录复制到 `<base>/backup/0.1.0-<时间>/`（base＝数据目录的上级）；
 * 2. 校验备份可读、文件数一致；
 * 3. 移走旧 `records.db` / `blobs/` / `runs.json`，保留 `config.json`；
 * 4. 任一步失败即拒绝启动——不静默重建，也不在旧库上写。
 *
 * 备份目录与运行目录分开；旧数据不作为迁移输入。
 */
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DATABASE = 'records.db'
const BLOBS = 'blobs'
const RUNS = 'runs.json'
const LOCK = '.records.lock'

const BACKUP_DIR = 'backup'

/** 读 schema 版本；库不存在或读不出都返回 undefined。 */
export function schemaVersionOf(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const db = new Database(path, { readonly: true })
    try {
      const row = db.query<{ value: string }, []>(
        "SELECT value FROM records_meta WHERE key='schema_version'",
      ).get()
      return row?.value
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** 旧数据存在时备份并移走；新库 / 空目录无事。 */
export function prepareDataDir(dataDir: string, now = Date.now()): void {
  const databasePath = join(dataDir, DATABASE)
  if (!existsSync(databasePath)) return
  if (schemaVersionOf(databasePath) === '3') return

  const backup = backupDirOf(dataDir, now)
  mkdirSync(backup, { recursive: true })

  const saved: string[] = []
  const copyFile = (name: string): void => {
    const from = join(dataDir, name)
    if (!existsSync(from)) return
    const to = join(backup, name)
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
    else copyFileSync(from, to)
    saved.push(name)
  }

  copyFile(DATABASE)
  copyFile(`${DATABASE}-wal`)
  copyFile(`${DATABASE}-shm`)
  copyFile(BLOBS)

  // `runs.json` 在当前版本里位于 `run/<instance>/runs.json`；旧顶层位置一并认。
  copyFile(RUNS)
  const runDir = join(dataDir, 'run')
  if (existsSync(runDir)) {
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relative = join('run', entry.name, RUNS)
      const from = join(dataDir, relative)
      if (!existsSync(from)) continue
      mkdirSync(join(backup, 'run', entry.name), { recursive: true })
      copyFileSync(from, join(backup, relative))
      saved.push(relative)
    }
  }

  // 备份可读 + schema 仍可判（旧库可能是坏版本，此处只要求文件存在且非空）。
  const copied = join(backup, DATABASE)
  if (!existsSync(copied) || statSync(copied).size === 0) {
    throw new Error(`旧记录库备份失败，未移走原库：${backup}`)
  }
  for (const name of saved) {
    if (!existsSync(join(backup, name))) throw new Error(`旧数据备份不完整：${name}`)
  }

  // 移走旧事实；`config.json` 是用户配置，保留。
  for (const name of saved) {
    const target = join(dataDir, name)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`旧数据已备份但移走失败：${name}（${String(error)}）`)
    }
  }
  writeFileSync(join(backup, 'MANIFEST'), `${new Date(now).toISOString()}\n${saved.join('\n')}\n`)
}

/**
 * 数据目录独占锁——同一实例不允许两个进程同时开库。
 * 锁里写 PID 与主机名；同一主机上 PID 已不存在视为陈旧锁。
 */
const processLocks = new Map<string, { count: number; release: () => void }>()

export function acquireDataLock(dataDir: string): () => void {
  const path = join(dataDir, LOCK)
  const existing = processLocks.get(path)
  if (existing !== undefined) {
    existing.count += 1
    return () => {
      existing.count -= 1
      if (existing.count === 0) {
        processLocks.delete(path)
        existing.release()
      }
    }
  }

  const body = `${process.pid} ${hostname()}\n`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: 'wx' })
      const release = (): void => {
        try {
          const current = readFileSync(path, 'utf8')
          if (current.startsWith(`${process.pid} `)) unlinkSync(path)
        } catch {
          // 已不在——不把清理失败变成关库失败
        }
      }
      processLocks.set(path, { count: 1, release })
      return () => {
        const held = processLocks.get(path)
        if (held === undefined) return
        held.count -= 1
        if (held.count === 0) {
          processLocks.delete(path)
          held.release()
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 1) throw new Error(`记录库已被另一个进程占用：${path}`)
      const [pid] = readFileSync(path, 'utf8').split(' ')
      if (pid !== undefined && pid !== '' && Number.isFinite(Number(pid))) {
        try {
          process.kill(Number(pid), 0)
          throw new Error(`记录库已被进程 ${pid} 占用：${path}`)
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
        }
      }
      rmSync(path, { force: true })
    }
  }
  throw new Error(`无法取得记录库锁：${path}`)
}

/**
 * 备份目录——与运行目录分开，且每个数据目录一份（不落到共享父目录里）。
 * `.magic` → `.magic-backup/0.1.0-<时间>/`。
 */
function backupDirOf(dataDir: string, now: number): string {
  const trimmed = dataDir.length > 1 ? dataDir.replace(/\/+$/, '') : dataDir
  return join(dirname(trimmed), `${basename(trimmed)}-${BACKUP_DIR}`, `0.1.0-${stampOf(now)}`)
}
