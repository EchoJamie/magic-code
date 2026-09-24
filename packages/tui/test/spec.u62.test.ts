/**
 * U62 · **引用块的形态 ＋ 图片的名字**（外壳那一半）——按键 → 视图 ＋ 命令。
 *
 * 判据全在设计 · 文件与图片 ·「图片的身份与名字（2026-09-25 定）」与
 * 设计 · 终端交互 ·「引用留在交代的位置」那两条：
 *
 * - **块里装什么按类型**：文件 / 目录＝**路径** · 技能＝`/<名字>` · **图片＝`Image#N`**；
 * - **身份＝内容**（字节的 sha256）：**同一张图在同一段输入里出现两次 ⇒ 同一个名字**
 *   （不然模型以为那是两张）· 两张不同的图 ⇒ 两个编号 · 同名的两张 ⇒ 分得开；
 * - **不假装有文件名**：名字是**一段输入内的编号**，不是地址、也不是文件名；
 * - **块那几条一个都不许动坏**：文件 / 目录 / 技能那几种一个字不变，左右越过、
 *   退格整体删、选区算整个照旧。
 *
 * 走的是**真按键 → 外壳**那条路（与真终端同形）；「那个身份真到了模型那一头」在
 * `packages/app/test/image-name.test.ts`（那边才有真装配与真出站请求体）。
 */

import { describe, expect, test } from 'bun:test'
import type { AttachmentRow, KernelEvent, PathCatalogRow } from '@magic/contracts'
import { composerLayout } from '../src/components/composer.ts'
import type { DraftRef } from '../src/components/inline.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const DOWN = { kind: 'down' } as const
const LEFT = { kind: 'left' } as const
const BACKSPACE = { kind: 'backspace' } as const

/** 一条路径候选（答复里的行）。 */
function row(display: string, kind: 'file' | 'directory' = 'file', external = false): PathCatalogRow {
  return { path: `/ws/${display}`, display, kind, external }
}

/** 喂一条 `paths.catalog`（候选答复）——`query` 是它答复的那一段。 */
function feedPaths(stage: Stage, query: string, rows: readonly PathCatalogRow[]): void {
  stage.feed([event('paths.catalog', { query, rows })] as readonly KernelEvent[])
}

/** 一张图认出来之后的那几格（用例里 blob 就是那串内容身份）。 */
function imageOf(blob: string, name: string) {
  return { mime: 'image/png', name, bytes: 67, blob, label: name }
}

/** 喂一条 `paths.identified`（认出来的答复）——不给 `image` ＝ 那不是一张图。 */
function feedIdentified(
  stage: Stage,
  path: string,
  image?: ReturnType<typeof imageOf>,
): void {
  stage.feed([
    event('paths.identified', { path, ...(image === undefined ? {} : { image }) }),
  ] as readonly KernelEvent[])
}

/** 喂一行「送过的图片」（`/attachments` 的答复）。 */
function attachmentRow(entry: number, name: string, blob: string): AttachmentRow {
  return {
    entry,
    name,
    mime: 'image/png',
    bytes: 67,
    at: 1_700_000_000_000,
    source: `/ws/${name}`,
    label: name,
    blob,
  }
}

/**
 * `@` 那一栏里把 `display` 那条**文件**选进来——回车那一下还会补问一句「它是什么」。
 *
 * ⚠️ `@` 只在**词边界**上开候选（设计：邮箱或转义 `@` 不触发，见 `opensPath`），
 * 故调用方要先落一个空白（或让它在行首）。
 */
function pickFile(stage: Stage, display: string): void {
  stage.press({ kind: 'char', char: '@' })
  feedPaths(stage, '', [row(display)])
  stage.press(ENTER)
}

/** 完整的一趟：选一张图 ⇒ 答复到了 ⇒ 那一处成了编号。 */
function pickImage(stage: Stage, display: string, blob: string): void {
  pickFile(stage, display)
  // 名字是**文件名**那一格（元数据）——答复里给的就是它，不是整条路径
  feedIdentified(stage, `/ws/${display}`, imageOf(blob, display.split('/').at(-1) ?? display))
}

/** 草稿上的引用（视图那一份）。 */
function refs(stage: Stage): readonly DraftRef[] {
  return stage.shell.getView().refs
}

/** 交出去的那一份引用（最近一条 `input.submit` 上的）。 */
function wireRefs(stage: Stage): readonly Record<string, unknown>[] {
  const sent = stage.commands().filter((one) => one.type === 'input.submit')
  const last = sent[sent.length - 1]

  return last?.type === 'input.submit' ? [...(last.refs ?? [])] : []
}

/** 问过几次「这一条是什么」（命令面上的那一支）。 */
function asked(stage: Stage): readonly string[] {
  return stage
    .commands()
    .filter((one) => one.type === 'paths.identify')
    .map((one) => (one.type === 'paths.identify' ? one.path : ''))
}

describe('U62 · 一段输入里的图片名字：`Image#N`', () => {
  test('选一张图 ⇒ 先按路径落稿，认出来之后**在原处**改成编号', () => {
    const stage = createStage()
    pickFile(stage, '报错.png')

    // 选定那一刻还不知道它是什么：那一处是 `@路径`，同时问出去了一句
    expect(stage.shell.getView().draft).toBe('@报错.png')
    expect(asked(stage)).toEqual(['/ws/报错.png'])

    feedIdentified(stage, '/ws/报错.png', imageOf('H1', '报错.png'))

    // 认出来了 ⇒ 那一处**就地**成了编号（不是另插一处、位置一个字没挪）
    const view = stage.shell.getView()
    expect(view.draft).toBe('Image#1')
    expect(refs(stage)).toEqual([
      {
        start: 0,
        end: 7,
        kind: 'image',
        marker: 'Image#1',
        source: '/ws/报错.png',
        label: '报错.png',
        name: '报错.png',
        mime: 'image/png',
        blob: 'H1',
      },
    ])
  })

  test('**不是图**（答复里没有那一格）⇒ 那一处一个字都不变（照旧 `@路径`）', () => {
    const stage = createStage()
    pickFile(stage, '说明.md')
    feedIdentified(stage, '/ws/说明.md')

    expect(stage.shell.getView().draft).toBe('@说明.md')
    expect(refs(stage)[0]?.kind).toBe('file')
  })

  test('**目录不问**——`@src/` 就是它该有的样子（那一趟往返省下）', () => {
    const stage = createStage()
    stage.press({ kind: 'char', char: '@' })
    feedPaths(stage, '', [row('src', 'directory')])
    stage.press(ENTER)

    expect(stage.shell.getView().draft).toBe('@src/')
    expect(asked(stage)).toEqual([])
  })

  test('**同一张图**（同 hash）出现在两处 ⇒ **同一个名字**（内容认身份，不是路径）', () => {
    const stage = createStage()
    pickImage(stage, 'a/报错.png', 'H1')
    stage.type(' 再看 ')
    pickImage(stage, 'b/报错.png', 'H1') // 另一条路径、内容一模一样

    expect(stage.shell.getView().draft).toBe('Image#1 再看 Image#1')
    expect(refs(stage).map((one) => one.marker)).toEqual(['Image#1', 'Image#1'])
    expect(refs(stage).map((one) => (one.kind === 'image' ? one.blob : ''))).toEqual(['H1', 'H1'])
  })

  test('**两张不同的图** ⇒ 两个编号', () => {
    const stage = createStage()
    pickImage(stage, 'a.png', 'H1')
    stage.type(' 和 ')
    pickImage(stage, 'b.png', 'H2')

    expect(stage.shell.getView().draft).toBe('Image#1 和 Image#2')
  })

  test('**同名的两张图**（不同目录、内容不同）⇒ 分得开（名字不撞）', () => {
    const stage = createStage()
    pickImage(stage, 'a/报错.png', 'H1')
    stage.type(' 和 ')
    pickImage(stage, 'b/报错.png', 'H2')

    // 名同、目录不同 ⇒ 从前靠「补来源」（路径）才分得开；现在靠编号就分得开了
    expect(stage.shell.getView().draft).toBe('Image#1 和 Image#2')
    expect(refs(stage).map((one) => (one.kind === 'image' ? one.name : ''))).toEqual([
      '报错.png',
      '报错.png',
    ])
  })

  test('同一条路径选两处：两条答复都到 ⇒ 两处一起改名、共用一个号', () => {
    const stage = createStage()
    pickFile(stage, '报错.png')
    stage.type(' 再看 ')
    pickFile(stage, '报错.png')
    expect(asked(stage)).toEqual(['/ws/报错.png', '/ws/报错.png'])

    // 一条答复回来（同一份内容、同一个身份）⇒ 两处一起改
    feedIdentified(stage, '/ws/报错.png', imageOf('H1', '报错.png'))

    expect(stage.shell.getView().draft).toBe('Image#1 再看 Image#1')
  })

  test('答复到达时用户**已经接着打字** ⇒ 就地换名，插入点不跳（还在他打的字后面）', () => {
    const stage = createStage()
    pickFile(stage, '报错.png')
    stage.type('怎么回事') // 答复还没到，用户接着往下写
    expect(stage.shell.getView().draft).toBe('@报错.png怎么回事')

    feedIdentified(stage, '/ws/报错.png', imageOf('H1', '报错.png'))

    const view = stage.shell.getView()
    expect(view.draft).toBe('Image#1怎么回事')
    expect(view.caret).toBe(11) // 名字短了两格，插入点跟着挪，没跳回前头
  })

  test('工作区外那一条：认出来之后**仍是只读附件**（`external` 随引用走）', () => {
    const stage = createStage()
    stage.press({ kind: 'char', char: '@' })
    // 工作区外那一条：`display` 是绝对路径（写进正文的写法就是它）
    feedPaths(stage, '', [{ path: '/tmp/外面.png', display: '/tmp/外面.png', kind: 'file', external: true }])
    stage.press(ENTER)
    feedIdentified(stage, '/tmp/外面.png', imageOf('H1', '外面.png'))

    expect(stage.shell.getView().draft).toBe('Image#1')
    const ref = refs(stage)[0]
    expect(ref?.kind === 'image' && ref.external).toBe(true)
  })

  test('答复**后到、那一处已经删掉了** ⇒ 不复活、不新插', () => {
    const stage = createStage()
    pickFile(stage, '报错.png')
    stage.press(BACKSPACE) // 整处删掉（引用是原子单元）
    expect(stage.shell.getView().draft).toBe('')

    feedIdentified(stage, '/ws/报错.png', imageOf('H1', '报错.png'))

    expect(stage.shell.getView().draft).toBe('')
    expect(refs(stage)).toHaveLength(0)
  })
})

describe('U62 · 两个入口，一个落地态（`@` 与 `/attachments`）', () => {
  test('同一张图：`/attachments` 放回来 ＋ `@` 选进来 ⇒ 同一个名字', () => {
    const stage = createStage()

    // ① 先从 `/attachments` 把那张图放回输入行（那一行给的身份就是内容身份）
    stage.type('/attachments')
    stage.press(ENTER)
    stage.feed([
      event('attachments.catalog', { rows: [attachmentRow(1, '报错.png', 'H1')] }),
    ] as readonly KernelEvent[])
    stage.press(ENTER) // 进详情
    stage.press(DOWN)
    stage.press(ENTER) // 加入本次输入
    expect(stage.shell.getView().draft).toBe('Image#1')

    // ② 再用 `@` 把**同一张**选进来（另一条路径、内容一样）
    stage.type(' 再看 ')
    pickImage(stage, '备份/报错.png', 'H1')

    expect(stage.shell.getView().draft).toBe('Image#1 再看 Image#1')
  })
})

describe('U62 · 块那几条照旧（反面）', () => {
  test('块就是**一段高亮的文字**：上色的区间正好是 `Image#N` 那七个字', () => {
    const stage = createStage()
    stage.type('看 ')
    pickImage(stage, '报错.png', 'H1')

    const view = stage.shell.getView()
    const layout = composerLayout(view.draft, view.caret, 80, Number.POSITIVE_INFINITY, view.refs)

    // 一处引用＝**一个连续区间**（不加边框、不加类型标记、不铺第二处）
    expect(layout.rows.flatMap((row) => row.spans ?? [])).toEqual([{ start: 2, end: 9 }])
    expect(layout.rows[0]?.text).toBe('看 Image#1')
  })

  test('文件 / 目录那几种一个字都不变', () => {
    const stage = createStage()
    pickFile(stage, 'a.txt')
    feedIdentified(stage, '/ws/a.txt') // 不是图
    expect(stage.shell.getView().draft).toBe('@a.txt')

    stage.type(' ')
    stage.press({ kind: 'char', char: '@' })
    feedPaths(stage, '', [row('src', 'directory')])
    stage.press(ENTER)
    expect(stage.shell.getView().draft).toBe('@a.txt @src/')
  })

  test('编号那一处**仍是一个原子编辑单位**：`←` 跨过整处（不走进那七个字里）', () => {
    const stage = createStage()
    pickImage(stage, '报错.png', 'H1')
    stage.type('看')
    expect(stage.shell.getView().draft).toBe('Image#1看')

    // 第一次 `←`：退掉「看」那一格，落在编号的尾巴上
    stage.press(LEFT)
    expect(stage.shell.getView().caret).toBe(7)
    // 第二次 `←`：**跨过整处编号**，落到它前面（不是落到 `Image#` 里面）
    stage.press(LEFT)
    expect(stage.shell.getView().caret).toBe(0)
  })

  test('退格：整处移除（不留半截 `Image#`），那份材料也不再暗带', () => {
    const stage = createStage()
    pickImage(stage, '报错.png', 'H1')
    stage.type('看')
    stage.press(LEFT) // 插入点停在编号的尾巴上

    stage.press(BACKSPACE)

    expect(stage.shell.getView().draft).toBe('看')
    expect(refs(stage)).toHaveLength(0)
  })

  test('交出去的那一份：`kind: image` ＋ `blob` ＋ 正文里那个编号', () => {
    const stage = createStage()
    pickImage(stage, '报错.png', 'H1')
    stage.press(ENTER)

    expect(stage.shell.getView().draft).toBe('') // 收下了
    const wire = wireRefs(stage)[0]
    expect(wire?.['kind']).toBe('image')
    expect(wire?.['marker']).toBe('Image#1')
    expect(wire?.['blob']).toBe('H1')
    expect(wire?.['at']).toBe(0)
  })

  test('**一段输入内编号**：交出去之后，下一段输入又从 `Image#1` 数起', () => {
    const stage = createStage()
    pickImage(stage, 'a.png', 'H1')
    stage.press(ENTER)
    expect(stage.shell.getView().draft).toBe('')

    pickImage(stage, 'b.png', 'H2')

    expect(stage.shell.getView().draft).toBe('Image#1')
  })

  test('历史召回之后再加一张**不同的图** ⇒ 不撞号（认回正文里已经写着的那个名字）', () => {
    const stage = createStage()
    pickImage(stage, 'a.png', 'H1')
    stage.press(ENTER)
    expect(stage.shell.getView().draft).toBe('')

    stage.press({ kind: 'up' }) // 整份草稿回来（正文里写着 `Image#1`）
    expect(stage.shell.getView().draft).toBe('Image#1')

    stage.type(' 和 ')
    pickImage(stage, 'b.png', 'H2')

    // 已经有人叫 `Image#1` 了 ⇒ 新来的拿 2（从 1 重数就会撞名）
    expect(stage.shell.getView().draft).toBe('Image#1 和 Image#2')
  })
})
