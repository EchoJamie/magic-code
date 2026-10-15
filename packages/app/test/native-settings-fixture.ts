import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SettingsAction, SettingsPreview, SettingsSnapshot } from '@magic/contracts'

type Request = { request: string; home: string; base: string; configPath: string; stamp?: string | null; action?: SettingsAction; preview?: SettingsPreview }
type Result = { request: string; base: string; configPath: string; saved: boolean; note?: string; snapshot?: SettingsSnapshot; error?: string }
let compiled: Promise<{ binary: string; metadata: string }> | undefined
function nativeSettings() {
  return compiled ??= (async () => {
    const root = resolve(import.meta.dir, '../../..'), temp = mkdtempSync(join(tmpdir(), 'magic-native-settings-'))
    process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
    const binary = join(temp, 'settings-test'), metadata = join(temp, 'settings-data.json')
    const files = ['SettingsWire', 'SettingsFile', 'SettingsValidation', 'SettingsModels', 'NativeSettings', 'NativeWire', 'Diagnostics', 'PrivateFiles', 'ObserverConnection'].map(name => `apps/macos/MagicCode/Runtime/${name}.swift`)
    const build = Bun.spawn(['/usr/bin/xcrun', 'swiftc', '-parse-as-library', ...files, 'apps/macos/MagicCodeTests/SettingsHarness.swift', '-o', binary], {
      cwd: root, env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()])
    if (code !== 0) throw new Error(`原生设置测试编译失败：${error}`)
    const data = Bun.spawn([process.execPath, 'scripts/macos/build-settings-data.ts', metadata], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const [dataCode, dataError] = await Promise.all([data.exited, new Response(data.stderr).text()])
    if (dataCode !== 0) throw new Error(`设置资料生成失败：${dataError}`)
    return { binary, metadata }
  })()
}
export async function runNativeSettings(request: Request, environment: Readonly<Record<string, string | undefined>> = {}): Promise<Result> {
  const { binary, metadata } = await nativeSettings()
  const child = Bun.spawn([binary, metadata], { stdin: new Blob([JSON.stringify(request)]), stdout: 'pipe', stderr: 'pipe', env: environment })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(error)
  return JSON.parse(output) as Result
}
export async function holdNativeSettingsLock(request: Request) {
  const { binary, metadata } = await nativeSettings()
  const ready = join(request.home, 'native-lock-ready'), release = join(request.home, 'native-lock-release')
  const child = Bun.spawn([binary, metadata, 'hold-lock', ready, release], { stdin: new Blob([JSON.stringify(request)]), stdout: 'ignore', stderr: 'pipe', env: {} })
  const deadline = Date.now() + 3000
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) { child.kill(); await child.exited; throw new Error('原生锁未就绪') }
    await Bun.sleep(5)
  }
  return async () => { writeFileSync(release, 'release'); await child.exited; rmSync(ready); rmSync(release) }
}
