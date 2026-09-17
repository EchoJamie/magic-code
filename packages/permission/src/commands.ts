/**
 * 命令分解 —— `exec` 的机械分析（技术方案 · 权限：危险分级——`exec` 按命令解析）。
 *
 * **判据归机械分析，不押模型自述**：命令是结构化的——切段（`&&` · `||` · `|` · `;` · 换行）、
 * 取程序词、对表归类、把路径词条比对工作区边界。**看不懂的形态一律入单**：
 * 命令替换 / 变量展开 / 包一层 shell（`bash -c`）/ 表外程序——判不出实际执行什么，
 * 按不可逆假定问。
 *
 * 本域不碰文件系统：这里只看**命令字面**，不问文件是否存在、不解符号链接。
 * 因此凡是需要「看文件才知道」的形态（`cp` 是否覆盖 · `mkdir` 是否已存在）一律按**从严**入单。
 *
 * 表是可维护物（技术方案 · 权限：危险分级维护——随用补充，漏判即按「看不懂」入单）：
 * 补一条＝在对应集合里加一个词。
 */

import type { DangerReason, PermissionContext } from '@magic/contracts'
import type { Landing } from './paths.ts'
import { landPath } from './paths.ts'

// —— 命令归类 ——

/**
 * 一条命令段的操作归类。
 *
 * `create` 与 `read` 是**放行区方向**（技术方案 · 权限：放行区——读与搜索 · 新建）；
 * 其余四类是必闸判据的机械落点；`unknown` ＝判不出（按不可逆假定问）。
 */
export type CommandOp =
  | 'read'
  | 'create'
  | 'delete'
  | 'overwrite'
  | 'move'
  | 'system'
  | 'outbound'
  | 'unknown'

/** 该归类给出的必闸判据（`undefined` ＝放行区方向）。 */
export const OP_REASON: Readonly<Record<CommandOp, 'irreversible' | 'system' | 'outbound' | 'unknown' | undefined>> = {
  read: undefined,
  create: undefined,
  delete: 'irreversible',
  overwrite: 'irreversible',
  move: 'irreversible',
  system: 'system',
  outbound: 'outbound',
  unknown: 'unknown',
}

/** 写类操作（越界判据只对它们生效——必闸清单：**工作区外的写 / 删 / 移**）。 */
export const WRITE_OPS: readonly CommandOp[] = ['create', 'delete', 'overwrite', 'move']

/** 归类的显示名（材料用——中文，给人看）。 */
export const OP_LABEL: Readonly<Record<CommandOp, string>> = {
  read: '只读',
  create: '新建',
  delete: '删除（不可逆）',
  overwrite: '覆盖 / 整写（不可逆）',
  move: '移动 · 重命名（不可逆）',
  system: '提权 · 系统',
  outbound: '外发（出去即收不回）',
  unknown: '判不出（按不可逆假定问）',
}

// —— 词表 ——

const DELETE = ['rm', 'rmdir', 'unlink', 'shred', 'remove']
const OVERWRITE = ['truncate', 'dd', 'tee', 'install', 'cp']
const MOVE = ['mv', 'rename', 'mmv']
const CREATE = ['mkdir', 'touch']
const SYSTEM = [
  'sudo', 'doas', 'su', 'chmod', 'chown', 'chgrp', 'chattr', 'chflags', 'setfacl',
  'systemctl', 'service', 'launchctl', 'scutil', 'defaults', 'diskutil', 'mount', 'umount',
  'apt', 'apt-get', 'dpkg', 'brew', 'yum', 'dnf', 'pacman', 'apk', 'snap', 'port',
  'shutdown', 'reboot', 'halt', 'kill', 'killall', 'pkill', 'useradd', 'userdel', 'usermod', 'passwd',
]
const OUTBOUND = ['ssh', 'scp', 'sftp', 'rsync', 'nc', 'netcat', 'telnet', 'ftp', 'curl', 'wget']
const READ_ONLY = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'fd', 'less', 'more', 'bat',
  'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'command',
  'file', 'stat', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'uniq', 'cut', 'tr', 'comm', 'join', 'diff', 'cmp', 'column', 'seq',
  'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'date', 'whoami', 'id', 'uname', 'hostname', 'printenv', 'locale', 'uptime', 'ps', 'top', 'free',
  'test', '[', 'true', 'false', 'jq', 'yq', 'sleep', 'man', 'history', 'alias',
] // `git` / `find` / `sed` / `sort` / `ln` 由子命令判据接管（同一个程序词，做什么看子命令）

/** 包装词——跳过它们继续找真正的程序词（`sudo` 是判据本身，不跳）。 */
const WRAPPERS = ['env', 'command', 'nohup', 'time', 'nice', 'stdbuf', 'setsid', 'ionice', 'exec']

/** 内层判不出的 shell——不递归解析（从严）。 */
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']

/** 跑任意代码的解释器 / 构建器——判不出到底跑了什么（从严）。 */
const RUNNERS = ['node', 'python', 'python3', 'deno', 'ruby', 'perl', 'php', 'java', 'xargs', 'make', 'awk', 'eval', 'source']

/**
 * 整写 / 交互式程序——**新建还是覆盖判不出**（与 `write` 同一处域内盲区：
 * 不碰文件系统就问不到存在性）。按不可逆假定问。
 */
const WHOLE_WRITE = ['nano', 'vi', 'vim', 'emacs', 'pico', 'ed', 'code']

// —— 记号与切段 ——

type Token =
  | { readonly kind: 'word'; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'redirect'; readonly append: boolean; readonly target: string; readonly fd: string | undefined }
  | { readonly kind: 'dup'; readonly fd: string | undefined; readonly target: string }

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
      if (char === quote) {
        quote = undefined
      } else {
        word += char
      }
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

    if (char === '|') {
      if (command[index + 1] === '|') index += 1
      flushSegment()
      index += 1
      continue
    }

    if (char === '&') {
      if (command[index + 1] === '&') index += 1
      flushSegment()
      index += 1
      continue
    }

    if (char === '>') {
      // 紧邻的数字前缀是文件描述符（`2>`），不是词
      const fd = /^\d+$/.test(word) && !wordQuoted ? word : undefined
      if (fd !== undefined) word = ''

      // `raw` 是材料里显示的**段文本**——喂给 `UNRESOLVABLE` 的也是它（见 `analyzeSegment`），
      // 故记号与目标必须原样回写：吞掉 `>&1` 会让分解显示成尾随一个 `2`，
      // 吞掉重定向目标则会让目标里的命令替换躲过「判不出」。
      const operatorAt = index
      const append = command[index + 1] === '>'
      if (append) index += 1

      if (command[index + 1] === '&') {
        // 复制描述符（`2>&1`）——不是文件写入
        index += 2
        raw += command.slice(operatorAt, index)

        const targetAt = index
        while (index < command.length && /[\w-]/.test(command[index] ?? '')) index += 1
        const target = command.slice(targetAt, index)
        raw += target

        tokens.push({ kind: 'dup', fd, target })
        continue
      }

      index += 1
      raw += command.slice(operatorAt, index) // `>` / `>>`
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
      raw += command.slice(targetAt, index) // 目标原样（引号一并保留）

      tokens.push({ kind: 'redirect', append, target, fd })
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
  readonly program: string | undefined
  readonly op: CommandOp
  /**
   * 归类之外的**附加判据**——一段命令可以同时命中多条（清单里都是必闸：
   * `git push --force` ＝ 外发 ＋ 不可逆；看不懂的形态与看得懂的并列报，不藏）。
   */
  readonly extra: readonly DangerReason[]
  /** 写类操作的路径词条（只读类不做越界判定——必闸清单的越界条目限「写 / 删 / 移」）。 */
  readonly landings: readonly Landing[]
  /** 判不出的缘由（材料用）。 */
  readonly notes: readonly string[]
}

/** git 强推旗标（技术方案 · 必闸清单：`push --force`）。 */
const GIT_FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes']

/** 子命令型程序——操作数是**名字**（分支 / 包 / 容器），不作路径取。 */
const NAME_OPERAND_PROGRAMS = [
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'gh', 'pip', 'pip3', 'gem', 'cargo', 'go',
]

/** 命令替换 / 变量展开——实际执行的命令判不出。 */
const UNRESOLVABLE = /\$\(|`|\$\{/

/** 找程序词——跳过 `FOO=bar` 赋值与包装词；`sudo` 是判据本身（分类另有去处）。 */
function findProgram(tokens: readonly Token[]): { program: string | undefined; from: number } {
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined || token.kind !== 'word') break
    const text = token.text

    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      index += 1
      continue
    }
    if (WRAPPERS.includes(text) && index + 1 < tokens.length) {
      index += 1
      continue
    }
    return { program: text, from: index }
  }

  return { program: undefined, from: index }
}

/** 词表归类（表外＝`unknown`）。 */
function byTable(program: string): CommandOp | undefined {
  if (DELETE.includes(program)) return 'delete'
  if (MOVE.includes(program)) return 'move'
  if (OVERWRITE.includes(program)) return 'overwrite'
  if (CREATE.includes(program)) return 'create'
  if (SYSTEM.includes(program)) return 'system'
  if (OUTBOUND.includes(program)) return 'outbound'
  if (READ_ONLY.includes(program)) return 'read'
  return undefined
}

/** 子命令型工具（同一个程序词，做什么看子命令）。 */
function bySubcommand(program: string, args: readonly string[]): CommandOp | undefined {
  const sub = args.find((arg) => !arg.startsWith('-'))

  switch (program) {
    case 'git':
      return gitOp(sub, args)
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return packageOp(sub, args)
    case 'docker':
      if (sub === 'push') return 'outbound'
      if (sub === 'ps' || sub === 'images' || sub === 'version' || sub === 'inspect' || sub === 'logs') return 'read'
      return 'unknown'
    case 'gh':
      if (sub === 'release' || sub === 'pr' || sub === 'issue') return 'outbound'
      return 'unknown'
    case 'pip':
    case 'pip3':
    case 'gem':
      if (sub === 'install' || sub === 'uninstall') return 'system'
      if (sub === 'list' || sub === 'show' || sub === 'freeze') return 'read'
      return 'unknown'
    case 'cargo':
      if (sub === 'install' || sub === 'uninstall') return 'system'
      if (sub === 'publish') return 'outbound'
      return 'unknown'
    case 'go':
      if (sub === 'install' || sub === 'get') return 'system'
      if (sub === 'version' || sub === 'env' || sub === 'list') return 'read'
      return 'unknown'
    case 'find':
      // 删除是 `find` 的旗标，不是程序词
      return args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir' || arg === '-ok')
        ? 'delete'
        : 'read'
    case 'sed':
      return args.some((arg) => arg === '-i' || arg.startsWith('-i')) ? 'overwrite' : 'read'
    case 'sort':
      return args.some((arg) => arg === '-o' || arg === '--output' || arg.startsWith('--output=')) ? 'overwrite' : 'read'
    case 'ln':
      return args.some((arg) => arg.startsWith('-') && arg.includes('f')) ? 'overwrite' : 'create'
    default:
      return undefined
  }
}

/** git 子命令判据（技术方案 · 必闸清单：reset --hard · clean -fd · push --force · branch -D · 改写已推送历史）。 */
function gitOp(sub: string | undefined, args: readonly string[]): CommandOp {
  switch (sub) {
    case 'push':
      return 'outbound'
    case 'reset':
      return args.some((arg) => arg === '--hard' || arg === '--merge' || arg === '--keep') ? 'overwrite' : 'unknown'
    case 'clean':
      return args.some((arg) => arg.startsWith('-') && arg.includes('f')) ? 'delete' : 'read'
    case 'branch':
    case 'tag':
      return args.some((arg) => /^-[dDmM]$/.test(arg)) ? 'delete' : 'read'
    case 'rebase':
    case 'filter-branch':
      return 'overwrite'
    case 'restore':
    case 'revert':
    case 'cherry-pick':
      return 'overwrite'
    case 'checkout':
      return args.includes('--') || args.some((arg) => arg === '.') ? 'overwrite' : 'unknown'
    case 'stash':
      return args.some((arg) => arg === 'drop' || arg === 'clear') ? 'delete' : 'unknown'
    case 'commit':
      return args.some((arg) => arg === '--amend') ? 'overwrite' : 'unknown'
    case 'worktree':
      return args.some((arg) => arg === 'remove' || arg === 'prune') ? 'delete' : 'unknown'
    case 'gc':
    case 'prune':
    case 'reflog':
      return args.some((arg) => arg.includes('expire') || arg.includes('prune')) ? 'delete' : 'read'
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'remote':
    case 'describe':
    case 'blame':
    case 'rev-parse':
    case 'ls-files':
    case 'grep':
    case 'cat-file':
    case 'shortlog':
    case 'whatchanged':
    case 'config':
    case 'init':
    case 'add':
      return 'read'
    default:
      return 'unknown'
  }
}

/**
 * 包管理器的子命令判据——装卸软件包＝系统级；发布＝外发；其余判不出。
 *
 * 「跑脚本」（`npm run` · `bun test`）一律入「看不懂」：跑的是任意代码，内容域内判不出。
 * 本地 `install` 亦然——写 `node_modules` 之外还会跑 `postinstall` 脚本。
 */
function packageOp(sub: string | undefined, args: readonly string[]): CommandOp {
  const global = args.some((arg) => arg === '-g' || arg === '--global')

  switch (sub) {
    case 'publish':
      return 'outbound'
    case 'install':
    case 'i':
    case 'add':
    case 'uninstall':
    case 'remove':
    case 'rm':
    case 'link':
    case 'unlink':
      return global ? 'system' : 'unknown'
    case 'list':
    case 'ls':
    case 'view':
    case 'outdated':
    case 'why':
    case 'audit':
    case 'help':
      return 'read'
    default:
      return 'unknown'
  }
}

/** 一段命令 → 归类 ＋ 路径词条 ＋ 判不出的缘由。 */
function analyzeSegment(segment: Segment, ctx: PermissionContext): SegmentAnalysis {
  const notes: string[] = []
  const extra: DangerReason[] = []

  // 命令替换 / 变量展开——实际执行什么判不出（从严）；看得懂的部分照报，两条并列
  if (UNRESOLVABLE.test(segment.raw)) {
    notes.push('含命令替换 / 变量展开——实际执行的命令判不出')
    extra.push('unknown')
  }

  const { program, from } = findProgram(segment.tokens)
  const args = segment.tokens
    .slice(from + 1)
    .filter((token): token is Extract<Token, { kind: 'word' }> => token.kind === 'word')
    .map((token) => token.text)

  // 强推既外发又不可逆（必闸清单两条同中）
  if (program === 'git' && args[0] === 'push' && args.some((arg) => GIT_FORCE_FLAGS.includes(arg))) {
    extra.push('irreversible')
  }

  let owned: CommandOp
  if (program === undefined) {
    owned = 'unknown'
    notes.push('取不到程序词')
  } else if (SHELLS.includes(program)) {
    owned = 'unknown'
    notes.push('包了一层 shell——内层命令判不出')
  } else if (RUNNERS.includes(program)) {
    owned = 'unknown'
    notes.push('跑的是任意代码 / 脚本——内容判不出')
  } else if (WHOLE_WRITE.includes(program)) {
    owned = 'unknown'
    notes.push('整写 / 交互式程序——新建还是覆盖判不出')
  } else {
    const sub = bySubcommand(program, args)
    const table = byTable(program)
    owned = sub ?? table ?? 'unknown'
    if (sub === undefined && table === undefined) notes.push(`程序「${program}」不在分析表内`)
  }

  // 重定向即写入（`2>/dev/null` 与描述符复制不算——丢弃不是覆盖）；
  // 它是**确凿**的覆盖证据——比「判不出」具体，故把放行区方向与 unknown 一并提级
  const writes = segment.tokens.filter(
    (token): token is Extract<Token, { kind: 'redirect' }> =>
      token.kind === 'redirect' && token.target !== '/dev/null',
  )
  const redirected = writes.length > 0 && (owned === 'read' || owned === 'create' || owned === 'unknown')
  const op: CommandOp = redirected ? 'overwrite' : owned

  // 写类操作的路径词条（工作区外的写 / 删 / 移＝必闸）
  const landings: Landing[] = []
  if (WRITE_OPS.includes(op)) {
    const operands = segment.tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token, index }) => token.kind === 'word' && index !== from)
      .map(({ token }) => (token as Extract<Token, { kind: 'word' }>).text)
      .filter((text) => !text.startsWith('-') && text.length > 0)

    // 重定向目标**永远是**路径（字面写明的那个文件）；命令的操作数要看程序族的形态
    const candidates = [...operandsOf(program, operands, redirected), ...writes.map((token) => token.target)]

    for (const text of candidates) landings.push(landPath(text, ctx))
  }

  return { raw: segment.raw, program, op, extra, landings, notes }
}

/**
 * 操作数里哪些算路径 —— **误报比缺报更坏**：材料里出现一条假影响面，人就照着假的东西批。
 *
 * 三种形态：
 * - **子命令型**（`git` · `npm` · `docker` …）——操作数是**名字**（分支 / 包 / 容器），不是路径；
 * - **`sed` 首参**是脚本 · **`find` 首参**是搜索根（其余是模式）——各取各的；
 * - **重定向提级**的段（程序本身不写）——操作数是**正文**（`echo hi > f` 的 `hi`），不是路径。
 */
function operandsOf(
  program: string | undefined,
  operands: readonly string[],
  redirected: boolean,
): readonly string[] {
  if (redirected) return [] // 程序本身不是写类——位置参是正文
  if (program === undefined) return []

  // 判不出的段（命令替换 / 变量展开）：连碰了哪些文件都说不清——一律不报，只报「判不出」
  if (operands.some((text) => UNRESOLVABLE.test(text))) return []

  if (NAME_OPERAND_PROGRAMS.includes(program)) return []
  if (program === 'sed') return operands.slice(1)
  if (program === 'find') return operands.slice(0, 1)

  return operands
}

/**
 * 命令 → 逐段分析（材料与判据的共同来源）。
 */
export function decompose(command: string, ctx: PermissionContext): readonly SegmentAnalysis[] {
  const segments = scan(command)
  if (segments.length === 0) {
    return [
      {
        raw: command,
        program: undefined,
        op: 'unknown',
        extra: [],
        landings: [],
        notes: ['空命令——没有可分析的段'],
      },
    ]
  }
  return segments.map((segment) => analyzeSegment(segment, ctx))
}
