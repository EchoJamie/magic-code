/**
 * **读系统剪贴板里的图**（U107）——终端那条路走不通，只能进程自己去问系统。
 *
 * ## 为什么不从终端拿
 *
 * 终端**没有标准通道**能把原始图像交给应用：`paste` 是**文本**通道（bracketed paste
 * 包着的也是文本），而 `Cmd+V` 那一下还被**终端自己**接走（ghostty 的默认配就是
 * `keybind = super+v=paste_from_clipboard`，应用根本收不到那一次按键）。所以同类产品
 * **都绕过终端、自己读系统剪贴板**——这条路与终端无关，换哪家终端都一样。
 *
 * ## 两条按序试（macOS）
 *
 * 1. **`pngpaste`**（装了才用）：`pngpaste -` 直接把 PNG 字节吐到 stdout。
 * 2. **`osascript` 兜底**（系统自带、零依赖）：走 AppKit 的 `NSPasteboard`。
 *
 * ⚠️ **osascript 的 stdout 拿不到原始二进制**，故第 2 条**必须落一个临时文件**
 * 再把文件读回来（这是这两条路的分别：第 1 条走管道，第 2 条走盘）。
 *
 * ## 为什么是 JavaScript 那一版 `osascript`（不是 AppleScript）
 *
 * 票面给的骨架是 AppleScript（`the clipboard as «class PNGf»`）。**实测两者都拿得到，
 * 但差一个数量级**——同一张 3.31 MiB 的真截图（`screencapture -c`）：
 *
 * | 走法 | 耗时 | 取回的东西 |
 * | --- | --- | --- |
 * | `osascript -e '<AppleScript>'` | **约 1930 ms** | 3 471 555 字节（一样） |
 * | `osascript -l JavaScript -e '<JXA>'` | **约 65 ms** | 3 471 555 字节（一样） |
 *
 * AppleScript 那一条慢在**老式数据强制转换**（`«class PNGf»` 要把整份数据在
 * descriptor 里搬一遍；stderr 上还带一句 `Error creating a JP2 color space`）。
 * 按一次键等两秒是用户看得见的卡，而这一条路**没有别的长处**——同样零依赖
 * （`osascript` 是同一个系统命令，只是换了个语言参数）、同样拿得到字节。故取 JXA。
 *
 * ## 两个实测踩到的坑（都写在这里，别再踩第二遍）
 *
 * ① **`$.NSBitmapImageRepFileTypePNG` 在 JXA 里取不到**（`undefined`）。拿它当类型传进
 *    `representationUsingTypeProperties` 是个**空操作**——返回的就是**原样那一份 TIFF**，
 *    既不报错也不 nil，于是「转换成功」而字节还是 TIFF，一路到「认图」那一步才炸。
 *    规范里的数值是 `NSBitmapImageFileTypePNG = 4`，**写死那个数**（下面 `PNG_TYPE`）。
 *
 * ② **不要用 `NSImage.initWithPasteboard` 那一版**（看着更省事：一步从剪贴板拿到图）。
 *    两个实测后果：**剪贴板里只有一个文件引用时它照样成功**（顺着那个路径把文件读进来
 *    画成图——「剪贴板里没有图」那一档因此报不出来，还平白多出一条读盘的路）；
 *    而且 **NSBitmapImageRep 的 PNG 编码器会把图放大到没法用**（同一张 3.31 MiB 截图
 *    重编码成 **81 MB**——越过任何上限）。故：**原件能拿就拿原件**，只在只有 TIFF 时
 *    才转一手。
 *
 * ## 判「有没有图」与「为什么没有」
 *
 * 一次调用同时判完，**不另开一趟**：`NSPasteboard.types` 为空＝剪贴板是空的，
 * 有类型却取不到图＝有东西但不是图。「空」与「只有文字」分开，是为了回执**说的是
 * 那件真事**（「剪贴板里只有文字」比「没有图」更像话）——两种都不是故障，是结果。
 *
 * ⚠️ **认的是系统声明的类型，不是「承诺的转换」**：`NSData dataForType:` 只认
 * 剪贴板**声明**的那几种（`clipboard info` 那种会列出 `«class PNGf»` 的**承诺**类型，
 * `dataForType` 拿不到——拿不到没关系，`public.tiff` 是声明了的，走那一支）。
 *
 * ## SSH 那条例外
 *
 * 读的是**跑这条命令那台机器**的剪贴板。magic 开在远端时，这里拿到的是**远端**的
 * （或者因为远端没有 osascript 而拿不到）——本机那一份过不来。这一条如实写进回执，
 * 不做「看起来能用」的兜底。
 *
 * ## 尺寸
 *
 * 本模块**只管把字节取回来**，不管它能不能送：上限与完整性是 `materials.ts` 那两把
 * 尺子的事（`imageBytesOf`，与按路径取图**同一处判据**）。在这里另立一套上限，
 * 就是同一个数在两地各写一遍。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一次剪贴板读取的产物——取到了字节，或者一句说给人听的缘由。 */
export type ClipboardImage =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string }

/**
 * `NSBitmapImageFileTypePNG` 的数值——**写死**（取坑 ① 见文件头注：JXA 里那个常量
 * 的名字取不到，传进去是个空操作，返回的是原样那一份字节）。
 */
const PNG_TYPE = 4

/**
 * 那一段 JXA——**一次调用**既取字节又分类失败。
 *
 * 三条出口，输出那一行是**给机器读的**：`OK:<字节数>` / `EMPTY` / `NOIMAGE:<条数>`。
 *
 * ⚠️ **那一行必须走 `NSFileHandle` 写 stdout**，不用 `console.log`：JXA 的
 * `console.log` 走的是 **stderr**（实测），而两条取图路（`pngpaste` 那条走管道）
 * 的读数得在**同一个通道**上。踩过一次的坏处很具体：进了失败那一支、话却是从
 * `stderr` 里捞出来拼的，屏上看着像成了 ——**假过长得跟真过一样**。
 *
 * 取字节的次序两件：**先拿原件**（`public.png` 就是原样的 PNG 字节——不重编码，
 * 于是同一张图两次贴、以及与 `@` 选进同一份文件，落的是同一个 blob）；
 * 拿不到原件才在**只有 TIFF / JPEG** 的那种剪贴板上转一手（macOS 给任何图像剪贴板
 * 都声明 `public.tiff`，故那一支也顺带兜住了 JPEG 那一类）。
 */
const JXA = (outPath: string): string => `
ObjC.import('AppKit')
ObjC.import('Foundation')
function say(line) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(line + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
}
var pb = $.NSPasteboard.generalPasteboard
var data = pb.dataForType('public.png')
if (data.isNil()) {
  var tiff = pb.dataForType('public.tiff')
  if (!tiff.isNil()) {
    var rep = $.NSBitmapImageRep.imageRepWithData(tiff)
    if (!rep.isNil()) data = rep.representationUsingTypeProperties(${PNG_TYPE}, $({}))
  }
}
if (data.isNil()) {
  var n = pb.types.isNil() ? 0 : Number(pb.types.count)
  say(n === 0 ? 'EMPTY' : 'NOIMAGE:' + n)
} else {
  data.writeToFileAtomically('${outPath}', true)
  say('OK:' + Number(data.length))
}
`

type Ran =
  | { readonly ok: true; readonly stdout: Buffer; readonly stderr: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 跑一条命令，按**字节**收 stdout——**不抛**：起不来（没装 / 没权限）也算一种结果。
 *
 * ⚠️ **一律 `Buffer`，不解码**：这条路上传的就是二进制，`toString()` 默认 UTF-8，
 * 任意字节序列都会被切坏。
 *
 * 退出码**不参与判定**：字面（`OK:` / `EMPTY` / `NOIMAGE:`）自己就够了，而有的
 * osascript 版本在取不到图时照样退 1——拿退出码判会把「剪贴板里没有图」误报成「坏了」。
 */
function run(command: string, args: readonly string[]): Promise<Ran> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, reason: reasonOf(error) })
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const done = (result: Ran): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    // `error`（ENOENT 那类）通常先于 `close` 到——两处各报一次是安全的，上面那道闸管着
    child.on('error', (error) => done({ ok: false, reason: reasonOf(error) }))
    child.on('close', () => done({ ok: true, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }))
  })
}

/**
 * 读剪贴板里的图——**本单对外的唯一入口**（见文件头注）。
 *
 * 顺序：`pngpaste`（装了才试）→ `osascript`（系统自带）。前一条没给出字节就往下走
 * ——**不留半份**（剪贴板没图时 `pngpaste` 退非零、stdout 为空，那一下不是结果）。
 */
export async function readClipboardImage(): Promise<ClipboardImage> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      reason: `这台机器（${process.platform}）上还取不了剪贴板里的图——这一条目前只做了 macOS。`,
    }
  }

  if (hasCommand('pngpaste')) {
    const got = await run('pngpaste', ['-'])
    if (got.ok && got.stdout.length > 0) return { ok: true, bytes: got.stdout }
    // 没吐字节 ⇒ **不当成失败**：交给下面那条说清楚是空的还是只有文本
  }

  // 落一个临时目录（一图一目录：读回来之后整棵删掉，不给下一个人留一串半截文件）
  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'magic-clipboard-'))
  } catch (error) {
    return { ok: false, reason: `腾不出一个临时位置来放这一张图：${reasonOf(error)}` }
  }

  const outPath = join(dir, 'clipboard.png')
  try {
    const got = await run('osascript', ['-l', 'JavaScript', '-e', JXA(outPath)])
    if (!got.ok) {
      return {
        ok: false,
        reason:
          `取不了剪贴板里的图：叫不动 macOS 自带的 osascript（${got.reason}）。` +
          `magic 若是开在远端机器上，读到的也是那台机器的剪贴板——本机这一份过不来。`,
      }
    }

    const said = got.stdout.toString('utf8').trim()
    if (said === 'EMPTY') return { ok: false, reason: '剪贴板是空的——先复制一张图，再按一次。' }
    if (said.startsWith('NOIMAGE')) {
      return {
        ok: false,
        reason: '剪贴板里没有图（只有文字或文件那一类）——复制一张图，或直接用 @ 引用一个图片文件。',
      }
    }
    if (!said.startsWith('OK:')) {
      return { ok: false, reason: `取剪贴板这一趟没成（osascript 说：${said || got.stderr.trim() || '没说话'}）。` }
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(outPath)
    } catch (error) {
      return { ok: false, reason: `剪贴板那一张没落到临时文件里：${reasonOf(error)}` }
    }

    if (bytes.length === 0) return { ok: false, reason: '剪贴板里那一张是空的（零字节）——换一张试试。' }

    return { ok: true, bytes }
  } finally {
    // 整棵删掉——这一趟**不留痕**（临时文件是我们自己造的，读回来就没用了）
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 删不掉不是用户的事（系统早晚会清 /tmp）
    }
  }
}

/** 一条命令在不在 PATH 上——`pngpaste` 是可选的（装了就少一趟 osascript，没装照走）。 */
function hasCommand(command: string): boolean {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '')
    .some((dir) => existsSync(join(dir, command)))
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
