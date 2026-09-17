/**
 * 工作区桩的测试（M01 第 10 轮补 —— U06 / U13 都要向闸门交出根视图）。
 *
 * 钉两件：**可预测缺省**（单根 · 根已规范化）· **不发明行为**（越界就抛，与契约同口径）。
 */

import { describe, expect, test } from 'bun:test'
import { makeFauxWorkspace } from '../src/index.ts'

describe('工作区桩', () => {
  test('单根语义——roots / defaultRoot 同源', () => {
    const workspace = makeFauxWorkspace({ root: '/tmp/faux-ws' })

    expect(workspace.root).toBe('/tmp/faux-ws')
    expect(workspace.roots()).toEqual(['/tmp/faux-ws'])
    expect(workspace.defaultRoot()).toBe('/tmp/faux-ws')
  })

  test('相对路径按默认根解析', () => {
    const workspace = makeFauxWorkspace({ root: '/tmp/faux-ws' })
    const resolved = workspace.resolve('a/b.txt')

    expect(resolved.absolute).toBe('/tmp/faux-ws/a/b.txt')
    expect(resolved.root).toBe('/tmp/faux-ws')
  })

  test('绝对路径须落根内——落内放行', () => {
    const workspace = makeFauxWorkspace({ root: '/tmp/faux-ws' })
    expect(workspace.resolve('/tmp/faux-ws/x').absolute).toBe('/tmp/faux-ws/x')
    // 根本身也算落内
    expect(workspace.resolve('/tmp/faux-ws').absolute).toBe('/tmp/faux-ws')
  })

  test('越界即拒——**抛**（与契约同口径：沙箱侧捕之归 out-of-bounds）', () => {
    const workspace = makeFauxWorkspace({ root: '/tmp/faux-ws' })

    expect(() => workspace.resolve('../outside')).toThrow()
    expect(() => workspace.resolve('/etc/passwd')).toThrow()
    // 近形前缀不算落内（`/tmp/faux-ws-evil` 不在根内）
    expect(() => workspace.resolve('/tmp/faux-ws-evil/x')).toThrow()
  })

  test('根做规范化——相对入参按 cwd 解析后落定', () => {
    const workspace = makeFauxWorkspace({ root: 'playground' })
    expect(workspace.root.startsWith('/')).toBe(true)
    expect(workspace.root.endsWith('playground')).toBe(true)
  })
})
