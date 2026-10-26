/**
 * 命令分解 —— `exec` 的机械分析（U129 · 默认放行与禁止清单）。
 *
 * **默认放行**：未被禁止清单命中的命令不拦、不问。这一层只回答两件事：
 *
 * ```
 *   禁止   rm / shred / srm 那族（不可逆；回执指路 trash）· su（切换身份）
 *   专用   sudo —— 只接受单行短命令；形状合规的走 U129 的专用认证
 * ```
 *
 * 其余（改权限 / 属主 / ACL、覆盖、移动、破坏性 git、越界、外发、判不出来的）**一律放行**
 * ——真实边界交给操作系统与提示词那道软防线。
 *
 * ## 为什么 sudo 要在这里看形状
 *
 * 认证必须由代码完成（`sudo -S -v`，密码只写认证进程的 stdin）。模型给一条被 shell
 * 二次解释、或交给解释器/脚本执行的命令时，代码无法保证「认证的就是要执行的那一条」——
 * 故多行、`sh -c` / `bash -c`、here-doc、解释器或脚本一律**直接拒**，要求拆成多条短命令。
 *
 * 本域不碰文件系统：只看命令字面，不问文件是否存在、不解符号链接。
 */

import type { RefusalKind, SudoPlan } from '@magic/contracts'

// —— 词表 ——

/**
 * 删除那一族——**直接拒**，回执统一指路 `trash`（U129）。
 *
 * `shred` / `srm` 也在其中：U129 要求「`rm`／`shred`／`srm` 统一拒绝并提示改用 `trash`」。
 */
const DELETE = ['rm', 'rmdir', 'unlink', 'shred', 'srm', 'remove']

/** 切换用户——直接拒。 */
const SU = ['su']

/**
 * 包装词——跳过它们继续找真正的程序词（删除隔着包装也认得出）。
 *
 * `sudo` **不在这里**：它是 U129 的专用条目，要单独看形状与目标程序。
 */
const WRAPPERS = ['env', 'command', 'nohup', 'time', 'nice', 'stdbuf', 'setsid', 'ionice', 'exec', 'doas']

/** shell——`sudo sh -c ...` 这一类不接受（内层命令代码看不见）。 */
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']

/** 解释器 / 跑任意代码 / 包装命令——`sudo` 包住它们等于把要执行的东西藏起来。 */
const RUNNERS = [
  'node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'java',
  'awk', 'xargs', 'make', 'eval', 'source', 'env', 'nice', 'nohup', 'time',
  'stdbuf', 'setsid', 'ionice', 'exec', 'doas', 'open', 'osascript',
]

/** 看起来是脚本的扩展名（绝对路径也要认）。 */
const SCRIPT_EXT = /\.(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|py|rb|pl|php|js|mjs|cjs|ts|command)$/i

/** `sudo` 自己的旗标（`-S` / `-v` / `-k` 由代码固定使用，模型不许自己写）。 */
const SUDO_RESERVED = new Set([
  '-S', '--stdin',
  '-n', '--non-interactive',
  '-v', '--validate',
  '-k', '--reset-timestamp',
  '-K', '--remove-timestamp',
  '-i', '--login',
  '-s', '--shell',
  '-e', '--edit',
  '-l', '--list',
  '-b', '--background',
])

/** 带一个值的 `sudo` 旗标——解析目标程序时要连带跳过它的值。 */
const SUDO_VALUED = new Set([
  '-u', '--user',
  '-g', '--group',
  '-C', '--close-from',
  '-D', '--chdir',
  '-h', '--host',
  '-p', '--prompt',
  '-r', '--role',
  '-t', '--type',
  '-T', '--command-timeout',
  '-U', '--other-user',
  '-R', '--chroot',
])

// —— 记号与切段 ——

type Token =
  | { readonly kind: 'word'; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'redirect'; readonly target: string }
  | { readonly kind: 'dup' }

/** 一段命令（`&&` 等切开的单元）。 */
export type Segment = {
  /** 原样文本（材料显示用）。 */
  readonly raw: string
  readonly tokens: readonly Token[]
}

/** 切段 ＋ 分词——一遍扫完（引号内的分隔符不算分隔符）。 */
export function scan(command: string): readonly Segment[] {
  const segments: Segment[] = []
  let tokens: Token[] = []
  let word = ''
  let wordQuoted = false
  let quote: '"' | "'" | undefined
  let raw = ''
  let index = 0

  const flushWord = (): void => {
    if (word.length === 0 && !wordQuoted) return
    tokens.push({ kind: 'word', text: word, quoted: wordQuoted })
    word = ''
    wordQuoted = false
  }

  const flushSegment = (): void => {
    flushWord()
    if (tokens.length > 0) segments.push({ raw: raw.trim(), tokens })
    tokens = []
    raw = ''
  }

  while (index < command.length) {
    const char = command[index] ?? ''

    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        word += command[index + 1] ?? ''
        raw += char + (command[index + 1] ?? '')
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      else word += char
      raw += char
      index += 1
      continue
    }

    if (char === '\\' && index + 1 < command.length) {
      word += command[index + 1] ?? ''
      raw += char + (command[index + 1] ?? '')
      index += 2
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      wordQuoted = true
      raw += char
      index += 1
      continue
    }

    if (char === ' ' || char === '\t') {
      flushWord()
      raw += char
      index += 1
      continue
    }

    if (char === '\n' || char === ';') {
      flushSegment()
      index += 1
      continue
    }

    if (char === '|' || char === '&') {
      if (command[index + 1] === char) index += 1
      flushSegment()
      index += 1
      continue
    }

    if (char === '>') {
      const operatorAt = index
      if (command[index + 1] === '>') index += 1

      if (command[index + 1] === '&') {
        index += 2
        raw += command.slice(operatorAt, index)
        const targetAt = index
        while (index < command.length && /[\w-]/.test(command[index] ?? '')) index += 1
        raw += command.slice(targetAt, index)
        tokens.push({ kind: 'dup' })
        continue
      }

      index += 1
      raw += command.slice(operatorAt, index)
      while (command[index] === ' ' || command[index] === '\t') {
        raw += command[index] ?? ''
        index += 1
      }

      const targetAt = index
      let target = ''
      const targetQuote = command[index] === "'" || command[index] === '"' ? command[index] : undefined
      if (targetQuote !== undefined) {
        index += 1
        while (index < command.length && command[index] !== targetQuote) {
          target += command[index] ?? ''
          index += 1
        }
        index += 1
      } else {
        while (index < command.length && !/[\s;|&]/.test(command[index] ?? '')) {
          target += command[index] ?? ''
          index += 1
        }
      }
      raw += command.slice(targetAt, index)
      tokens.push({ kind: 'redirect', target })
      continue
    }

    word += char
    raw += char
    index += 1
  }

  flushSegment()
  return segments
}

// —— 逐段分析 ——

/** 一段的分析结论。 */
export type SegmentAnalysis = {
  readonly raw: string
  /** 去掉包装词之后真正的程序词（材料与判定共用的那一格）。 */
  readonly program: string | undefined
  /** 这一段要直接拒吗、理由是哪一条（U129）。 */
  readonly refusal: RefusalKind | undefined
  /** 拒的具体缘由（`sudo-unsupported` 时给出命中的那种写法）。 */
  readonly detail: string | undefined
  /** 形状合规的 sudo 短命令——认证与执行只认这一份。 */
  readonly sudo: SudoPlan | undefined
}

/** 命令替换 / 变量展开——它包住的命令代码看不见。 */
const UNRESOLVABLE = /\$\(|`|\$\{/

/** 取词数组（重定向目标不算参数）。 */
function words(tokens: readonly Token[]): readonly Extract<Token, { kind: 'word' }>[] {
  return tokens.filter((token): token is Extract<Token, { kind: 'word' }> => token.kind === 'word')
}

/** 程序名的基名——`/bin/rm` 与 `rm` 同一族。 */
function basename(program: string): string {
  const cut = program.lastIndexOf('/')
  return cut === -1 ? program : program.slice(cut + 1)
}

/** 找程序词——跳过 `FOO=bar` 赋值与包装词；`sudo` 不跳（专用条目）。 */
function findProgram(tokens: readonly Token[]): { program: string | undefined; from: number; sudo: boolean } {
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined || token.kind !== 'word') break
    const text = token.text

    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      index += 1
      continue
    }
    if (text === 'sudo') return { program: text, from: index, sudo: true }
    if (WRAPPERS.includes(text) && index + 1 < tokens.length) {
      index += 1
      continue
    }
    return { program: text, from: index, sudo: false }
  }

  return { program: undefined, from: index, sudo: false }
}

/** `find` 的删除旗标。 */
function findDeletes(args: readonly string[]): boolean {
  return args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir' || arg === '-ok')
}

/**
 * **sudo 形状检查**（U129）——合格给 `SudoPlan`，不合格给具体缘由。
 *
 * 只接受：整条命令就是一个 `sudo` 词开头的简单命令，目标不是 shell / 解释器 / 脚本。
 */
function checkSudo(segment: Segment, command: string): SegmentAnalysis {
  const text = command.trim()
  const refusal = (detail: string): SegmentAnalysis => ({
    raw: segment.raw,
    program: 'sudo',
    refusal: 'sudo-unsupported',
    detail,
    sudo: undefined,
  })

  if (text.includes('\n')) return refusal('命令含换行（多行）')
  if (text.includes('<<')) return refusal('命令含 here-doc')
  if (UNRESOLVABLE.test(text)) return refusal('命令含命令替换或变量展开')
  if (segment.tokens.some((token) => token.kind !== 'word')) return refusal('命令含重定向')

  const list = words(segment.tokens)
  const first = list[0]
  if (first === undefined || first.text !== 'sudo' || first.quoted) {
    return refusal('sudo 必须是命令的第一个词')
  }

  // 轮一遍 sudo 自己的旗标，找目标程序
  let index = 1
  let program: string | undefined
  while (index < list.length) {
    const token = list[index]!
    const text = token.text

    if (text === '--') {
      index += 1
      program = list[index]?.text
      break
    }
    if (text.startsWith('-') && text !== '-') {
      const [flag, attached] = text.includes('=') ? [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)] : [text, undefined]
      if (SUDO_RESERVED.has(flag) || SUDO_RESERVED.has(text)) return refusal(`命令自己写了 sudo 旗标 ${text}（该旗标由代码固定使用）`)
      if (SUDO_VALUED.has(flag)) {
        if (attached !== undefined) { index += 1; continue }
        index += 2
        continue
      }
      // 短旗标连写（`-uroot`）：值粘在后面
      if (text.length > 2 && SUDO_VALUED.has(text.slice(0, 2))) {
        index += 1
        continue
      }
      index += 1
      continue
    }
    program = text
    break
  }

  if (program === undefined) return refusal('sudo 后没有要执行的命令')

  const base = basename(program)
  if (SU.includes(base)) {
    return { raw: segment.raw, program: base, refusal: 'su', detail: undefined, sudo: undefined }
  }
  if (DELETE.includes(base) || (base === 'find' && findDeletes(list.slice(index + 1).map((one) => one.text)))) {
    return { raw: segment.raw, program: base, refusal: 'irreversible', detail: undefined, sudo: undefined }
  }
  if (SHELLS.includes(base)) return refusal(`sudo 包裹了 shell（${program}）`)
  if (RUNNERS.includes(base)) return refusal(`sudo 包裹了解释器或包装命令（${program}）`)
  if (base === 'sudo') return refusal('sudo 又包了一层 sudo')
  if (program.startsWith('./') || program.startsWith('../') || (program.includes('/') && !program.startsWith('/'))) {
    return refusal(`sudo 指向脚本或相对路径（${program}）`)
  }
  if (SCRIPT_EXT.test(program)) return refusal(`sudo 指向脚本（${program}）`)

  // 原样保留 sudo 之后的字符，只插入 `-n`——引号 / 通配 / 转义都不由这里重写。
  const run = text.replace(/^sudo(?=\s|$)/, 'sudo -n')
  return {
    raw: segment.raw,
    program: base,
    refusal: undefined,
    detail: undefined,
    sudo: { command: text, run, program: base },
  }
}

/** 一段命令 → 判定 ＋ 程序词 ＋ （如果是 sudo）认证与执行要的那一份。 */
function analyzeSegment(segment: Segment, command: string, sole: boolean): SegmentAnalysis {
  const { program, from } = findProgram(segment.tokens)
  const base = program === undefined ? undefined : basename(program)

  // `su` / 删除族隔着包装词也认得出（`sudo` 那一路在下面单独看形状，但它包住的
  // 目标也要先按禁止清单判——`sudo rm` / `sudo su` 不该弹密码组件）。
  if (base !== undefined && SU.includes(base)) {
    return { raw: segment.raw, program: base, refusal: 'su', detail: undefined, sudo: undefined }
  }
  if (base !== undefined && (DELETE.includes(base) || (base === 'find' && findDeletes(
    words(segment.tokens).slice(from + 1).map((one) => one.text),
  )))) {
    return { raw: segment.raw, program: base, refusal: 'irreversible', detail: undefined, sudo: undefined }
  }

  // `sudo` 是专用条目：只有「整条命令就是这一段」时才可能合格。
  if (base === 'sudo') {
    if (!sole) {
      return {
        raw: segment.raw, program: 'sudo', refusal: 'sudo-unsupported',
        detail: 'sudo 只接受单行短命令（命令里还有别的段）', sudo: undefined,
      }
    }
    return checkSudo(segment, command)
  }

  return { raw: segment.raw, program: base, refusal: undefined, detail: undefined, sudo: undefined }
}

/**
 * 命令 → 逐段分析。
 *
 * 空命令什么都不做，也不拦。
 */
export function decompose(command: string): readonly SegmentAnalysis[] {
  const segments = scan(command)
  if (segments.length === 0) {
    return [{ raw: command, program: undefined, refusal: undefined, detail: undefined, sudo: undefined }]
  }
  return segments.map((segment) => analyzeSegment(segment, command, segments.length === 1))
}
