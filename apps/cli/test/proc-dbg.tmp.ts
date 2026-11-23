import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPathsOf, startManager, createProcessLauncher, connectManager } from '@magic/host'
import { createRecordsStore } from '@magic/data'
import { startFixture } from './ui/fixture.ts'

const root = mkdtempSync(join(tmpdir(), 'magic-proc-dbg9-'))
const home = join(root, 'home'), base = join(root, 'base'), ws = join(root, 'ws')
for (const d of [home, base, ws]) mkdirSync(d, { recursive: true })
const fixture = startFixture({ turns: [{ kind: 'text', text: '完成', chunks: 1, chunkDelayMs: 0 }] })
writeFileSync(join(base, 'config.json'), JSON.stringify({
  dataDir: base,
  models: { default: { provider: 'x', model: 'm' } },
  providers: { x: { protocol: 'chat-completions', auth: 'bearer', baseURL: fixture.baseURL, apiKey: 'sk-test', modelOverrides: { m: { capabilities: { tools: true } } } } },
}))
const magic = { home, base }
const store = createRecordsStore({ dataDir: base, workspace: [realpathSync(ws)] })
const paths = runPathsOf(magic, tmpdir())
const logs: string[] = []
const origKill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => {
  if (signal !== 0 && signal !== undefined) console.error(`[kill-trace] kill(${pid}, ${String(signal)}) from ${new Error('t').stack?.split('\n').slice(1, 4).join(' <- ')}`)
  return origKill(pid, signal)
}) as typeof process.kill
const result = await startManager({ paths, magic, probeIntervalMs: 100, launch: createProcessLauncher({ socket: paths.socket, log: line => logs.push(line) }) })
const manager = (result as any).manager
const client = await connectManager(paths.socket, { cwd: ws, environment: { ...process.env, HOME: home, MAGIC_HOME: base } })
const events: string[] = []
client!.onEvent((e: any) => events.push(`${e.kind}${e.kind === 'background.state' ? ':' + JSON.stringify(e.data).slice(0, 200) : ''}`))
console.log('submit @', Date.now() % 100000)
client!.send({ type: 'input.submit', text: '你好' })
await Bun.sleep(8000)
console.log('fixture requests:', fixture.requests().length)
console.log('events:', events.join(' , '))
console.log('SIGTERM 次数:', logs.filter(l => l.includes('SIGTERM')).length)
client!.close(); manager.stop('dbg'); await Bun.sleep(1200)
store.close(); fixture.stop(); rmSync(root, { recursive: true, force: true }); process.exit(0)
