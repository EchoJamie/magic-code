/**
 * 命令分解 —— `exec` 的机械分析（技术方案 · 权限：危险分级——`exec` 按命令解析）。
 *
 * **判据归机械分析，不押模型自述**：命令是结构化的——切段（`&&` · `||` · `|` · `;` · 换行）、
 * 取程序词、对表归类、把路径词条比对工作区边界。
 *
 * ## 名单只剩一条 ＋ 删除那一类"直接拒"（U77 · 2026-09-25 用户定）
 *
 * **要用户明确授权的只剩一类**（设计 · 工具执行与权限「危险命令名单：收缩到两条」＋
 * 同篇「`rm` 直接拒，指路 `trash`」）：
 *
 * ```
 *   要授权   改权限 / 属主 / 属性 / ACL   chmod · chown · chgrp · chattr · chflags · setfacl
 *   直接拒   删除                        rm 那族（含 -r / -f / -rf）＋ find 的 -delete ＋ shred / srm
 * ```
 *
 * ⚠️ **删除那一类**从"要授权"整类移出——它**不问、直接拒**（拒的理由是**这一类不可逆**，
 * 不是"你该问我"）。回执里要告诉模型**该用什么**（`trash`）；`shred` / `srm` 除外
 * （它们要的就是不可逆 ⇒ **不给替代**）。见 `REFUSAL_OF`。
 *
 * **其余一律默认通**——移动 / 重命名 · 覆盖 · 破坏性 git · `sudo` 那类 · 越界 · 外发 ·
 * `trash` · **以及判不出来的**（命令替换 / 变量展开 / 包一层 shell / 表外程序 / 跑任意代码）——
 * **靠提示词要求模型自己小心**（那是一道**软防线**，设计已认下：模型可以不听）。
 *
 * ⇒ 本文件的表回答**三件事**：这一段**在不在名单里**（`OP_REASON`）、**它在干什么**
 * （`OP_LABEL`，给卡上读）、以及**删除那一类怎么处置**（`REFUSAL_OF`）。
 * **不在名单里 ≠ 判不出**：`mv` 我们知道它是移动，它只是不再需要授权而已。
 *
 * ⚠️ **删除那一格的 `OP_REASON` 现在只说"它为什么出格"**（不可逆），**不再表示"要问"**
 * ——处置归 `REFUSAL_OF` 那一处。两件事分开之后，`OP_REASON` 仍是"判据"，
 * 只是「重」的那一档现在只剩改权限那一类。
 *
 * ⚠️ **判不出来按默认通**（同日用户定）：**它不是一条命令名**，是「读不懂」——
 * 而这一层控的是「**明确危险的**」，读不懂不在那一条里。**代价已认：这一档不再有兜底。**
 *
 * ⚠️ **`sudo` 那类（要交互输入的命令）不靠闸门拦**——沙箱不喂宿主 stdin（`exec.ts` 的
 * `stdin: 'ignore'`）⇒ 它们当场得 EOF、**不悬着**。故 `sudo` / `doas` 在这一版里是
 * **包装词**（跳过它继续找真正的程序词）：`sudo rm -rf x` 里那段 `rm` **照落名单**,
 * 而 `sudo ls` 这类照旧不问。
 *
 * 本域不碰文件系统：这里只看**命令字面**，不问文件是否存在、不解符号链接。
 * 因此凡是需要「看文件才知道」的形态（`cp` 是否覆盖 · `mkdir` 是否已存在）本域**判不出**
 * ——判不出即默认通（上面那一条），但**影响面词条照给**（材料要说得清它动了哪儿）。
 *
 * 表是可维护物（技术方案 · 权限：危险分级维护——随用补充）：补一条＝在对应集合里加一个词。
 */

import type { DangerReason, PermissionContext, RefusalKind } from '@magic/contracts'
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

/**
 * 该归类给出的**判据**（`undefined` ＝ 这一格给不出判据）。
 *
 * ⚠️ **`undefined` 不再是「放行区方向」那一半白名单**——它是**默认**：不在名单里就通，
 * 与「它是什么」无关（设计 · 权限「默认是通；这一层控的是「禁止」」）。
 * 表上给得出判据的只有两格：
 *
 * - `delete` → 不可逆（`rm` 那族）——⚠️ **U77 起它不再表示"要问"**：删除那一类
 *   **直接拒**（处置归 `SegmentAnalysis.refusal`，见文件头注）。这一格留着，是因为
 *   「为什么这一段出格」仍要说得出来（材料末尾那行 `判据：`）；
 * - `system` → 系统级（**只有**改权限 / 属主 / 属性 / ACL 那一族产出它，见 `PERMISSION`）
 *   ——**名单里只剩这一格要问**。
 *
 * ⚠️ **其余几格一律 `undefined`**：覆盖 · 移动 · 外发 · 判不出都**不在名单里**——
 * 后两类（外发 · 判不出）**不是"我们放行了"，是"这一层不再管它"**
 * （软防线，见文件头注）。`system` 这一格因此不可以再被别的东西产出
 * （包管理器的全局安装等一律归 `unknown`）——否则它们会顺着这一格**偷偷回到闸门里**。
 */
export const OP_REASON: Readonly<Record<CommandOp, DangerReason | undefined>> = {
  read: undefined,
  create: undefined,
  delete: 'irreversible',
  overwrite: undefined,
  move: undefined,
  system: 'system',
  outbound: undefined,
  unknown: undefined,
}

/**
 * 会动盘的操作——**影响面词条只对它们取**（材料要给得出「它动了哪儿」）。
 *
 * ⚠️ **与「入不入名单」是两件事**（U76 起）：这几类**都不在名单里**了，
 * 但卡上仍要说清 `mv` 挪了哪些路径——材料是给人的判断依据，闸门放不放是另一回事。
 */
export const WRITE_OPS: readonly CommandOp[] = ['create', 'delete', 'overwrite', 'move']

/**
 * 归类的显示名（材料用——中文，给人看）。
 *
 * ⚠️ **只有入名单的那两格才带判断的口气**（`删除（不可逆）` · `改权限…`）：
 * 其余几格是**描述**，不是"为什么拦你"——「为什么问」由材料末尾那一行 `判据：` 说
 * （见 `analyze.ts` 的 `renderDecomposition`）。别把「（不可逆）」这类尾巴再加回描述上：
 * 那会让人以为 `mv` 也在名单里。
 */
export const OP_LABEL: Readonly<Record<CommandOp, string>> = {
  read: '只读',
  create: '新建',
  delete: '删除（不可逆）',
  overwrite: '覆盖 / 整写',
  move: '移动 · 重命名',
  system: '改权限 · 属主 · 属性 / ACL（不可逆）',
  outbound: '外发',
  unknown: '不在名单里（默认通）',
}

// —— 词表 ——

/**
 * **删除那一类**（`rm` 那族 ＋ `find` 的 `-delete`）——U77 起**归"直接拒"，不归"问"**。
 *
 * 处置见 `REFUSAL_OF`：拒的理由是**这一类不可逆**，且**回执要告诉模型用什么**
 * （设计 · 权限「`rm` 直接拒，指路 `trash`」）。
 *
 * `shred` / `srm` 也在这张表里——它们**照样拒**，只是**拒的理由不同**
 * （它要的就是不可逆 ⇒ 回执不给替代）。收在同一张表里是因为「认得出它是删除」
 * 是同一件事；**怎么处置**由 `REFUSAL_OF` 分。
 */
const DELETE = ['rm', 'rmdir', 'unlink', 'shred', 'srm', 'remove']

/**
 * 删除那一族里**没有替代**的那两件——`shred` / `srm`（设计明文：它的意图就是不可逆，
 * **不许换个更弱的做法糊过去**，回执也**不必给替代**）。
 *
 * 其余几件（`rm` / `rmdir` / `unlink` / `remove` / `find -delete`）**不可逆但有替代**
 * （`trash`：进废纸篓、能捞回）⇒ 回执指路。
 */
const NO_SUBSTITUTE = ['shred', 'srm']
const OVERWRITE = ['truncate', 'dd', 'tee', 'install', 'cp']
const MOVE = ['mv', 'rename', 'mmv']
const CREATE = ['mkdir', 'touch']

/**
 * **名单第二类 · 改权限 / 属主 / 属性 / ACL**——判据**按类收，不按名字收**。
 *
 * 这一格是 `SYSTEM` 那张老表**收缩**出来的那一半（U76）：`sudo` · `brew` · `kill` ·
 * `systemctl` · `shutdown` 那一大串**不在名单里了**（默认通）。同族将来多一件，
 * 照**口径**（改权限 / 属主 / 属性 / ACL）收进来即可，判据本身不动。
 */
const PERMISSION = ['chmod', 'chown', 'chgrp', 'chattr', 'chflags', 'setfacl']
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

/**
 * 包装词——跳过它们继续找真正的程序词。
 *
 * ⚠️ **`sudo` / `doas` 在这一版里是包装词**（U76 起，此前是"判据本身"）。
 * 由头：它们**不再是名单里的一类**（`sudo` 那类默认通，设计明文），而名单里
 * **删除**那一条要的是「按类看这一段做了什么」——`sudo rm -rf x` 里那段 `rm`
 * **得看得出来**（否则一个 `sudo` 前缀就把删除藏过去了）。
 *
 * ⚠️ **限度**（如实记）：它们自己的旗标**跳不过去**——`sudo -u root rm x` /
 * `nice -n 10 rm x` 里程序词读成 `-u` / `-n` 后面的那个词 ⇒ 归「判不出」⇒
 * **默认通**（旧行为下这里读成「系统级」而多问一次；U76 起它变成不问）。
 * 本单没动旗标那一层（那要给每个包装词配一张旗标表，是开不完的清单）。
 * 常见的 `sudo rm -rf x`（不带旗标）**照落名单**。
 *
 * `su` 不在此列：它的形制是 `su 用户` 之后进交互（`-c` 那条路本域读不出内层命令），
 * 而它**要密码 ⇒ 当场得 EOF**（沙箱 `stdin: 'ignore'`），与设计给的那条兜底一致。
 */
const WRAPPERS = ['env', 'command', 'nohup', 'time', 'nice', 'stdbuf', 'setsid', 'ionice', 'exec', 'sudo', 'doas']

/** 内层判不出的 shell——不递归解析（判不出 ⇒ 默认通，但**缘由要说得出**）。 */
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']

/** 跑任意代码的解释器 / 构建器——判不出到底跑了什么（同上：判不出，但有话要说）。 */
const RUNNERS = ['node', 'python', 'python3', 'deno', 'ruby', 'perl', 'php', 'java', 'xargs', 'make', 'awk', 'eval', 'source']

/**
 * 整写 / 交互式程序——**新建还是覆盖判不出**（与 `write` 同一处域内盲区：
 * 不碰文件系统就问不到存在性）。判不出 ⇒ 默认通。
 *
 * ⚠️ 它们同时是**要交互输入**的那一类（`vim` 要一个终端）——沙箱 `stdin: 'ignore'`
 * ⇒ 当场得 EOF、不悬着（见文件头注那条）。
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
   * **这一段要"直接拒"吗、理由是哪一条**（U77）——`undefined` ＝ 不拒（问 ／ 通）。
   *
   * 只有删除那一族产出它，两支在 `REFUSAL_OF` 那一处说明。**逐段判**（与 `op` 同源）：
   * `cd x && rm -rf y` 里那段 `rm` 照落拒，`cd x` 不落。
   */
  readonly refusal: RefusalKind | undefined
  /** 会动盘的路径词条（`WRITE_OPS` 那几类取，其余不取——材料要给得出「它动了哪儿」）。 */
  readonly landings: readonly Landing[]
  /** 判不出的缘由（材料用）。 */
  readonly notes: readonly string[]
}

/** 子命令型程序——操作数是**名字**（分支 / 包 / 容器），不作路径取。 */
const NAME_OPERAND_PROGRAMS = [
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'gh', 'pip', 'pip3', 'gem', 'cargo', 'go',
]

/** 命令替换 / 变量展开——实际执行的命令判不出。 */
const UNRESOLVABLE = /\$\(|`|\$\{/

/** 找程序词——跳过 `FOO=bar` 赋值与包装词（含 `sudo` / `doas`，见 `WRAPPERS`）。 */
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

/** 词表归类（表外＝`unknown`——**不在名单里，不是判不出**，见文件头注）。 */
function byTable(program: string): CommandOp | undefined {
  if (DELETE.includes(program)) return 'delete'
  if (PERMISSION.includes(program)) return 'system'
  if (MOVE.includes(program)) return 'move'
  if (OVERWRITE.includes(program)) return 'overwrite'
  if (CREATE.includes(program)) return 'create'
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
    // ⚠️ **装东西不再归 `system`**（U76）——`system` 那一格现在只由**改权限 / 属主 /
    // 属性 / ACL**产出（见 `PERMISSION`）。归它＝顺着那一格偷偷回到闸门里：装软件包
    // 不在名单里（设计：`sudo` 那类 · 跑别人的代码都默认通），故它们一律 `unknown`。
    case 'pip':
    case 'pip3':
    case 'gem':
      if (sub === 'list' || sub === 'show' || sub === 'freeze') return 'read'
      return 'unknown'
    case 'cargo':
      if (sub === 'publish') return 'outbound'
      return 'unknown'
    case 'go':
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

/**
 * git 子命令判据——**判据留给"这一段在干什么"（材料用），不再有一格入名单**。
 *
 * ⚠️ **破坏性 git 默认通**（U76 · 设计明文：`reset --hard` · `clean -fd` · `branch -D` ·
 * 改写已推送历史那一整串都在「其余」里）。故它们**不再归 `delete`**——
 * `delete` 那一格是名单里的**删除**（`rm` 那类），git 的破坏性子命令**不是**它。
 *
 * ⚠️ **别把它们改回 `delete`**：那等于顺着 `OP_REASON` 那一格**偷偷把软防线做成硬拦**
 * （工单明写不许）。工单那一版里它们曾按 `delete` / `overwrite` 入单——U76 起不是了；
 * 这一整串的防线改走**提示词**（要求模型自己小心）。
 *
 * 强推（`--force` 那几件）同理：旧版额外报一条「不可逆」，U76 起不再报——它是破坏性 git。
 */
function gitOp(sub: string | undefined, args: readonly string[]): CommandOp {
  switch (sub) {
    case 'push':
      return 'outbound'
    // 破坏性的那几形（`reset --hard` · `stash drop` · `worktree remove`）**一律 `unknown`**：
    // 它们不在名单里，而"不在名单里"正是这一格要说的话——别给它们编一个更吓人的名字。
    case 'reset':
    case 'stash':
    case 'worktree':
      return 'unknown'
    case 'clean':
      // `-f` 才是真删（不带＝干跑）——但**两形都不在名单里**，差的只是材料上那句话
      return args.some((arg) => arg.startsWith('-') && arg.includes('f')) ? 'unknown' : 'read'
    case 'branch':
    case 'tag':
      // `-d` / `-D` 是删（`-m` / `-M` 是改名）——同样两形都不在名单里
      return args.some((arg) => /^-[dDmM]$/.test(arg)) ? 'unknown' : 'read'
    case 'rebase':
    case 'filter-branch':
      return 'overwrite'
    case 'restore':
    case 'revert':
    case 'cherry-pick':
      return 'overwrite'
    case 'checkout':
      return args.includes('--') || args.some((arg) => arg === '.') ? 'overwrite' : 'unknown'
    case 'commit':
      return args.some((arg) => arg === '--amend') ? 'overwrite' : 'unknown'
    case 'gc':
    case 'prune':
    case 'reflog':
      return args.some((arg) => arg.includes('expire') || arg.includes('prune')) ? 'unknown' : 'read'
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
 * 包管理器的子命令判据——**装卸软件包不在名单里**（U76：`system` 那一格不再由它产）；
 * 发布＝外发；其余判不出。
 *
 * 「跑脚本」（`npm run` · `bun test`）一律入「看不懂」：跑的是任意代码，内容域内判不出。
 * 本地 `install` 亦然——写 `node_modules` 之外还会跑 `postinstall` 脚本。
 *
 * ⚠️ **全局安装（`-g`）曾经单列成"系统级"**——U76 起**不列了**：装软件包
 * （`npm i -g` · `pip install` · `brew install`）都不在名单里（设计：「跑别人的代码」
 * 本身不算危险，靠模型先读那一眼）。
 */
function packageOp(sub: string | undefined, _args: readonly string[]): CommandOp {
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
      return 'unknown'
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

  // 命令替换 / 变量展开——实际执行什么判不出（⇒ 默认通）；**但缘由要说得出**
  // （材料上照报一条，看得懂的部分也照报，两条并列，不藏）
  if (UNRESOLVABLE.test(segment.raw)) {
    notes.push('含命令替换 / 变量展开——实际执行的命令判不出')
  }

  const { program, from } = findProgram(segment.tokens)
  const args = segment.tokens
    .slice(from + 1)
    .filter((token): token is Extract<Token, { kind: 'word' }> => token.kind === 'word')
    .map((token) => token.text)

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
  // 它是**确凿**的覆盖证据——比「判不出」具体，故把只读方向与 unknown 一并提级。
  // ⚠️ 提级到 `overwrite` 只影响**材料怎么说**（那几格都不在名单里）。
  const writes = segment.tokens.filter(
    (token): token is Extract<Token, { kind: 'redirect' }> =>
      token.kind === 'redirect' && token.target !== '/dev/null',
  )
  const redirected = writes.length > 0 && (owned === 'read' || owned === 'create' || owned === 'unknown')
  const op: CommandOp = redirected ? 'overwrite' : owned

  // **删除那一类：不是"问"，是"直接拒"**（U77）——理由按程序词分两支（见 `REFUSAL_OF`）。
  // ⚠️ **按 `op` 判、不按 `owned`**：重定向提级只把 read/create/unknown 提成 overwrite，
  // 删除**提不动**（那一支压根不含 `delete`）——故两处读的是同一个结论。
  const refusal = op === 'delete' ? REFUSAL_OF(program) : undefined

  // 会动盘的操作取路径词条（材料要给得出「它动了哪儿」——入不入名单是另一回事）
  const landings: Landing[] = []
  if (WRITE_OPS.includes(op)) {
    // ⚠️ **只取程序词之后的**（`index > from`，不是 `!==`）：程序词之前那些是
    // 包装词与 `FOO=bar` 赋值——**它们不是路径**。收进来就会在材料上多一条假影响面
    // （`sudo rm -rf x` 曾把 `sudo` 报成 /work/proj/sudo），而"误报比缺报更坏"。
    const operands = segment.tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token, index }) => token.kind === 'word' && index > from)
      .map(({ token }) => (token as Extract<Token, { kind: 'word' }>).text)
      .filter((text) => !text.startsWith('-') && text.length > 0)

    // 重定向目标**永远是**路径（字面写明的那个文件）；命令的操作数要看程序族的形态
    const candidates = [...operandsOf(program, operands, redirected), ...writes.map((token) => token.target)]

    for (const text of candidates) landings.push(landPath(text, ctx))
  }

  return { raw: segment.raw, program, op, refusal, landings, notes }
}

/**
 * **删除那一段，拒的理由是哪一条**（U77）——两支，措辞不同（见 `RefusalKind`）。
 *
 * - `shred` / `srm` ⇒ **没有替代**：「它要的就是不可逆」——**不许换个更弱的做法糊过去**；
 * - 其余（`rm` / `rmdir` / `unlink` / `remove` / `find -delete`）⇒ **不可逆但有替代**：
 *   回执要说得出**该用什么**（`trash`：进废纸篓、能捞回）。
 *
 * ⚠️ **程序词读不出时按"有替代"那一支**（`program === undefined`）：读不出的删除
 * 更可能是 `rm` 那一族（`shred` 是少数），而两支里「指路」是**更保守**的那一支
 * （至少给模型一条走得通的路）。**判据仍然只认得出是删除**（`op === 'delete'`）——
 * 这一处不另立判据。
 */
function REFUSAL_OF(program: string | undefined): RefusalKind {
  return program !== undefined && NO_SUBSTITUTE.includes(program) ? 'no-substitute' : 'irreversible'
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
 *
 * ⚠️ **空命令归「不在名单里」**（`unknown`）——它什么都不做，本来也不该拦
 * （从前它落在「判不出 ⇒ 从严」那一侧，U76 起那条不再拦）。
 */
export function decompose(command: string, ctx: PermissionContext): readonly SegmentAnalysis[] {
  const segments = scan(command)
  if (segments.length === 0) {
    return [
      {
        raw: command,
        program: undefined,
        op: 'unknown',
        refusal: undefined,
        landings: [],
        notes: ['空命令——没有可分析的段'],
      },
    ]
  }
  return segments.map((segment) => analyzeSegment(segment, ctx))
}
