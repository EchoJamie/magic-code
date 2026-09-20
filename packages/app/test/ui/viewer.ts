/**
 * 界面验收 · 查看页（U40）——**终端数据的可视重现**，给人翻帧用。
 *
 * ## 它是什么、不是什么
 *
 * 是：**按步骤前后翻帧**，保留色彩、字格宽度与光标位置——「哪一步开始不对」靠翻。
 * 数据就是帧文件里那份（`frames/*.json` 的字格），不是另录一遍。
 *
 * 不是：真终端的**字体与像素截图**（蒙纳奇字体、字距、连字都不同），
 * 更不是「页面好看 ＝ 产品体验好」的证据（设计文档原话：不以页面本身好看证明体验好）。
 *
 * ## 三条讲究
 *
 * 1. **不引前端框架**——一份自包含的 HTML ＋ 一段原生 JS（`file://` 直接打开就能用，
 *    不联网、不取外部资源）；
 * 2. **内容一律当文本**——模型输出、文件内容、用户输入都可能带 `<script>`，
 *    故数据经 JSON 内联时把 `<` 转义成 `<`，渲染一律走 `textContent`；
 * 3. **字号即列宽**——每一行是一张 `repeat(columns, 1ch)` 的网格，每段按
 *    `grid-column: 起始列 / span 占用列数` 落位（宽字符占两列，占位由**帧里的宽度**说了算，
 *    不是拿字体去猜——猜错就与真终端对不上）。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRun } from './artifacts.ts'

/**
 * 查看页里那几段**纯判断**——**一处写、两处用**：内联进页面（浏览器里跑的就是它），
 * 用例里用 `new Function` 起**同一份**来验（查看页是自包含的单文件，没有 import 可言，
 * 只能靠同一份源码保证「验的」与「跑的」是同一件事）。
 *
 * 两条规矩：**坐标只有一套**（`frame.cursor.x/y`，这里判的只是「画不画、往哪翻」）；
 * **翻帧沿全局检查点序列**，不困在当前那一步里。
 */
export const VIEW_LOGIC = `
  // 第 step 步（或它之前）最近的一帧在全局帧序列里的位置；没有＝-1。
  // 「这一步没取帧」时借它之前最近那一帧看——「哪一步开始不对」要的就是这个。
  function nearestFrameAtOrBefore(frames, step) {
    let found = -1
    for (let at = 0; at < frames.length; at += 1) {
      if (frames[at].step <= step) found = at
    }
    return found
  }

  // 沿**全局**帧序列挪一格——翻帧跨 capture，不困在当前那一步里（到头就停住）。
  function shiftFrame(frames, at, delta) {
    if (frames.length === 0) return -1
    if (at < 0) return delta > 0 ? 0 : frames.length - 1
    return Math.min(Math.max(at + delta, 0), frames.length - 1)
  }

  // 那个方向还挪得动吗（挪不动＝按钮禁用）。
  function canShift(frames, at, delta) {
    if (frames.length === 0) return false
    return shiftFrame(frames, at, delta) !== at
  }

  // 这一行该不该画光标——该画就给出它的列，不画＝-1。
  // ⚠️ 终端把光标**藏起来**时（DECTCEM）不画：那个位置是隐藏光标停的回退位，
  // 屏上并没有它；老帧没这一格（这一栏是后加的）照旧画，不把旧现场弄成没光标。
  function caretColumnAt(frame, y) {
    if (y !== frame.cursor.y) return -1
    return frame.cursor.hidden === true ? -1 : frame.cursor.x
  }

  // 元信息里那一截（页面与帧文本同一句话）：隐藏时写明。
  function cursorNote(frame) {
    return '光标 (' + frame.cursor.x + ', ' + frame.cursor.y + ')' +
      (frame.cursor.hidden === true ? ' · 隐藏' : '')
  }
`

/** 生成（或重新生成）一次运行的查看页——**只读现场文件**。 */
export function writeViewer(runDir: string): string {
  const { info, steps, frames } = readRun(runDir)
  const payload = {
    info,
    steps,
    frames: frames.map((frame) => ({ ...frame, runs: frame.lines })),
  }

  const html = page(JSON.stringify(payload).replaceAll('<', '\\u003c'), info.run)
  const path = join(runDir, 'viewer.html')
  writeFileSync(path, html, 'utf8')

  return path
}

/** 查看页在不在（复跑/交付时用）。 */
export function hasViewer(runDir: string): boolean {
  return existsSync(join(runDir, 'viewer.html'))
}

function page(data: string, run: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>界面验收 · ${run}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         background: #14161a; color: #d8dee9;
         font: 13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  header { padding: 10px 14px; border-bottom: 1px solid #2b2f38; background: #191c22; }
  header h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  header .meta { color: #8b93a1; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .badge { padding: 0 6px; border-radius: 3px; background: #2b2f38; color: #cbd2dd; }
  .badge.dirty { background: #4a2b2b; color: #ffb4a2; }
  .badge.failed { background: #5a2323; color: #ffd0d0; }
  .failure { margin-top: 8px; padding: 8px 10px; border-left: 3px solid #d05c5c; background: #241b1b;
             white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  main { flex: 1; display: flex; min-height: 0; }
  nav { width: 320px; flex: 0 0 auto; overflow: auto; border-right: 1px solid #2b2f38; background: #171a1f; }
  nav .step { padding: 6px 10px; border-bottom: 1px solid #1f232a; cursor: pointer; font-size: 12px;
              font-family: ui-monospace, Menlo, monospace; }
  nav .step:hover { background: #1d2128; }
  nav .step.on { background: #22303f; }
  nav .step .act { color: #9ecbff; }
  nav .step .arg { color: #8b93a1; }
  nav .step .mark { color: #6b7381; }
  section { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .bar { padding: 8px 12px; border-bottom: 1px solid #2b2f38; display: flex; gap: 10px; align-items: center;
         color: #8b93a1; font-size: 12px; flex-wrap: wrap; }
  button { background: #232830; color: #d8dee9; border: 1px solid #333a45; border-radius: 4px;
           padding: 3px 10px; cursor: pointer; font: inherit; }
  button:hover { background: #2b313b; }
  button:disabled { opacity: .4; cursor: default; }
  .stage { flex: 1; overflow: auto; padding: 12px; }
  .screen { background: #0f1115; border: 1px solid #2b2f38; border-radius: 6px; padding: 10px 12px;
            font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.35;
            font-variant-ligatures: none; width: max-content; min-width: 100%; }
  .line { display: flex; align-items: stretch; }
  .gut { flex: 0 0 2ch; color: #55606f; text-align: right; padding-right: 4px; user-select: none; }
  .row { display: grid; grid-auto-rows: 1.35em; position: relative; flex: 0 0 auto; }
  .row > span { white-space: pre; grid-row: 1; }
  .cursor { outline: 2px solid #f0c674; outline-offset: -1px; }
  .note { color: #8b93a1; font-size: 12px; margin: 0 0 8px; }
  footer { padding: 6px 14px; border-top: 1px solid #2b2f38; color: #6b7381; font-size: 11px; }
  code { font-family: ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<header id="head"></header>
<main>
  <nav id="steps"></nav>
  <section>
    <div class="bar">
      <button id="prev-frame">← 上一帧</button>
      <button id="next-frame">下一帧 →</button>
      <span id="pos"></span>
      <span id="framesize"></span>
    </div>
    <div class="stage" id="stage"></div>
  </section>
</main>
<footer>
  终端数据的可视重现——字体与像素不等同真终端；色板对 256 色作近似。<br>
  键盘 ← → 翻帧（Shift 加 ← → 翻步）。
</footer>
<script id="payload" type="application/json">${data}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('payload').textContent)
  const { info, steps, frames } = data
  const $ = (id) => document.getElementById(id)

${VIEW_LOGIC}

  // —— 色板（ansi:N 的近似；真彩走原值）——
  const ANSI = ['#000000','#cc0000','#4e9a06','#c4a000','#3465a4','#75507b','#06989a','#d3d7cf',
                '#555753','#ef2929','#8ae234','#fce94f','#729fcf','#ad7fa8','#34e2e2','#eeeeec']

  const styleOf = (token) => {
    if (!token) return {}
    const [fg, bg, attrs] = token.split('|')
    const color = (v) => (v.startsWith('#') ? v : v.startsWith('ansi:') ? (ANSI[Number(v.slice(5))] || '#888888') : '')
    const style = {}
    if (fg) style.color = color(fg)
    if (bg) style.background = color(bg)
    if (attrs.includes('b')) style.fontWeight = '700'
    if (attrs.includes('s')) style.textDecoration = 'line-through'
    if (attrs.includes('i')) style.filter = 'invert(1)'
    return style
  }

  const el = (tag, cls) => { const node = document.createElement(tag); if (cls) node.className = cls; return node }

  // —— 头：运行信息（提交 / dirty / 版本 / 尺寸 / 颜色 / 结局）——
  $('head').appendChild((() => {
    const h1 = el('h1')
    h1.textContent = info.label + ' · ' + info.run
    const meta = el('div', 'meta')
    const put = (label, value, cls) => {
      const item = el('span', cls)
      item.textContent = label + ' ' + value
      meta.appendChild(item)
    }
    put('提交', info.commit.slice(0, 10), 'badge')
    if (info.dirty) put('工作区', '有未提交改动', 'badge dirty')
    put('bun', info.bun)
    put('终端', info.terminal.columns + '×' + info.terminal.rows)
    put('FORCE_COLOR', info.app.forceColor)
    put('帧', info.frames + ' / 步 ' + info.steps)
    put('结局', info.outcome, info.outcome === 'failed' ? 'badge failed' : 'badge')
    if (info.exit) put('退出', String(info.exit.code) + (info.exit.signal ? ' / ' + info.exit.signal : ''))
    if (info.fixture) put('模型端点', info.fixture.baseURL)
    if (info.truncated) put('原始字节', '已触上限 ' + info.rawLimitBytes + '（这份现场不完整）', 'badge dirty')
    const wrap = document.createDocumentFragment()
    wrap.appendChild(h1)
    wrap.appendChild(meta)
    if (info.failure) {
      const box = el('div', 'failure')
      box.textContent = '失败于「' + info.failure.step + '」 · ' + info.failure.kind + '\\n' + info.failure.detail
      wrap.appendChild(box)
    }
    return wrap
  })())

  // —— 步：列表（点击选中）——
  const framesOfStep = (n) => frames.filter((frame) => frame.step === n)
  const describe = (step) => {
    const parts = []
    for (const key of ['text', 'key', 'columns', 'rows', 'label', 'condition', 'matched', 'elapsedMs', 'ok', 'reason']) {
      if (step[key] !== undefined && step[key] !== null && step[key] !== '') {
        parts.push(key + '=' + (typeof step[key] === 'object' ? JSON.stringify(step[key]) : String(step[key])))
      }
    }
    return parts.join(' ')
  }
  // 选中：**步**（左侧列表高亮）＋ **全局帧序列上的第几帧**（翻帧走的是它）。
  //
  // ⚠️ 首轮验收实测的毛病：翻帧只在「当前这一步自己的帧」里挪——而一步通常就一帧、
  // 末尾几步压根没帧，于是「上一帧」点了没反应。现在翻帧沿**全局检查点序列**走：
  // 从末尾那个没帧的步，照样能一帧一帧往回翻。
  let selectedStep = steps.length ? steps[steps.length - 1].n : 0
  let chosen = nearestFrameAtOrBefore(frames, selectedStep)

  /** 选步：借它之前最近的一帧（没有就显示「这一步没有取帧」）。 */
  const pickStep = (n) => { selectedStep = n; chosen = nearestFrameAtOrBefore(frames, n); render() }
  /** 选帧：步跟着跳到那一帧所属的步（左侧列表高亮跟着走）。 */
  const pickFrame = (at) => { chosen = at; selectedStep = frames[at].step; render() }

  const stepList = $('steps')
  for (const step of steps) {
    const row = el('div', 'step')
    const act = el('span', 'act'); act.textContent = String(step.n) + ' ' + step.action
    const arg = el('span', 'arg'); arg.textContent = ' ' + describe(step)
    const mark = el('span', 'mark'); mark.textContent = framesOfStep(step.n).length ? '  ▣' : ''
    row.append(act, arg, mark)
    row.onclick = () => pickStep(step.n)
    stepList.appendChild(row)
  }

  // —— 帧：翻页 ＋ 字格重绘 ——
  /** 此刻显示哪一帧：选中的那一帧；borrowed ＝ 它是**借**来的（本步没取帧）。 */
  function frameAt() {
    if (chosen < 0) return { frame: null, borrowed: false }
    const frame = frames[chosen]
    return { frame, borrowed: frame.step !== selectedStep }
  }

  function drawFrame(frame) {
    const screen = el('div', 'screen')
    for (let y = 0; y < frame.lines.length; y += 1) {
      const line = frame.lines[y]
      const wrap = el('div', 'line')
      const gut = el('span', 'gut'); gut.textContent = line.wrapped ? '↩' : ''
      const row = el('div', 'row')
      row.style.gridTemplateColumns = 'repeat(' + frame.columns + ', 1ch)'
      for (const [col, text, width, styleIndex] of line.runs) {
        const span = el('span')
        Object.assign(span.style, styleOf(frame.styles[styleIndex]))
        span.style.gridColumn = (col + 1) + ' / span ' + width
        span.textContent = text
        row.appendChild(span)
      }
      // 光标只在**看得见**时画（终端把它藏起来时，那里是隐藏光标的回退位）
      const caretCol = caretColumnAt(frame, y)
      if (caretCol >= 0) {
        const caret = el('span', 'cursor')
        caret.style.gridColumn = (caretCol + 1) + ' / span 1'
        row.appendChild(caret)
      }
      wrap.append(gut, row)
      screen.appendChild(wrap)
    }
    return screen
  }

  function render() {
    for (const node of stepList.children) node.classList.toggle('on', node.firstChild.textContent.startsWith(String(selectedStep) + ' '))
    const { frame, borrowed } = frameAt()
    const stage = $('stage')
    stage.textContent = ''
    // 翻不动的那一头，按钮就禁用（不是点了没反应）
    $('prev-frame').disabled = !canShift(frames, chosen, -1)
    $('next-frame').disabled = !canShift(frames, chosen, 1)
    if (!frame) { stage.textContent = '这一步没有取帧，之前也没有。'; $('pos').textContent = ''; $('framesize').textContent = ''; return }
    if (borrowed) {
      const note = el('p', 'note')
      note.textContent = '第 ' + selectedStep + ' 步没有取帧——显示它之前最近的一帧（第 ' + frame.step + ' 步 · ' + frame.label + '）。'
      stage.appendChild(note)
    }
    stage.appendChild(drawFrame(frame))
    $('pos').textContent = '第 ' + frame.step + ' 步 · 帧 ' + frame.n + ' / ' + frames.length + ' · ' + frame.label
    $('framesize').textContent = frame.columns + '×' + frame.rows + ' · ' + cursorNote(frame) + ' · 存档 ' + frame.scrollback + ' 行'
  }

  /** 沿全局帧序列翻一格（跨 capture——不是在当前那一步自己的帧里打转）。 */
  const moveFrame = (delta) => {
    if (!canShift(frames, chosen, delta)) return
    pickFrame(shiftFrame(frames, chosen, delta))
  }

  /** 沿步序列挪动（Shift ＋ ← →）：落到哪一步，就看它之前最近那一帧。 */
  const moveStep = (delta) => {
    if (steps.length === 0) return
    const at = steps.findIndex((step) => step.n === selectedStep)
    const next = steps[Math.min(Math.max(at + delta, 0), steps.length - 1)]
    if (next) pickStep(next.n)
  }

  $('prev-frame').onclick = () => moveFrame(-1)
  $('next-frame').onclick = () => moveFrame(1)
  addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') event.shiftKey ? moveStep(-1) : moveFrame(-1)
    if (event.key === 'ArrowRight') event.shiftKey ? moveStep(1) : moveFrame(1)
  })

  render()
})()
</script>
</body>
</html>
`
}
