import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createVt } from './ui/vt.ts'
import { VIEW_LOGIC, writeViewer } from './ui/viewer.ts'

import { removeDir, tempDir } from './tmp.ts'

// ═══════════════════════════════════════════════════════════════════════
// 看帧补正（U40-2）—— 光标显隐取样 ＋ 查看页翻帧
// ═══════════════════════════════════════════════════════════════════════

describe('-2 · 光标显隐与翻帧', () => {
  test('VT 取样带上光标真实显隐：显示 → 藏起 → 再显示 → 软复位回到显示', async () => {
    const vt = createVt({ columns: 200, rows: 40 })

    try {
      const hidden = async (): Promise<boolean> => {
        await vt.settled()

        return vt.screen().cursor.hidden
      }

      // 起手：终端光标本来是显示着的
      vt.write('x')
      expect(await hidden()).toBe(false)

      // 藏（DECTCEM：`CSI ?25l`）——产品起手就是这么干的
      vt.write('\u001b[?25l')
      expect(await hidden()).toBe(true)

      // 显（`CSI ?25h`）
      vt.write('\u001b[?25h')
      expect(await hidden()).toBe(false)

      // 再藏，然后**软复位**（DECSTR `CSI !p`）——重置之后回到「显示」
      vt.write('\u001b[?25l\u001b[!p')
      expect(await hidden()).toBe(false)

      // 坐标还是**同一套**（显隐不另造一份坐标）：显隐那几发转义不动位置，
      // 再打两个字符，光标就落在原处往后两格（实测）
      vt.write('ab')
      await vt.settled()
      const screen = vt.screen()
      expect(screen.cursor.x).toBe(3)
      expect(screen.cursor.y).toBe(0)
    } finally {
      vt.dispose()
    }
  })

  test('查看页：帧里说「藏着」就不画那个黄框，元信息写明「隐藏」', () => {
    const dir = tempDir('magic-u40-view-')
    const html = viewerOf(dir, [
      { step: 1, label: '藏着', hidden: true },
      { step: 2, label: '显示着', hidden: false },
    ])

    const logic = viewLogic()
    const frameHidden = { cursor: { x: 3, y: 0, hidden: true } }
    const frameShown = { cursor: { x: 3, y: 0, hidden: false } }
    const frameOld = { cursor: { x: 3, y: 0 } } // 旧帧没这一格

    // 画不画：隐藏 → 不画（-1）；显示 → 画在原处
    expect(logic.caretColumnAt(frameHidden, 0)).toBe(-1)
    expect(logic.caretColumnAt(frameShown, 0)).toBe(3)
    // 不是光标那一行本来就不画
    expect(logic.caretColumnAt(frameShown, 1)).toBe(-1)
    // 旧帧（这一格是后加的）照旧画——不把老现场弄成没光标
    expect(logic.caretColumnAt(frameOld, 0)).toBe(3)

    // 元信息：隐藏时写明
    expect(logic.cursorNote(frameHidden)).toContain('隐藏')
    expect(logic.cursorNote(frameShown)).not.toContain('隐藏')

    // 数据得进页面（帧文件里那一格，查看页认的就是它）
    const payload = payloadOf(html)
    expect((payload['frames'] as { cursor: { hidden: boolean } }[])[0]?.cursor.hidden).toBe(true)
    expect((payload['frames'] as { cursor: { hidden: boolean } }[])[1]?.cursor.hidden).toBe(false)
    // 页面里跑的就是上面那几段源码（一处写两处用，见 `VIEW_LOGIC` 的注）
    expect(html).toContain('function caretColumnAt')
    expect(html).toContain('function cursorNote')

    removeDir(dir)
  })

  test('查看页翻帧沿全局检查点：末尾无帧那一步也能往回翻，前后往返一致', () => {
    const dir = tempDir('magic-u40-nav-')
    // 三步取过帧（1 / 3 / 5），末尾第 7 步（close 之后）**没有**帧——首轮实测卡在这儿
    const html = viewerOf(dir, [
      { step: 1, label: '第一帧', hidden: false },
      { step: 3, label: '第二帧', hidden: false },
      { step: 5, label: '第三帧', hidden: false },
    ], [1, 3, 5, 7])
    const logic = viewLogic()
    const frames = [0, 1, 2].map((at) => ({ step: [1, 3, 5][at] as number }))

    // 借帧：第 7 步（没有自己的帧）看到的是**它之前最近**那一帧
    expect(logic.nearestFrameAtOrBefore(frames, 7)).toBe(2)
    expect(logic.nearestFrameAtOrBefore(frames, 4)).toBe(1)
    expect(logic.nearestFrameAtOrBefore(frames, 0)).toBe(-1)

    // 翻帧：从末尾那一帧**往回**能走（首轮的毛病正是「这一步没帧就直接 return」）
    const at = logic.nearestFrameAtOrBefore(frames, 7)
    expect(logic.shiftFrame(frames, at, -1)).toBe(1)
    expect(logic.shiftFrame(frames, 1, -1)).toBe(0)
    // 前后往返一致
    expect(logic.shiftFrame(frames, logic.shiftFrame(frames, 0, 1), -1)).toBe(0)
    expect(logic.shiftFrame(frames, logic.shiftFrame(frames, 2, -1), 1)).toBe(2)

    // 边界：到头就不再挪（按钮那边据此禁用）
    expect(logic.canShift(frames, 0, -1)).toBe(false)
    expect(logic.canShift(frames, 0, 1)).toBe(true)
    expect(logic.canShift(frames, 2, 1)).toBe(false)
    expect(logic.canShift(frames, 2, -1)).toBe(true)
    expect(logic.canShift([], -1, 1)).toBe(false)
    expect(logic.canShift([], -1, -1)).toBe(false)

    expect(html).toContain('function shiftFrame')
    expect(html).toContain('function canShift')
    removeDir(dir)
  })
})

/**
 * 起一份**页面里那段判断逻辑**——与内联进查看页的是**同一段源码**（`VIEW_LOGIC`）。
 *
 * 查看页是自包含的单文件（没有 import 可言），故「跑在浏览器里的」与「用例验的」
 * 只能靠同一份源码保证是同一件事：这里 `new Function` 起的，就是内联进去的那段。
 */
function viewLogic(): {
  nearestFrameAtOrBefore(frames: readonly { step: number }[], step: number): number
  shiftFrame(frames: readonly unknown[], at: number, delta: number): number
  canShift(frames: readonly unknown[], at: number, delta: number): boolean
  caretColumnAt(frame: { cursor: { x: number; y: number; hidden?: boolean } }, y: number): number
  cursorNote(frame: { cursor: { x: number; y: number; hidden?: boolean } }): string
} {
  return new Function(
    `${VIEW_LOGIC}\nreturn { nearestFrameAtOrBefore, shiftFrame, canShift, caretColumnAt, cursorNote }`,
  )() as never
}

/** 造一份最小现场（只有查看页要读的那几格）＋生成查看页，返回 HTML。 */
function viewerOf(
  dir: string,
  frames: readonly { step: number; label: string; hidden: boolean }[],
  steps: readonly number[] = [1, 2],
): string {
  const runDir = join(dir, 'run')
  mkdirSync(join(runDir, 'frames'), { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      run: 'run',
      label: '用例-查看页',
      startedAt: '2026-09-20T00:00:00.000Z',
      checkout: dir,
      commit: '0000000',
      dirty: false,
      bun: Bun.version,
      app: { argv: [], cwd: dir, home: dir, dataDir: dir, configPath: '', forceColor: '0' },
      terminal: { columns: 200, rows: 40, scrollback: 100, term: 'xterm-256color' },
      fixture: null,
      rawLimitBytes: 1,
      steps: steps.length,
      frames: frames.length,
      truncated: false,
      outcome: 'closed',
    }),
  )
  writeFileSync(
    join(runDir, 'steps.ndjson'),
    steps.map((n) => `${JSON.stringify({ n, at: n, action: 'capture', bytes: 0 })}\n`).join(''),
  )
  frames.forEach((frame, at) => {
    const n = at + 1
    writeFileSync(
      join(runDir, 'frames', `${String(n).padStart(4, '0')}-${frame.label}.json`),
      JSON.stringify({
        n,
        step: frame.step,
        label: frame.label,
        at: 0,
        columns: 200,
        rows: 40,
        cursor: { x: 3, y: 0, hidden: frame.hidden },
        scrollback: 0,
        total: 40,
        styles: [''],
        lines: [{ wrapped: false, runs: [[0, 'x', 1, 0]] }],
      }),
    )
  })

  return readFileSync(writeViewer(runDir), 'utf8')
}

/** 查看页里那份内联数据（`<script id="payload">`）。 */
function payloadOf(html: string): Record<string, unknown> {
  const raw = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  return JSON.parse(raw.replaceAll('\\u003c', '<')) as Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════
// D30 · 切帧那一层自己的边界 —— **修法在相反情形下也得成立**
// ═══════════════════════════════════════════════════════════════════════

/**
 * 同步更新的两个标记。用 `String.fromCharCode` 拼，不在源码里写控制字节
 * （仓里别处也这么写——真字符在源码里看不见，改了也不知道）。
 */
const BSU = `${String.fromCharCode(27)}[?2026h`
const ESU = `${String.fromCharCode(27)}[?2026l`

describe('D30 · 同步更新切帧的相反情形', () => {
  test('不认这套协议的应用：没有标记就立刻落屏；像标记开头的半截先攒着，判明后照旧交', async () => {
    const vt = createVt({ columns: 200, rows: 40 })
    try {
      vt.write('甲')
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('甲')
      expect(vt.screenBytes()).toBe(Buffer.byteLength('甲'))

      // 末尾是**半个标记**（两个标记开头一样）：先攒着、不交
      vt.write(BSU.slice(0, 5))
      await vt.settled()
      expect(vt.screenBytes()).toBe(Buffer.byteLength('甲'))
      expect(vt.screen().lines[0]?.text).toBe('甲')

      // 拼下去发现**不是**标记（`?200` 不是 `?2026`）⇒ 攒着的那截照常交出去，屏不冻
      vt.write('0h')
      await vt.settled()
      expect(vt.screenBytes()).toBe(Buffer.byteLength('甲') + BSU.slice(0, 5).length + 2)
      expect(vt.screen().lines[0]?.text).toBe('甲')
    } finally {
      vt.dispose()
    }
  })

  test('标记被切在两块之间：那半截不算数，拼全了照常算——不丢、也不误判', async () => {
    const vt = createVt({ columns: 200, rows: 40 })
    try {
      // `h` 的前 5 个字符先到：这一段**不能**当成普通字节交出去（交了后面就再也认不出这个标记）
      vt.write(BSU.slice(0, 5))
      await vt.settled()
      expect(vt.screenBytes()).toBe(0)
      vt.write(BSU.slice(5))
      await vt.settled()
      // 拼全了，但这一帧**还没画完** ⇒ 水位仍停在上一帧的边界
      // （标记本身不画东西，屏不变；整帧落地时它连同内容一起交出去）
      expect(vt.screenBytes()).toBe(0)
      expect(vt.screen().lines[0]?.text).toBe('')

      // 块里的内容：这一帧还没画完 ⇒ 不落屏
      vt.write('甲')
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('')
      // `l` 一到，整帧一次落地
      vt.write(ESU)
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('甲')
      expect(vt.screenBytes()).toBe(BSU.length + Buffer.byteLength('甲') + ESU.length)
    } finally {
      vt.dispose()
    }
  })

  test('半截帧不落屏、且**不覆盖**上一帧：`l` 到了才整帧换过去', async () => {
    const vt = createVt({ columns: 200, rows: 40 })
    try {
      vt.write(`${BSU}第一帧${ESU}`)
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('第一帧')

      // 第二帧：起手先擦、再写半截就停住——真终端这一下**还没换屏**（2026 就是为这个发明的），
      // 屏上该是**上一帧原样**，不是擦完还没画的空档
      vt.write(`${BSU}${String.fromCharCode(27)}[2K${String.fromCharCode(27)}[1G`)
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('第一帧')
      expect(vt.screenBytes()).toBe(BSU.length + Buffer.byteLength('第一帧') + ESU.length)

      vt.write(`第二帧${ESU}`)
      await vt.settled()
      expect(vt.screen().lines[0]?.text).toBe('第二帧')
    } finally {
      vt.dispose()
    }
  })
})
