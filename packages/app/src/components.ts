import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** 安装事实与用户选择不属于任何客户端；运行记录仍单独存放。 */
export function componentDirectory(home: string): string {
  return join(home, 'Library/Application Support/Magic Code')
}
export type Components = { readonly engine: string; readonly cli?: string; readonly command?: string }
export function readComponents(home: string): Components | undefined {
  const path = join(componentDirectory(home), 'components.json')
  const value = readJSON(path)
  if (value === undefined) return undefined
  if (typeof value.engine !== 'string' || !isAbsolute(value.engine) || ['cli', 'command'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !isAbsolute(value[key] as string)))) throw new Error('组件安装记录无效，请修复安装')
  return value as Components
}
export function selectedParent(home: string): string {
  const value = readJSON(join(componentDirectory(home), 'engine.json'))
  if (value === undefined) return home
  if (typeof value.parent !== 'string' || !isAbsolute(value.parent)) throw new Error('Engine 数据目标无效，请明确选择基础路径')
  return value.parent
}
export function readJSON(path: string): Record<string, unknown> | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`文件不是合法 JSON：${path}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`文件内容须为对象：${path}`)
  return value as Record<string, unknown>
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error(`私有目录不属于当前用户：${path}`)
  chmodSync(path, 0o700)
}
export function writePrivateJSON(path: string, value: unknown): void {
  privateDirectory(dirname(path))
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path) }
  finally { rmSync(temp, { force: true }) }
}
export function componentSource(path: string): string {
  try { return realpathSync(path) } catch { throw new Error(`组件不存在：${path}；请修复安装`) }
}
