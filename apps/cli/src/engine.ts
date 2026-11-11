#!/usr/bin/env bun
import { homedir } from 'node:os'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION, type ServiceIdentity } from '@magic/contracts'
import { controlService, type ServiceAction } from './run/engine-service.ts'

/** Engine 是独立产物；CLI 和 App 仅调用此管理入口。 */
export async function engineMain(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--version') {
    console.log(argv.includes('--json') ? JSON.stringify({ component: 'engine', version: SOFTWARE_VERSION, protocol: NATIVE_PROTOCOL }) : `magic-engine ${SOFTWARE_VERSION}`)
    return 0
  }
  if (argv[0] === 'install') {
    const { installComponents } = await import('./component-install.ts')
    const fields: Record<string, string> = {}, flags = new Set<string>()
    for (let i = 1; i < argv.length; i++) {
      const key = argv[i]!
      if (['--upgrade-engine', '--upgrade-cli'].includes(key)) { flags.add(key); continue }
      if (!['--home', '--payload', '--profile', '--bin', '--legacy-parent'].includes(key) || !argv[i + 1] || fields[key]) throw new Error(`安装参数无效：${key}`)
      fields[key] = argv[++i]!
    }
    const profile = fields['--profile'] ?? 'engine'
    if (!['engine', 'terminal', 'app'].includes(profile) || !fields['--payload']) throw new Error('安装须指定 --payload <目录> 与 --profile engine|terminal|app')
    const result = await installComponents({ home: fields['--home'] ?? homedir(), payload: fields['--payload'], profile: profile as 'engine' | 'terminal' | 'app',
      bin: fields['--bin'], legacyParent: fields['--legacy-parent'], upgradeEngine: flags.has('--upgrade-engine'), upgradeCLI: flags.has('--upgrade-cli') })
    console.log(JSON.stringify(result)); return 0
  }
  if (argv[0] === 'uninstall') {
    const fields: Record<string, string> = {}
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i]!, value = argv[i + 1]
      if (!['--home', '--component'].includes(key) || !value || fields[key]) throw new Error(`卸载参数无效：${key}`)
      fields[key] = value
    }
    const component = fields['--component']
    if (component !== 'engine' && component !== 'cli') throw new Error('卸载须明确指定 --component engine|cli')
    const { uninstallComponent } = await import('./component-install.ts')
    await uninstallComponent(fields['--home'] ?? homedir(), component)
    console.log(JSON.stringify({ removed: component, dataPreserved: true })); return 0
  }
  if (argv[0] === 'serve') {
    const { runEngine } = await import('./run/host-runtime.ts')
    try { return await runEngine(argv.slice(1)) }
    catch (error) { console.error(`Engine 启动失败：${String(error)}`); return 0 }
  }
  if (argv[0] !== 'service' || !['status', 'start', 'stop', 'switch', 'remove'].includes(argv[1] ?? '')) {
    console.error('用法：magic-engine install --payload <目录> --profile engine|terminal|app | uninstall --component engine|cli | serve … | service status|start|stop|switch|remove [--home <路径>] [--parent <路径>]')
    return 1
  }
  const fields: Record<string, string> = {}
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1]
    if (!['--home', '--parent', '--base', '--request', '--expected'].includes(key) || !value || fields[key] !== undefined) throw new Error(`Engine 参数无效：${key}`)
    fields[key] = value
  }
  const result = await controlService(argv[1] as ServiceAction, {
    home: fields['--home'] ?? homedir(), parent: fields['--parent'], base: fields['--base'], request: fields['--request'],
    expected: fields['--expected'] === undefined ? undefined : JSON.parse(fields['--expected']) as ServiceIdentity,
  })
  console.log(JSON.stringify(result))
  return result.state === 'failed' || result.state === 'unreachable' ? 1 : 0
}
if (import.meta.main) {
  process.on('SIGPIPE', () => {})
  try { process.exit(await engineMain(process.argv.slice(2))) }
  catch (error) { console.log(JSON.stringify({ state: 'failed', error: error instanceof Error ? error.message : String(error) })); process.exit(1) }
}
