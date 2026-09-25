/**
 * U13 · 沙箱文件原语 —— `read` · `write` · `list`（真文件系统 · 临时目录）。
 *
 * 出处：技术方案 · 执行「原语形态（决策级）」——`read(path)` · `write(path, data)` ·
 * `list(path)`；**路径解析**——相对按默认根、绝对须落于某根内（越界即拒）。
 *
 * 三条口径（本单元的形态选择，见契约 `ports.ts` 的同名注）：
 * - **越界即拒＝抛**——`WorkspaceService.resolve` 抛，原语不捕（`exec` 是唯一把它归成
 *   `reason` 的原语——它有判别式位置，余四者没有）；
 * - **失败＝抛 ＋ 报文精确**（越界 / 不存在 / 是目录 / 上级目录不存在…）——「错误＝返回值」
 *   落在**工具边界**（文件类工具捕之、以 `ok:false` 回填模型）；
 * - **截断**——`read` 超上限到上限为止（`truncated`），**字段缺席＝没截**。
 *
 * 测试用 fs 不受守护拦（守护面收窄至各包 `src/`）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ListEntry, Sandbox } from '@magic/contracts'
import { createSandbox, createWorkspaceService } from '../src/index.ts'
import { DEFAULT_MAX_READ_BYTES } from '../src/files.ts'

// —— 夹具 ——

const roots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'magic-files-'))
  roots.push(root)
  return root
}

function sandboxOn(root: string): { box: Sandbox; root: string } {
  const workspace = createWorkspaceService({ roots: [root] })
  return { box: createSandbox({ workspace }), root: workspace.defaultRoot() }
}

/** 一步到位：新根 ＋ 新沙箱（根已 realpath 归一）。 */
function freshSandbox(): { box: Sandbox; root: string } {
  return sandboxOn(freshRoot())
}

/** 在根里落一个文件（父目录一并建）。 */
function seed(root: string, relative: string, content: string): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

/** 按名取条目（列表断言用）。 */
function entryNamed(entries: readonly ListEntry[], name: string): ListEntry | undefined {
  return entries.find((entry) => entry.name === name)
}

process.on('exit', () => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
})

// 类型层探针（tsc 校验）——实现面与契约端口相符
type _FaceMatchesPort = ReturnType<typeof createSandbox> extends Sandbox ? true : never
const _faceProbe: _FaceMatchesPort = true
void _faceProbe

// ══ read ══════════════════════════════════════════════════════════════

describe('U13 · read —— 读文件（超长截断）', () => {
  test('常规：内容逐字节相等，且没截（字段缺席）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'note.txt', '第一行\n第二行\n')

    const result = await box.read('note.txt')

    expect(result.content).toBe('第一行\n第二行\n')
    expect(result.truncated).toBeUndefined()
  })

  test('相对路径按默认根解析；根内绝对路径同样放行', async () => {
    const { box, root } = freshSandbox()
    const absolute = seed(root, 'sub/a.txt', 'A')

    expect((await box.read('sub/a.txt')).content).toBe('A')
    expect((await box.read(absolute)).content).toBe('A')
  })

  test('空文件 → content 为空串，不是失败', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'empty.txt', '')

    const result = await box.read('empty.txt')
    expect(result.content).toBe('')
    expect(result.truncated).toBeUndefined()
  })

  test('超长 → 截到上限为止（truncated）· 内容是原文前缀 · 不超过上限字节', async () => {
    const { box, root } = freshSandbox()
    const original = 'abcdefgh'.repeat(DEFAULT_MAX_READ_BYTES / 8 + 512)
    seed(root, 'big.txt', original)

    const result = await box.read('big.txt')

    expect(result.truncated).toBe(true)
    expect(original.startsWith(result.content)).toBe(true) // 截下来的是原文前缀
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_READ_BYTES,
    )
  })

  test('恰好等于上限 → 不算截断（边界取「大于」）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'exact.txt', 'x'.repeat(DEFAULT_MAX_READ_BYTES))

    const result = await box.read('exact.txt')

    expect(result.truncated).toBeUndefined()
    expect(result.content).toHaveLength(DEFAULT_MAX_READ_BYTES)
  })

  test('多字节字符恰被劈在截断处 → 不编造替换符（丢掉半片，不冲尾）', async () => {
    const { box, root } = freshSandbox()
    // 上限字节全部用三字节汉字填满，末尾再塞一个汉字的**前一字节**也不剩——
    // 直接构造「上限处正在字符中间」：汉字总数使 3n > 上限 且 3(n-1) < 上限
    const filler = '汉'.repeat(Math.floor(DEFAULT_MAX_READ_BYTES / 3) + 1)
    seed(root, 'cjk.txt', filler)

    const result = await box.read('cjk.txt')

    expect(result.truncated).toBe(true)
    expect(result.content.includes('�')).toBe(false)
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_READ_BYTES,
    )
  })

  test('文件不存在 → 抛，报文点出路径与「不存在」', async () => {
    const { box } = freshSandbox()

    await expect(box.read('no-such.txt')).rejects.toThrow(/不存在/)
    await expect(box.read('no-such.txt')).rejects.toThrow(/no-such\.txt/)
  })

  test('是目录 → 抛，报文点出「是目录」（不静默给空串）', async () => {
    const { box, root } = freshSandbox()
    mkdirSync(join(root, 'adir'))

    await expect(box.read('adir')).rejects.toThrow(/是目录/)
  })

  test('越界 → 抛（相对逃逸与根外绝对路径都拒）', async () => {
    const { box } = freshSandbox()

    await expect(box.read('../escape.txt')).rejects.toThrow(/工作区越界/)
    await expect(box.read('/etc/hosts')).rejects.toThrow(/工作区越界/)
  })

  test('opts.maxBytes 可**放大**上限（`edit` 的「读 → 改 → 写回」靠它）', async () => {
    const { box, root } = freshSandbox()
    const doubled = 'x'.repeat(DEFAULT_MAX_READ_BYTES + 1024)
    seed(root, 'big.txt', doubled)

    const result = await box.read('big.txt', { maxBytes: doubled.length + 1 })

    expect(result.truncated).toBeUndefined()
    expect(result.content).toBe(doubled)
  })

  test('opts.maxBytes 可**收紧**上限（按字节截）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'txt.txt', 'abcdefghij')

    const result = await box.read('txt.txt', { maxBytes: 4 })

    expect(result.truncated).toBe(true)
    expect(result.content).toBe('abcd')
  })

  test('opts.maxBytes 非法（NaN / 0 / 负数）→ 回落实现常量，不悄悄变语义', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'ok.txt', 'hello')

    for (const maxBytes of [Number.NaN, 0, -1]) {
      const result = await box.read('ok.txt', { maxBytes })
      expect(result.content).toBe('hello')
      expect(result.truncated).toBeUndefined()
    }
  })
})

// ══ write ═════════════════════════════════════════════════════════════

describe('U13 · write —— 新建 / 整写文件', () => {
  test('新建：文件落盘，内容逐字节相等', async () => {
    const { box, root } = freshSandbox()

    await box.write('new.txt', { text: '内容\n' })

    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('内容\n')
  })

  test('整写：覆盖旧内容（不是追加），长度可短于原文', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'over.txt', '一长串旧内容')

    await box.write('over.txt', { text: '新' })

    expect(readFileSync(join(root, 'over.txt'), 'utf8')).toBe('新')
  })

  test('空串 → 写一个空文件（0 字节）', async () => {
    const { box, root } = freshSandbox()

    await box.write('blank.txt', { text: '' })

    expect(readFileSync(join(root, 'blank.txt'), 'utf8')).toBe('')
  })

  test('上级目录不存在 → 抛（不悄悄建目录），文件不落地', async () => {
    const { box, root } = freshSandbox()

    await expect(box.write('no-dir/x.txt', { text: 'X' })).rejects.toThrow(/上级目录不存在/)
    expect(existsSync(join(root, 'no-dir'))).toBe(false)
  })

  test('字节支 → **原样落盘**（不经文本往返；blob 引用不在此——存取归记录域）', async () => {
    const { box, root } = freshSandbox()
    // 含 0xff / 0x00——若被当成 UTF-8 文本往返，这两个字节必变形（替换符 / 截断）
    const bytes = new Uint8Array([0xff, 0x00, 0x41, 0xfe])

    await box.write('raw.bin', { bytes })

    expect([...readFileSync(join(root, 'raw.bin'))]).toEqual([0xff, 0x00, 0x41, 0xfe])
  })

  test('越界 → 抛，且副作用不发生', async () => {
    const { box, root } = freshSandbox()

    await expect(box.write('../escape.txt', { text: 'X' })).rejects.toThrow(/工作区越界/)
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false)
  })
})

// ══ list ══════════════════════════════════════════════════════════════

describe('U13 · list —— 列目录', () => {
  test('名 / 类型 / 尺寸三件齐（目录不给尺寸）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'a.txt', 'abcd')
    mkdirSync(join(root, 'sub'))

    const entries = await box.list('.')

    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'sub'])
    expect(entryNamed(entries, 'a.txt')).toEqual({ name: 'a.txt', kind: 'file', size: 4 })
    expect(entryNamed(entries, 'sub')).toEqual({ name: 'sub', kind: 'directory' })
  })

  test('按名字序（不靠文件系统序——两次列同一目录结果稳定）', async () => {
    const { box, root } = freshSandbox()
    for (const name of ['zeta', 'alpha', 'mid']) mkdirSync(join(root, name))

    const first = await box.list('.')
    const second = await box.list('.')

    expect(second.map((entry) => entry.name)).toEqual(first.map((entry) => entry.name))
    expect(first.map((entry) => entry.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  test('名是名字不是路径（子目录里的条目照旧只给名）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'sub/inner.txt', 'x')

    const entries = await box.list('sub')

    expect(entries.map((entry) => entry.name)).toEqual(['inner.txt'])
  })

  test('空目录 → 空数组（不是失败）', async () => {
    const { box, root } = freshSandbox()
    mkdirSync(join(root, 'vacant'))

    expect(await box.list('vacant')).toEqual([])
  })

  test('目录不存在 → 抛', async () => {
    const { box } = freshSandbox()

    await expect(box.list('no-such-dir')).rejects.toThrow(/目录不存在/)
  })

  test('拿文件当目录 → 抛，报文点出「不是目录」', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'file.txt', 'x')

    await expect(box.list('file.txt')).rejects.toThrow(/不是目录/)
  })

  test('越界 → 抛', async () => {
    const { box } = freshSandbox()

    await expect(box.list('/etc')).rejects.toThrow(/工作区越界/)
    await expect(box.list('../..')).rejects.toThrow(/工作区越界/)
  })
})

// ══ 失败那句的形制（U83 · 缺陷 D41）══════════════════════════════════

/**
 * **动作名只在此处拼一次**（`files.ts` 的 `namedFailure`）——判据落在这一层。
 *
 * 由头：这条链上原先**两层各加了一次前缀**——这里产出 `写入失败（path）：原因`，
 * 工具域 `messages.ts` 又缀一个 `写入失败：`，屏上成了
 * 「写入失败：写入失败（path）：上级目录不存在——先建目录」：**同一条事实说两遍**，
 * 而唯一能照做的那句指引被淹在前缀里。⇒ 本层这三个动作的报文就是**最终那句话**，
 * 工具边界只回填、不再拼（`packages/tools` 那侧同有判据）。
 *
 * 钉的是三件一起：**名分一次** ＋ **路径在**（模型据此改法）＋ **原委（含可照做的指引）在**。
 */
describe('U83 · 失败报文 —— 名分一次 · 路径在 · 原委在', () => {
  /** 报文里的名分出现次数（`读取失败` / `写入失败` / `列目录失败` 各数各的）。 */
  const nameCount = (message: string, name: string): number =>
    message.split(`${name}失败`).length - 1

  test('写入：上级目录不存在', async () => {
    const { box, root } = freshSandbox()

    const message = await box
      .write('no-dir/x.txt', { text: 'X' })
      .then(() => '')
      .catch((error: Error) => error.message)

    expect(message).toBe(`写入失败（${join(root, 'no-dir', 'x.txt')}）：上级目录不存在——先建目录`)
    expect(nameCount(message, '写入')).toBe(1)
  })

  test('读取：文件不存在', async () => {
    const { box, root } = freshSandbox()

    const message = await box
      .read('no-such.txt')
      .then(() => '')
      .catch((error: Error) => error.message)

    expect(message).toBe(`读取失败（${join(root, 'no-such.txt')}）：文件不存在`)
    expect(nameCount(message, '读取')).toBe(1)
  })

  test('列目录：目录不存在', async () => {
    const { box, root } = freshSandbox()

    const message = await box
      .list('no-such-dir')
      .then(() => '')
      .catch((error: Error) => error.message)

    expect(message).toBe(`列目录失败（${join(root, 'no-such-dir')}）：目录不存在`)
    expect(nameCount(message, '列目录')).toBe(1)
  })

  test('认不出的错误码照抄原委——名分仍只一次（不吞、不编）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'a-dir', 'x') // 拿文件当目录：`ENOTDIR`

    const message = await box
      .list('a-dir/sub')
      .then(() => '')
      .catch((error: Error) => error.message)

    expect(message).toBe(`列目录失败（${join(root, 'a-dir', 'sub')}）：不是目录`)
    expect(nameCount(message, '列目录')).toBe(1)
  })
})
