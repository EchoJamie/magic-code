import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION, type HostDiscovery } from '@magic/contracts'
import { acquireFileLock } from '@magic/config'
import { componentDirectory, componentSource, privateDirectory, readComponents, readJSON, writePrivateJSON, type Components } from './components.ts'
import { acquireServiceLock, controlService } from './run/engine-service.ts'
import { normalizeDataDir } from './run/paths.ts'
import { softwareSource } from './run/runtime-launch.ts'

export type ComponentKind = 'engine' | 'cli'
export type ComponentIdentity = { component: ComponentKind; version: string; protocol: number; team: string }
export type ComponentInspector = (path: string, kind: ComponentKind) => Promise<ComponentIdentity>
export type InstallOptions = {
  home: string; payload: string; profile: 'engine' | 'terminal' | 'app'; bin?: string
  upgradeEngine?: boolean; upgradeCLI?: boolean; legacyParent?: string
}
type InstallResult = { profile: InstallOptions['profile']; components: Components; reused: ComponentKind[]; installed: ComponentKind[]; command?: string }

async function execute(args: string[]): Promise<{ code: number; out: string; error: string }> {
  const child = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, out, error }
}
async function signingTeam(path: string): Promise<string> {
  if ((await execute(['/usr/bin/codesign', '--verify', '--strict', path])).code !== 0) throw new Error('组件签名无效，未安装')
  const signed = await execute(['/usr/bin/codesign', '--display', '--verbose=4', path])
  const team = signed.error.match(/^TeamIdentifier=(.+)$/m)?.[1]
  if (signed.code !== 0 || !team || team === 'not set') throw new Error('组件缺少可核实的开发者签名，未安装')
  return team
}
export const inspectComponent: ComponentInspector = async (path, kind) => {
  const file = lstatSync(path)
  if (!file.isFile()) throw new Error(`组件不是普通文件：${path}`)
  const team = await signingTeam(path)
  const result = await execute([path, '--version', '--json'])
  let value: Partial<ComponentIdentity>
  try { value = JSON.parse(result.out) } catch { throw new Error(`无法识别 ${kind} 组件，请检查安装来源`) }
  if (result.code !== 0 || value.component !== kind || typeof value.version !== 'string' || typeof value.protocol !== 'number') throw new Error(`组件身份无效：${kind}`)
  return { component: kind, version: value.version, protocol: value.protocol, team }
}
const compatible = (identity: ComponentIdentity) => identity.version === SOFTWARE_VERSION && identity.protocol === NATIVE_PROTOCOL

/** 只移除明确指定、已登记且签名相同的组件；选择、配置与记录始终保留。 */
export async function uninstallComponent(homePath: string, kind: ComponentKind, inspect: ComponentInspector = inspectComponent): Promise<void> {
  if (!isAbsolute(homePath)) throw new Error('卸载路径必须为绝对路径')
  const home = normalizeDataDir(homePath), directory = componentDirectory(home), manifest = join(directory, 'components.json')
  const lock = await acquireFileLock(manifest)
  try {
    const registered = readComponents(home), path = registered?.[kind]
    if (!registered || !path) return
    if (existsSync(path)) {
      const identity = await inspect(path, kind), owner = await inspect(softwareSource(), 'engine')
      if (identity.team !== owner.team) throw new Error('组件签名来源不同，未移除')
    }
    if (kind === 'cli' && registered.command) checkCommand(registered.command, path)
    if (kind === 'engine' && existsSync(path)) {
      const result = await execute([path, 'service', 'remove', '--home', home])
      let stopped: { state?: string; error?: string }
      try { stopped = JSON.parse(result.out) } catch { throw new Error('Engine 无法确认安全停止，未卸载') }
      if (result.code !== 0 || stopped.state !== 'stopped') throw new Error(stopped.error ?? 'Engine 收尾未完成，未卸载')
    }
    const release = await acquireServiceLock(home)
    try {
      if (kind === 'engine') {
        const current = readJSON(join(directory, 'runtime/host.json'))
        if (current && (!['stopped', 'failed'].includes(String(current.state)) || current.pid !== undefined)) throw new Error('Engine 停止尚未确认或已重新启动，未卸载')
      }
      if (kind === 'cli' && registered.command) {
        checkCommand(registered.command, path)
        rmSync(registered.command, { force: true })
      }
      rmSync(path, { force: true })
      if (kind === 'cli') {
        writePrivateJSON(manifest, { engine: registered.engine })
      }
      // Engine 的安装位置保留为缺失目标，客户端准确报告未安装，后续安装沿原位置修复。
    } finally { release() }
  } finally { lock.release() }
}

/** 组合安装只补齐缺项；替换已有组件须逐项明确授权，Engine 先停止并移除所属任务。 */
export async function installComponents(options: InstallOptions, inspect: ComponentInspector = inspectComponent): Promise<InstallResult> {
  if (![options.home, options.payload, ...(options.bin ? [options.bin] : []), ...(options.legacyParent ? [options.legacyParent] : [])].every(isAbsolute)) throw new Error('安装路径必须为绝对路径')
  const home = normalizeDataDir(options.home), directory = componentDirectory(home), manifest = join(directory, 'components.json')
  privateDirectory(directory)
  const lock = await acquireFileLock(manifest)
  try {
    const payloadEngine = componentSource(join(options.payload, 'magic-engine'))
    const payloadIdentity = await inspect(payloadEngine, 'engine')
    if (payloadIdentity.team !== (await inspect(softwareSource(), 'engine')).team) throw new Error('安装载荷不是当前 Engine 的签名来源')
    if (!compatible(payloadIdentity)) throw new Error('安装载荷的软件版本或协议不一致')
    const kinds: ComponentKind[] = options.profile === 'engine' ? ['engine'] : ['engine', 'cli']
    const payloads: Partial<Record<ComponentKind, string>> = { engine: payloadEngine }
    for (const kind of kinds) if (kind !== 'engine') {
      const path = componentSource(join(options.payload, `magic-${kind}`)), identity = await inspect(path, kind)
      if (!compatible(identity) || identity.team !== payloadIdentity.team) throw new Error(`${kind} 载荷的版本或签名来源不一致`)
      payloads[kind] = path
    }
    let registered = readComponents(home)
    const legacy = registered === undefined ? await legacyInstallation(home, payloadIdentity.team, options.legacyParent) : undefined
    const destinations: Partial<Record<ComponentKind, string>> = {}
    const replace: ComponentKind[] = [], reused: ComponentKind[] = []
    for (const kind of kinds) {
      const destination = registered?.[kind] ?? join(directory, 'components', `magic-${kind}`)
      destinations[kind] = destination
      const present = existsSync(destination) || (() => { try { lstatSync(destination); return true } catch { return false } })()
      if (present) {
        if (registered?.[kind] !== destination) throw new Error(`安装位置已有归属不明的文件，未覆盖：${destination}`)
        const identity = await inspect(destination, kind)
        if (identity.team !== payloadIdentity.team) throw new Error(`${kind} 的签名来源不同，未覆盖`)
        const upgrade = kind === 'engine' ? options.upgradeEngine : options.upgradeCLI
        if (!compatible(identity) && !upgrade) throw new Error(`${kind} 已安装 ${identity.version}（协议 ${identity.protocol}），本次需要 ${SOFTWARE_VERSION}（协议 ${NATIVE_PROTOCOL}）；请明确升级该组件`)
        if (upgrade) replace.push(kind); else reused.push(kind)
      } else replace.push(kind)
    }
    const command = options.profile === 'engine' ? registered?.command : join(options.bin ?? (registered?.command ? dirname(registered.command) : legacy?.bin ?? join(home, '.local/bin')), 'magic')
    if (command && options.profile !== 'engine') checkCommand(command, destinations.cli!, legacy?.source)

    if (legacy?.source && !options.upgradeEngine) throw new Error('旧 App 安装需要迁移 CLI 与 Engine 到独立位置；请明确升级组件（--upgrade-engine --upgrade-cli），原安装保持不变')
    // 旧 App 选择只在首次转换时读取；以后 engine.json 是唯一权威。
    if (legacy?.record) {
      const result = await controlService('remove', { home, expected: legacy.record }, undefined, { source: legacy.source!, parent: legacy.parent, label: legacy.label! })
      if (result.state !== 'stopped') throw new Error(result.error ?? '旧 Engine 收尾未完成，安装未替换其组件')
    }
    if (replace.includes('engine') && registered && existsSync(registered.engine)) {
      const removed = await execute([registered.engine, 'service', 'remove', '--home', home])
      let result: { state?: string; error?: string }
      try { result = JSON.parse(removed.out) } catch { throw new Error('已有 Engine 无法确认安全停止，未替换') }
      if (removed.code !== 0 || result.state !== 'stopped') throw new Error(result.error ?? '已有 Engine 收尾未完成，未替换')
    }
    const release = await acquireServiceLock(home)
    try {
      if (replace.includes('engine')) {
        // 停止返回后，另一个客户端可能抢先启动；在服务锁内再次确认，不能覆盖活动实例。
        const current = readJSON(join(directory, 'runtime/host.json'))
        if (current !== undefined && !['stopped', 'failed'].includes(String(current.state))) throw new Error('Engine 在安装前重新启动，请明确停止后重试')
        if (current !== undefined && current.pid !== undefined) throw new Error('Engine 退出身份尚未核销，未替换')
      }
      privateDirectory(join(directory, 'components'))
      for (const kind of kinds) {
        const destination = destinations[kind]!
        if (replace.includes(kind)) {
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
          const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
          try {
            copyFileSync(payloads[kind]!, temp); chmodSync(temp, 0o755)
            const copied = await inspect(temp, kind)
            if (!compatible(copied) || copied.team !== payloadIdentity.team) throw new Error(`${kind} 复制后的签名或身份无效`)
            renameSync(temp, destination)
          } finally { rmSync(temp, { force: true }) }
        }
        // 每个已完成组件及时登记；中途失败后的修复沿同一入口继续，不碰配置和工作记录。
        registered = { ...(registered ?? { engine: destinations.engine! }), [kind]: destination }
        writePrivateJSON(manifest, registered)
      }
      if (!existsSync(join(directory, 'engine.json')) && legacy?.parent) writePrivateJSON(join(directory, 'engine.json'), { parent: legacy.parent })
      if (command && options.profile !== 'engine') {
        checkCommand(command, destinations.cli!, legacy?.source)
        mkdirSync(dirname(command), { recursive: true, mode: 0o755 })
        const temp = `${command}.${process.pid}.${crypto.randomUUID()}.tmp`
        try { symlinkSync(destinations.cli!, temp); renameSync(temp, command) } finally { rmSync(temp, { force: true }) }
        registered = { ...registered!, command }; writePrivateJSON(manifest, registered)
        if (realpathSync(command) !== realpathSync(destinations.cli!)) throw new Error('终端命令未指向已安装 CLI，请修复安装')
      }
      return { profile: options.profile, components: registered!, reused, installed: replace, ...(command ? { command } : {}) }
    } finally { release() }
  } catch (error) {
    const current = readComponents(home)
    throw new Error(`${error instanceof Error ? error.message : String(error)}${current ? '；已登记组件保留，可使用同一安装入口修复' : ''}`)
  } finally { lock.release() }
}

function checkCommand(path: string, cli: string, legacy?: string): void {
  let file: ReturnType<typeof lstatSync>
  try { file = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (file.isSymbolicLink()) {
    const target = resolve(dirname(path), readlinkSync(path))
    if (target === cli || (legacy !== undefined && target === legacy)) return
  }
  throw new Error(`终端命令位置已被其他文件占用，未覆盖：${path}`)
}

async function legacySource(path: string, team: string): Promise<string> {
  if (!isAbsolute(path) || !path.endsWith('/Contents/Helpers/magic-runtime')) throw new Error('现有 Engine 未登记组件来源，请先修复安装记录')
  // 拖放更新 App 后旧 helper 已被移除；此时由原位置的已签名 App 证明归属。
  const present = existsSync(path)
  const owner = present ? componentSource(path) : dirname(dirname(dirname(path)))
  if (await signingTeam(owner) !== team) throw new Error('旧 Engine 的签名来源不同，未转换')
  return present ? componentSource(path) : resolve(path)
}

async function legacyInstallation(home: string, team: string, parent?: string): Promise<{ parent: string; bin?: string; source?: string; label?: string; record?: HostDiscovery } | undefined> {
  // Bun 的 homedir/userInfo 都可能采用 HOME；旧 App 偏好只能用于系统账户的真实家目录。
  const account = await execute(['/usr/bin/dscacheutil', '-q', 'user', '-a', 'uid', String(process.getuid!())])
  const accountHome = account.out.match(/^dir: (.+)$/m)?.[1]
  if (account.code !== 0 || !accountHome || !isAbsolute(accountHome)) throw new Error('无法核实系统账户目录，旧安装未转换')
  const isAccountHome = normalizeDataDir(home) === normalizeDataDir(accountHome)
  async function preference(key: string) {
    if (!isAccountHome) return undefined
    const result = await execute(['/usr/bin/defaults', 'read', 'com.magiccode.app', key])
    return result.code === 0 && isAbsolute(result.out.trim()) ? result.out.trim() : undefined
  }
  const selected = parent ?? await preference('baseDirectory') ?? home, bin = await preference('cliDirectory')
  const directory = join(componentDirectory(home), 'runtime'), record = readJSON(join(directory, 'host.json')) as HostDiscovery | undefined
  const plist = join(directory, 'engine.plist')
  if (!record) {
    if (existsSync(plist)) throw new Error('旧系统任务仍存在但缺少运行身份，请先恢复或明确停止原安装')
    const command = join(bin ?? join(home, '.local/bin'), 'magic')
    let source: string | undefined
    try {
      const target = resolve(dirname(command), readlinkSync(command))
      source = await legacySource(target, team)
    } catch { /* 无旧链接时只迁移已有选择；占用冲突由安装预检报告。 */ }
    return { parent: selected, ...(bin ? { bin } : {}), ...(source ? { source } : {}) }
  }
  const source = await legacySource(record.source, team)
  const definition = await execute(['/usr/bin/plutil', '-convert', 'json', '-o', '-', plist])
  let value: { Label?: string; ProgramArguments?: unknown[] }
  try { value = JSON.parse(definition.out) } catch { throw new Error('旧 Engine 系统任务无法核实，未转换') }
  const label = value.Label, args = value.ProgramArguments
  const expectedLabel = isAccountHome ? 'com.magiccode.app.engine' : undefined
  if (definition.code !== 0 || typeof label !== 'string' || !(label === expectedLabel || (expectedLabel === undefined && /^com\.magiccode\.validation\.[A-Za-z0-9.-]+\.engine$/.test(label))) || !args?.includes('--internal-engine') || args[0] !== source || !args.includes(home)) throw new Error('旧系统任务与选定 Engine 来源不一致，未转换')
  if (normalizeDataDir(record.base) !== normalizeDataDir(join(selected, '.magic'))) throw new Error('旧 Engine 数据实例与选择不一致，请先核实基础路径')
  return { parent: selected, source, label, record, ...(bin ? { bin } : {}) }
}
