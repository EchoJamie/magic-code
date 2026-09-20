/**
 * 项目规约 —— **来源面**（U32）：发现 · 读取 · 解析 · 去重 · 诊断。
 *
 * 契约那头是 `ProjectRules`（`@magic/contracts`）。本文件只答「**有什么、在哪儿、是哪一版**」；
 * 「选哪些、什么时候送进上下文」归对话域——它才是唯一知道「这一轮在动哪儿」的一层。
 * 分工的理由在设计里写着：**文件读取在执行 / 基础设施边界，内容选择与系统提示词装配在对话侧**。
 *
 * ## 四类入口（原生在前，兼容顺带）
 *
 * 1. **目录规约**——工作区根与操作目标**祖先目录**里的 `AGENTS.md`；同目录没有它时回退
 *    `CLAUDE.md`（`agents` / `claude-md`）。同一份文件经两条路进来（软链接指同实体）只读一次。
 * 2. **原生规则**——`<root>/.magic/rules` 下的 `*.md`（`magic-rules`）：纯 Markdown 无条件
 *    规则，可选 front-matter 的 YAML `paths` 列表把它限到某些路径。
 * 3. **兼容规则**——`<root>/.claude/rules` 下的 `*.md`（`claude-rules`）：同一套机制、同一份
 *    解析器，只多一个入口。**同根同相对规则名以 `.magic/rules` 为准**。
 * 4. **补充来源**——用户显式配置的 `rules.sources`（`source`）。
 *
 * **产品原则**（工单明文）：**Magic 自身规则第一**。兼容方只提供**输入格式**，不改 Magic 的
 * 生效范围、权限或优先级——所以 `.claude/rules` 走的是**同一条**发现与解析路径，不是另一套机制。
 *
 * ## 三条边界（都不是靠自觉，是代码里唯一的入口）
 *
 * - **只读**——本文件只有 `readdir` / `readFile` / `realpath` / `stat`，一个写操作都没有；
 *   规约**不**改 `permissions.rules`、**不**运行其中脚本、**不**接 hooks（那是另一件事）。
 * - **不能借加载器读任意文件**——发现面只有两处：**注册的根之内**与**用户点名的来源**。
 *   一个指向工作区之外的符号链接**不因它是个链接就自动可读**：指到文件的那种报出来并略过，
 *   指到目录的那种**连进都不进**（见 `walk` 的白名单那一闸——广度没有别的兜底）。
 *   **两张名册是两件事**（2026-09-20 裁）：`rules.sources` ＝「这份文件是规约，**读进来**」；
 *   `rules.linkSources` ＝「这个链接**可以跟出去**」——只放行来源，**不把正文当规约加载**，
 *   链接读到的是什么就还是什么（`src/AGENTS.md` 跟出去之后**照旧只管 `src`**，
 *   不会因为真身在根外就变成一条全局规约）。
 * - **不设全仓 watcher**——每次调用现扫（调用时机由对话域定：用户输入与工具目标预查两处），
 *   不缓存、不订阅；改过的规约因此**下一趟就是新的**。
 *
 * ## 限度（如实记，不假装没有）
 *
 * - **`paths` 只匹配「目标路径本身」**：目录目标（`ls src`）不会因为 `paths: ["src/**"]`
 *   而命中——那条规则等真正碰到 `src/` 里的某个文件时再送到。这版不猜「目录底下会有什么」。
 * - **`exec` 的范围按执行 cwd**（＝工作区默认根）：任意 shell 字符串实际会碰哪些文件
 *   **静态推不出来**（`cd src && ./build.sh` 就是反例），故本版**不假装推得出来**，
 *   只保证 cwd 那一层的规约在会话开局就送到了。
 * - **`version` 用 FNV-1a 32 位**：判「是不是同一版」够用（同一份内容恒同一串），
 *   但**不是密码学摘要**——它防的是循环拦截，不是防篡改。
 */

import type {
  ProjectRule,
  ProjectRules,
  RulesLoad,
  RulesProblem,
  WorkspaceService,
} from '@magic/contracts'
import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { expandPatterns, matchesPattern } from './patterns.ts'
import { isInside } from './workspace.ts'

/**
 * 一次读取的**上限**——超了报 `problems` 并停下，**不静默截**。
 *
 * 为什么必须有：本面在**每次模型调用**与**每次工具预查**各跑一遍，而规约树是用户的、
 * 大小没谱——没有上限就是一条被人无意中拖住整轮的路。三个数各管一件事：
 * 单份多大 · 一共几份 · 一共多大。数值本身是**实现级常量**（方向已有，量级归实现）。
 */
export type RulesLimits = {
  readonly maxDocuments: number
  readonly maxDocumentBytes: number
  readonly maxTotalBytes: number
}

/** 缺省上限——够任何讲道理的规约树，又能在一瞬间扫完。 */
export const DEFAULT_RULES_LIMITS: RulesLimits = {
  maxDocuments: 64,
  maxDocumentBytes: 128 * 1024,
  maxTotalBytes: 512 * 1024,
}

/** 装配期构造入参——根视图 ＋ 用户显式点名的补充来源 ＋ 上限覆盖位（测试用）。 */
export type RulesOptions = {
  /** 工作区（根的**两张表**都在它手上——落点判定与执行域同源）。 */
  readonly workspace: WorkspaceService
  /**
   * **用户显式配置**的补充来源（`rules.sources`，`~` 已由配置加载器展开）——
   * 绝对路径，文件或目录。缺省＝一个都没有。**这些的正文会被读进来送进上下文**。
   */
  readonly sources?: readonly string[]
  /**
   * **允许规约符号链接跟出去读**的落点（`rules.linkSources`）——绝对路径，文件或目录。
   * 缺省＝一个都没有。**只放行来源**：写进来的是「这条路可以走」，不是「这份是规约」——
   * 正文不会因此被加载，作用范围也照旧是链接所在的那一处（见文件头注）。
   */
  readonly linkSources?: readonly string[]
  /** 上限覆盖位——缺省 `DEFAULT_RULES_LIMITS`（测试要把超限路径跑出来时用）。 */
  readonly limits?: Partial<RulesLimits> | undefined
}

/** 目录规约的两个文件名——**Magic 的第一入口**在前，兼容回退在后（次序即优先级）。 */
const DIRECTORY_DOCS = ['AGENTS.md', 'CLAUDE.md'] as const

/** 规则文档目录的两个入口——**原生在前**（同上，次序即优先级）。 */
const RULES_DIRS = [
  { segment: '.magic', kind: 'magic-rules' },
  { segment: '.claude', kind: 'claude-rules' },
] as const

/** 候选——还没读、还没去重的一条「可能是一份规约」。 */
type Candidate = {
  readonly kind: ProjectRule['kind']
  /** 发现路径（可能是个软链接——真身份由 realpath 那一步定）。 */
  readonly file: string
  readonly root: string | null
  /** 作用目录——目录规约是它所在的目录；规则文档是所属根。 */
  readonly scope: string | null
  /** 相对所属根的写法（诊断与抬头用）。 */
  readonly name: string
  /**
   * **同根同名**的判据（只有规则文档有）——相对**规则目录**的写法。
   * 由头：`.magic/rules/frontend/react.md` 与 `.claude/rules/frontend/react.md`
   * 说的是「同一条规则的两个入口」，用户按相对规则名对照，不按完整路径。
   */
  readonly ruleKey: string | null
  /** 排序键——[根序, 作用深度, 来源序, 名字]。 */
  readonly order: readonly [number, number, number, string]
}

/**
 * 呈现在材料里的**次序**——一个根一个根地摆（各根的规约连在一起，抬头已标明根），
 * 根内**由外向内**（根一级在前、越深的子目录越靠后），同深度按来源序（原生在前）、再按名字。
 *
 * 为什么按根分块而不是把同名的一律排一起：材料是给人（与模型）读的，
 * 「甲根那一摊」连着摆才看得出是一摊；交错排列会让每一条都得靠抬头重新认一遍根。
 */
const KIND_RANK: Readonly<Record<ProjectRule['kind'], number>> = {
  agents: 0,
  'claude-md': 1,
  'magic-rules': 2,
  'claude-rules': 3,
  source: 4,
}

/** 读过的一条——规则 ＋ 适用条件（条件是本面内部的：消费者只会拿到「适用」的那些）。 */
type Loaded = {
  readonly rule: ProjectRule
  /** 生效模式（根相对）；**空数组＝无条件**（会话开局就送）。 */
  readonly conditions: readonly string[]
  readonly order: Candidate['order']
}

/**
 * 物理同源去重的**身份**——真路径 ＋ **实际范围**（根 ＋ 作用目录）。
 *
 * 为什么不按真路径去重（2026-09-20 裁）：同一份物理文件**可以管两摊**——
 * 根 `AGENTS.md` 与 `src/AGENTS.md` 都软链到同一份团队规约，是常见的组织方式。
 * 按真路径一刀切，后一条（`src` 那条）会被当成「同一份、读过一遍了」而**整个消失**：
 * 它那段约定从此不进上下文，而用户以为 `src` 有一份。
 * **范围不同就是两条规则**——去重该去的是「同一处进来两遍」，不是「同一个文件」。
 */
function identityOf(real: string, root: string | null, scope: string | null): string {
  // 分段符**写成转义**（NUL）而不是空格：路径与根里都可能带空格，拼起来会撞
  // （`/a b` ＋ 根 `c` 与 `/a` ＋ 根 `b c`）。同 `versionOf` 那条注。
  return [real, root ?? '', scope ?? ''].join('\u0000')
}

/**
 * 用户点名的一处（已 realpath）——两处名册共用同一个形态：
 * `sources` 是「按其下 `*.md` 递归 / 就是一份」，`linkSources` 是「这里可以跟出去」。
 */
type Source = { readonly real: string; readonly isDir: boolean }

/** 两份名册在诊断里的自称——配置键名照抄，用户对得上自己写的那一行。 */
type SourceBook = 'sources' | 'linkSources'

/** 一个目标路径归位后的三件——它归哪条根、真身该怎么写、相对根是什么。 */
type Place = {
  readonly root: string
  /** 归到根的**规范形**底下的写法（两张表见 `workspace.ts`）。 */
  readonly absolute: string
  /** 相对所属根（`paths` 模式比的就是它）。 */
  readonly relative: string
}

/**
 * 造项目规约的来源面。
 *
 * 构造不做 I/O——扫不扫、什么时候扫由调用方定（装配期报读数、每轮送材料各一次）。
 */
export function createProjectRules(options: RulesOptions): ProjectRules {
  const limits: RulesLimits = { ...DEFAULT_RULES_LIMITS, ...options.limits }

  return {
    load: (targets: readonly string[]): RulesLoad => load(options, limits, targets),
  }
}

function load(
  options: RulesOptions,
  limits: RulesLimits,
  targets: readonly string[],
): RulesLoad {
  const workspace = options.workspace
  const roots = workspace.roots()
  const declared = workspace.declaredRoots()
  const problems: RulesProblem[] = []

  /** 补充来源（**读进来**的那一份名册）——它们同时也是「允许读」的一处。 */
  const sources = resolveSources(options.sources ?? [], 'sources', problems)
  /** 放行名册（**只放行、不加载正文**）——跟出去之后读到的是什么就还是什么。 */
  const linkSources = resolveSources(options.linkSources ?? [], 'linkSources', problems)
  /** 白名单本体——**递归下探前先问它**：一份都不读的地方，连目录都不进（见 `walk`）。 */
  const allowed = (real: string): boolean =>
    isAllowed(real, roots, declared, [...sources, ...linkSources])
  const candidates: Candidate[] = []
  const directoryDocs = memoDirectoryDocs(problems)

  // ① 各根一级——目录规约 ＋ 两个规则目录（无条件的那几条在会话开局就进上下文）
  roots.forEach((root, index) => {
    candidates.push(...directoryDocs(root, root, index))
    for (const { segment, kind } of RULES_DIRS) {
      candidates.push(...scanRulesDir(join(root, segment, 'rules'), root, kind, index, problems, allowed))
    }
  })

  // ② 操作目标的**祖先目录**——「近目录约定仅细化其子树」，故只沿目标往上走，不横着扫
  const places: Place[] = []
  for (const raw of targets) {
    const place = placeTarget(raw, workspace, roots, declared)
    if (place === undefined) continue
    places.push(place)

    for (const dir of ancestorDirs(place.absolute, place.root)) {
      candidates.push(...directoryDocs(dir, place.root, roots.indexOf(place.root)))
    }
  }

  // ③ 补充来源——用户点名的才读（根外那些也由此有了一条名正言顺的路）
  for (const source of sources) {
    candidates.push(...scanSource(source, roots, roots.length, problems))
  }

  return select({ candidates, places, limits, problems, allowed })
}

// ══ ① 目录规约 ════════════════════════════════════════════════════════

type DirectoryDocs = (dir: string, root: string, rootIndex: number) => readonly Candidate[]

/** 同一个目录只判一次——根一级与某个目标的祖先目录常常撞上同一处。 */
function memoDirectoryDocs(problems: RulesProblem[]): DirectoryDocs {
  const memo = new Map<string, readonly Candidate[]>()

  return (dir, root, rootIndex) => {
    const cached = memo.get(dir)
    if (cached !== undefined) return cached

    const found = directoryDocsOf(dir, root, rootIndex, problems)
    memo.set(dir, found)
    return found
  }
}

/**
 * 某个目录的目录规约——`AGENTS.md` 优先；两条入口指同一份实体时只读一次；
 * 两份**不同实体**时采 AGENTS，并把落选的那份**说出来**（不静默混成一份）。
 */
function directoryDocsOf(
  dir: string,
  root: string,
  rootIndex: number,
  problems: RulesProblem[],
): readonly Candidate[] {
  const present: { readonly name: string; readonly file: string; readonly kind: ProjectRule['kind'] }[] = []

  for (const name of DIRECTORY_DOCS) {
    const file = join(dir, name)
    if (!isFile(file)) continue
    present.push({ name, file, kind: name === 'AGENTS.md' ? 'agents' : 'claude-md' })
  }

  const first = present[0]
  if (first === undefined) return []

  /** 抬头名——根一级只有文件名（`AGENTS.md`），子目录带相对目录（`src/AGENTS.md`）。 */
  const said = (name: string): string => {
    const relativeDir = relativeTo(root, dir)
    return relativeDir === '' ? name : `${relativeDir}${sep}${name}`
  }

  // 只有一份——照它走（没有第二个入口要比较，也就没有取舍可说）
  if (present.length === 1) {
    return [candidateOf(first.kind, first.file, root, dir, rootIndex, said(first.name))]
  }

  const second = present[1] as (typeof present)[number]

  // **软链接指同实体**——两个入口指着一份文件，只读一次（`first` 是 AGENTS 那一头）
  if (sameFile(first.file, second.file)) {
    return [candidateOf(first.kind, first.file, root, dir, rootIndex, said(first.name))]
  }

  // **同目录两份不同实体**——采 AGENTS，并把落选的那份与「怎么能一并读」说清楚。
  // ⚠️ 这条会印在 `--check` 的一行里（前头已经有目录路径了），故此处**不再复述目录**：
  // 两个文件名 ＋ 一个可照抄的出口，够了。
  problems.push({
    path: dir,
    kind: 'choice',
    message:
      `同目录两份不同实体：采用 ${first.name}，未采用 ${second.name}——` +
      `要一并加载，请把 ${second.file} 写进配置的 rules.sources`,
  })

  return [candidateOf(first.kind, first.file, root, dir, rootIndex, said(first.name))]
}

function candidateOf(
  kind: ProjectRule['kind'],
  file: string,
  root: string | null,
  scope: string | null,
  rootIndex: number,
  name: string,
  ruleKey: string | null = null,
): Candidate {
  return {
    kind,
    file,
    root,
    scope,
    name,
    ruleKey,
    order: [rootIndex, name.split(sep).length, KIND_RANK[kind], name],
  }
}

// ══ ② 规则目录 ════════════════════════════════════════════════════════

/**
 * 递归收一个规则目录下的 `*.md`——**规则子目录只是组织方式**，故 `name` 报的是
 * 相对**所属根**的写法（`.magic/rules/frontend/react.md`），`ruleKey` 报相对**规则目录**
 * 的写法（`frontend/react.md`，「同根同名」那条判据用它）。
 *
 * 目录不存在＝正常（多数项目只有一个入口，甚至一个都没有），不出声。
 */
function scanRulesDir(
  dir: string,
  root: string,
  kind: ProjectRule['kind'],
  rootIndex: number,
  problems: RulesProblem[],
  allowed: (real: string) => boolean,
): readonly Candidate[] {
  if (!isDirectory(dir)) return []

  const label = relativeTo(root, dir)

  return walkMarkdown(dir, allowed, problems).map((file) =>
    candidateOf(
      kind,
      file,
      root,
      root,
      rootIndex,
      `${label}${sep}${relativeTo(dir, file)}`,
      relativeTo(dir, file),
    ),
  )
}

/**
 * 递归走一个目录，收 `*.md`——**跟符号链接**，但有**两道闸**：
 *
 * - **白名单**（`allowed`）——**下探之前先问**：这个地方本来就不允许读，那连目录都不进。
 *   由头不是洁癖：`.magic/rules` 里搁一个 `-> /` 的软链接，就足以让**每一次模型调用**
 *   把整块盘走一遍（深度有兜底，广度没有）。「一份都不读的地方，连目录都不进」把这个
 *   口子从两头一起堵上——顺带，被跳过的那个目录**报得出来**（比逐文件报「略过」更清楚）。
 * - **记账**（`visited`）——跟进去的真目录记上一笔：第二次踏进同一个真目录就是环
 *   （`a -> b -> a`），那一条**报出来并停住**，不转圈。
 *
 * 为什么要跟链接：规则目录常见「软链接到别处的一份共享规则」这种组织方式。跟，就意味着
 * 「能不能读」这件事不能靠「它是个链接」来判断——那由白名单统一裁。
 *
 * 排序（名字序）在这里就定下：文件系统返回的次序不作保证，两趟读出两种次序会让
 * 「相同的规则」看起来像变过（`version` 比的是内容，次序另算）。
 */
function walkMarkdown(
  dir: string,
  allowed: (real: string) => boolean,
  problems: RulesProblem[],
): readonly string[] {
  const found: string[] = []
  walk(dir, found, new Set<string>(), problems, allowed)

  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function walk(
  dir: string,
  found: string[],
  visited: Set<string>,
  problems: RulesProblem[],
  allowed: (real: string) => boolean,
  depth = 0,
): void {
  // 环之外还有一层兜底：链接可以让目录无限深，别把调用栈吃掉
  if (depth > 32) {
    problems.push({ path: dir, kind: 'error', message: '目录层级过深（超过 32 层）——已停在这一层，不再往下' })
    return
  }

  const real = tryRealpath(dir)
  if (real === undefined) return

  if (!allowed(real)) {
    // 头一行已经报着是哪个目录了，此处只说「真身在哪、怎么才读得到」
    // 「也写进」不是啰嗦：用户可能正处在「已经点了名、只是点的是它的上一层」这个场景里，
    // 少了这个「也」，「请把真身写进 rules.linkSources」读起来像在让他做他已经做过的事
    // ⚠️ 报的是 `linkSources` 而不是 `sources`（2026-09-20 裁）：这里要的是「**放行这条路**」，
    // 不是「把这一摊都当规约读进来」——两个键的分水岭见 `contracts/config.ts` 那段注。
    problems.push({
      path: dir,
      kind: 'error',
      message:
        `指向工作区之外的目录（真身 ${real}）——没进去。要读它，` +
        `请把这个真身也写进配置的 rules.linkSources`,
    })
    return
  }

  if (visited.has(real)) {
    problems.push({ path: dir, kind: 'error', message: `目录循环——又绕回 ${real}，只读一次、不再往下` })
    return
  }
  visited.add(real)

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    problems.push({ path: dir, kind: 'error', message: `目录读不动：${reasonOf(error)}` })
    return
  }

  for (const entry of entries) {
    const child = join(dir, entry.name)

    // 类型按 `stat` 判（**跟链接**）——Dirent 的类型位对符号链接既非目录也非文件
    let kind: 'file' | 'directory' | 'other' = 'other'
    try {
      const info = statSync(child)
      kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    } catch {
      continue // 断链——跳过（不是「没规则」，是那一份取不到）
    }

    if (kind === 'directory') walk(child, found, visited, problems, allowed, depth + 1)
    else if (kind === 'file' && entry.name.endsWith('.md')) found.push(child)
  }
}

// ══ ③ 补充来源 ════════════════════════════════════════════════════════

/**
 * 来源归位——`stat` 一遍判它是什么；不合格 / 不存在 / 取不到状态，一律**报出来**
 * （不静默跳过）。
 *
 * **相对路径在这儿拒**（与工作区根同一条规矩，只是判的层不同）：相对串的基准是**进程的
 * 当前目录**——换个地方启动 `magic`，同一个配置就指到别处去了，而用户写的时候心里想的
 * 多半不是那个。工作区根那一份由执行域的根注册拒（`workspace.ts` `normalizeRoot`），
 * 补充来源走不到那儿，故在此补齐同一道。
 */
function resolveSources(
  raw: readonly string[],
  book: SourceBook,
  problems: RulesProblem[],
): readonly Source[] {
  const resolved: Source[] = []

  raw.forEach((entry, index) => {
    const at = `rules.${book} 第 ${index + 1} 条`

    if (!isAbsolute(entry)) {
      problems.push({
        path: entry,
        kind: 'error',
        message: `${at}须是绝对路径——相对串的基准是进程当前目录，换个地方启动就指到别处去了`,
      })
      return
    }

    let real: string
    try {
      real = realpathSync(entry)
    } catch (error) {
      problems.push({ path: entry, kind: 'error', message: `${at}不存在或不可达——${reasonOf(error)}` })
      return
    }

    try {
      resolved.push({ real, isDir: statSync(real).isDirectory() })
    } catch (error) {
      problems.push({ path: entry, kind: 'error', message: `${at}取不到状态——${reasonOf(error)}` })
    }
  })

  return resolved
}

/**
 * 用户点名的补充来源——目录按其下 `*.md` 递归，文件就是一份规则文档。
 *
 * **落点照旧要报**：落在某条根内就归那条根（作用域说得清）；根外的是**用户点名的全局来源**
 * （`root` / `scope` 为 `null`）——那是「用户说了要读」，不是「Magic 替它猜了个作用域」。
 */
function scanSource(
  source: Source,
  roots: readonly string[],
  rootIndex: number,
  problems: RulesProblem[],
): readonly Candidate[] {
  const home = roots.find((root) => isInside(source.real, root)) ?? null
  // 用户点名的这一处**连同它底下**都算允许读——这正是不落根内的补充来源存在的理由
  const inside = (real: string): boolean => isInside(real, source.real)
  const files = source.isDir ? walkMarkdown(source.real, inside, problems) : [source.real]

  return files.map((file) => {
    const name = home === null ? file : relativeTo(home, file)
    return candidateOf('source', file, home, home, rootIndex, name)
  })
}

// ══ ④ 去重 → 读 → 解析 → 条件过滤 ════════════════════════════════════

function select(input: {
  readonly candidates: readonly Candidate[]
  readonly places: readonly Place[]
  readonly limits: RulesLimits
  readonly problems: RulesProblem[]
  readonly allowed: (real: string) => boolean
}): RulesLoad {
  const { candidates, places, limits, problems, allowed } = input
  const loaded: Loaded[] = []
  /** 物理同源去重——**真路径 ＋ 实际范围**（见 `identityOf`：范围不同＝两条）。 */
  const seen = new Set<string>()
  /** 同根同名去重——`<root> <ruleKey>` → 已经收下的那一条。 */
  const seenRule = new Map<string, Candidate>()
  /** 这一趟因为上限丢过材料（`RulesLoad.truncated`——消费方据它判「回来的是不是全的」）。 */
  let truncated = false
  let bytes = 0

  /**
   * **原生占位**——同根同相对规则名的 `.magic/rules` 只要**在**，这个名字就归它。
   *
   * 由头（2026-09-20 裁）：占位必须在**解析与物理去重之前**定下。放在「读懂了才算数」的
   * 位置会有两个口子——原生那份**读不懂**、**读不到**、或**与兼容那份是同一个实体**时，
   * 占位落空 ⇒ `.claude/rules` 里那条同名的**顶了上来**。而那三件事**都是原生的错**，
   * 不是「原生不在」：用户按「原生优先」的规则写的 `.magic/rules/x.md`，写坏了一个字，
   * 结果**另一套规则悄悄接管**——这正是「兼容方不得改变 Magic 的生效范围与优先级」要拦的。
   *
   * 占位的**依据是文件在不在**（`scanRulesDir` 只收 walk 出来的真文件，故候选在＝文件在）。
   */
  const nativeKeys = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.kind !== 'magic-rules' || candidate.ruleKey === null) continue
    nativeKeys.add(`${candidate.root ?? ''} ${candidate.ruleKey}`)
  }

  for (const candidate of candidates) {
    if (loaded.length >= limits.maxDocuments) {
      problems.push({
        path: candidate.file,
        kind: 'error',
        message: `规约份数已达上限 ${limits.maxDocuments}——从这一份起不再加载（这里报的正是没读进来的那些）`,
      })
      truncated = true
      break
    }

    const real = tryRealpath(candidate.file)
    if (real === undefined) continue // 不存在 / 断链——多数目录没有 AGENTS.md，不是错

    const key = candidate.ruleKey === null ? undefined : `${candidate.root ?? ''} ${candidate.ruleKey}`

    // **兼容那份撞上原生占位**——不管原生那份最后读没读懂、能不能读、是不是同一个实体，
    // 这个名字都不给兼容的。
    // ⚠️ **这一关必须跑在物理去重之前**（2026-09-20 自验当场抓到）：兼容那份是**同一个实体**
    // 的软链接时，按真路径去重会把它**悄悄吞掉**——一条话说没有，用户只看见「兼容那份没生效」
    // 而不见理由。占位在前，那一条就有交代。
    // 原生自己（`magic-rules`）走正常流程：读不懂就报它自己的错（对得住「原生错误明确诊断」）。
    if (key !== undefined && candidate.kind === 'claude-rules' && nativeKeys.has(key)) {
      const native = candidates.find(
        (other) => other.kind === 'magic-rules' && `${other.root ?? ''} ${other.ruleKey ?? ''}` === key,
      )
      // **不静默**：用户得知道自己写的那一份没在管。但它**不是错误**（`choice`）——
      // 「原生优先」是产品按设计做的取舍，为它每次开屏报一句就是噪音（见契约 `RulesProblem`）。
      problems.push({
        path: candidate.file,
        kind: 'choice',
        message:
          `同根同名：这个名字已经归 Magic 的那一份（${native?.name ?? key}）——` +
          `本条按「原生优先」不加载`,
      })
      continue
    }

    const identity = identityOf(real, candidate.root, candidate.scope)
    if (seen.has(identity)) continue // 同一处进来两遍（软链接指同实体）：只看一次
    seen.add(identity)

    const winner = key === undefined ? undefined : seenRule.get(key)

    if (key !== undefined && winner !== undefined) {
      // 走到这儿的只可能是**同一本名册里**撞了名字（兼容那份刚被占位挡掉）
      problems.push({
        path: candidate.file,
        kind: 'choice',
        message:
          `同根同名：这一份与 ${winner.name} 重复——按「原生优先」，本条不加载`,
      })
      continue
    }

    if (!allowed(real)) {
      // 外部符号链接——**不因它是个链接就自动可读**
      problems.push({
        path: candidate.file,
        kind: 'error',
        message:
          `指向工作区之外的符号链接（真身 ${real}）——未加载。要读它，` +
          `请把这个真身写进配置的 rules.linkSources`,
      })
      continue
    }

    const size = sizeOf(real)
    if (size === undefined) continue
    if (size > limits.maxDocumentBytes) {
      problems.push({
        path: candidate.file,
        kind: 'error',
        message: `超过单份上限 ${limits.maxDocumentBytes} 字节（实际 ${size}）——未加载`,
      })
      continue
    }
    if (bytes + size > limits.maxTotalBytes) {
      problems.push({
        path: candidate.file,
        kind: 'error',
        message: `规约总量已达上限 ${limits.maxTotalBytes} 字节——从这一份起不再加载`,
      })
      truncated = true
      break
    }

    let text: string
    try {
      text = readFileSync(real, 'utf8')
    } catch (error) {
      problems.push({ path: candidate.file, kind: 'error', message: `读不到：${reasonOf(error)}` })
      continue
    }

    const parsed = parseDocument(text, candidate.kind)
    if (parsed.problem !== undefined) {
      // **读不懂的不生效，且说得出为什么**——不降级成「无条件」把范围悄悄放大
      problems.push({ path: candidate.file, kind: 'error', message: parsed.problem })
      continue
    }

    bytes += size
    if (key !== undefined) seenRule.set(key, candidate)

    const patterns = parsed.patterns ?? []
    // 版本最后算：它要把**已经摆好的这一条**（连范围一起）摘要进去——见 `versionOf`
    const rule: ProjectRule = {
      kind: candidate.kind,
      path: real,
      root: candidate.root,
      scope: candidate.scope,
      paths: patterns,
      name: candidate.name,
      text: parsed.body,
      version: '',
    }

    loaded.push({ rule: { ...rule, version: versionOf(rule) }, conditions: patterns, order: candidate.order })
  }

  // **条件规则在目标相关时送达**——无路径的照进（会话开局那几条），带 `paths` 的只在
  // 命中某个目标时进；没目标＝不送（那一趟只取「根一级」）
  const applicable = loaded.filter(
    (entry) => entry.conditions.length === 0 || places.some((place) => applies(entry, place)),
  )

  return {
    documents: applicable.sort(compareLoaded).map((entry) => entry.rule),
    problems,
    truncated,
  }
}

/**
 * 这条规则管不管这个目标——**先看根，再看模式**。
 *
 * 根那一关是「**不将甲根规范作为乙根全局规范**」的落点：甲根的 `paths: ["src/**"]`
 * 说的是**甲根的 src**，乙根里恰好也有个 `src/x.ts` 不该被它管住。两处各写一条 `src/**`
 * 的两条规则本来就该各管各的（有用例钉着）。
 *
 * **基准随来源**：有根的规则按**根相对**比（规则子目录只是组织方式，基准仍是项目根）；
 * 用户点名的补充来源（`root` 为 `null`）没有根可比，故**绝对路径与根相对两种写法都比**
 * ——于是「任意层目录再加一个 src」与直接写 `src` 两种写法都命中。两种写法都是用户显式
 * 点名之后的事，不构成「替谁猜了个作用域」。
 */
function applies(entry: Loaded, place: Place): boolean {
  const bases =
    entry.rule.root === null
      ? [place.absolute, place.relative]
      : place.root === entry.rule.root
        ? [place.relative]
        : []

  return bases.some((base) => entry.conditions.some((pattern) => matchesPattern(pattern, base)))
}

function compareLoaded(left: Loaded, right: Loaded): number {
  const [leftRoot = 0, leftDepth = 0, leftKind = 0, leftName = ''] = left.order
  const [rightRoot = 0, rightDepth = 0, rightKind = 0, rightName = ''] = right.order

  return (
    leftRoot - rightRoot ||
    leftDepth - rightDepth ||
    leftKind - rightKind ||
    (leftName < rightName ? -1 : leftName > rightName ? 1 : 0)
  )
}

// ══ 文档解析（front-matter ＋ 正文）═══════════════════════════════════

type ParsedDocument = {
  readonly body: string
  /** `undefined` ＝ 无条件。 */
  readonly patterns: readonly string[] | undefined
  /** 给出来了＝这一份**不加载**（读不懂的不生效，绝不降级成更宽的那一种）。 */
  readonly problem: string | undefined
}

/**
 * 判一份文档的形态。
 *
 * **只管规则文档**（`magic-rules` / `claude-rules` / `source`）：那三类的 `paths` 是
 * **格式的一部分**。目录规约（`AGENTS.md` / `CLAUDE.md`）**整篇照收**——那是人写的约定
 * 文档，不是配置文件；顺手解析它的头部只会把「顶上一段 YAML 风格的说明」吃掉。
 *
 * **YAML 交给 `Bun.YAML.parse`**（2026-09-20 裁）：本文件原先自带一套手写的词法
 * （逐行剥注释、认列表项、去掉成对引号）。它错在两个方向——**该松的地方太紧**
 * （`paths: ["src/**", "lib/**"]` 这种合法的 inline 列表被拒），**该紧的地方太松**
 * （`- "src/**` 少一个引号照样收下，模式于是带着半截引号去匹配，一声不响地什么都不命中）。
 * 自己写词法就要自己写对 YAML 的全部边角，那不是这个单元该背的活；Bun 自带解析器，
 * 实测可用（Bun 1.4.2），故**删掉手写那份，用它**。留在这里的是**产品自己的规矩**。
 *
 * **本文件仍然只认一个键 `paths`，仍然拒一切不认识的键**（同权限域 `parseRules` 的姿态）：
 * `path:` 少写一个 `s` 就静默变成「无条件」——那正是「无效模式不得扩大为全匹配」要拦的。
 * 模式本身照旧走 `expandPatterns`（**窄 glob 语义与有界展开都是产品定的**，不交给 YAML）。
 */
function parseDocument(text: string, kind: ProjectRule['kind']): ParsedDocument {
  if (kind === 'agents' || kind === 'claude-md') return { body: text, patterns: undefined, problem: undefined }

  const front = splitFrontMatter(text)
  if (front.problem !== undefined) return fail(front.problem)
  if (front.value === undefined) return { body: text, patterns: undefined, problem: undefined }

  let value: unknown
  try {
    value = Bun.YAML.parse(front.value)
  } catch (error) {
    // 未闭合的引号 / 括号都走这一支（实测 `Bun.YAML.parse` 当场抛）——「明确报错」的落点
    return fail(`front-matter 读不懂（YAML）：${reasonOf(error)}`)
  }

  // 空 front-matter（只有两条 `---`）＝什么都没声明＝无条件
  if (value === null || value === undefined) return { body: front.body, patterns: undefined, problem: undefined }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      `front-matter 得是一组「键: 值」，读到的是${Array.isArray(value) ? '一个列表' : `「${String(value)}」`}` +
        `——本文件只认 \`paths\``,
    )
  }

  const fields = value as Record<string, unknown>
  const strange = Object.keys(fields).filter((key) => key !== 'paths')
  if (strange.length > 0) {
    // 说清「为什么拒」而不是「为什么宽」：放它过去，这条规则会悄悄变成「到处都生效」
    return fail(`front-matter 里有不认识的键「${strange.join(' / ')}」——只认 \`paths\`（写错的键名不会被猜中）`)
  }

  const declared = fields['paths']
  if (declared === undefined) return { body: front.body, patterns: undefined, problem: undefined }
  // `paths:` 后面什么都没写时 YAML 给的是 `null`——它与 `paths: []` 是同一件事（空列表），
  // 不是「写了个别的东西」。两者都照「要么整条不写、要么给至少一条」那条说。
  if (declared === null || (Array.isArray(declared) && declared.length === 0)) {
    return fail('`paths:` 给了空列表——要么整条不写（＝无条件生效），要么给至少一条模式')
  }
  if (!Array.isArray(declared)) {
    return fail(
      '`paths:` 只认列表写法——上面一行 `paths:`，下面一行一条 `- 模式`；' +
        '一行写完用 `["模式", "模式"]` 也行。收到的是一个单独的值',
    )
  }
  const patterns: string[] = []
  for (const entry of declared) {
    if (typeof entry !== 'string') {
      // YAML 把 `- 12` 读成数字、`- true` 读成布尔——那些不是路径，逐项说出来
      return fail(`paths 里的这一项不是路径（${JSON.stringify(entry)}）——每一项都得是字符串`)
    }
    const expanded = expandPatterns(entry)
    if (!expanded.ok) return fail(`paths 里的模式不成立：${expanded.reason}`)
    patterns.push(...expanded.patterns)
  }

  return { body: front.body, patterns, problem: undefined }
}

function fail(problem: string): ParsedDocument {
  return { body: '', patterns: undefined, problem }
}

/**
 * 取出 front-matter —— **只在第一行正好是 `---` 时**认。
 *
 * **没闭合的那一条报错**（2026-09-20 裁，改了旧口径）：头一行写了 `---`、往下再也找不到
 * 收尾那条 `---` 时，旧做法是「当它不存在、整篇按正文收下」——那是一次**静默降级**：
 * 用户以为写了个 front-matter，实际那份文档的 `paths` 一个字都没生效（而正文里那段
 * `paths:` 会作为正文被送去模型）。现在**明说**：要么补上收尾那条，要么把开头那条删掉。
 *
 * ⚠️ 目录规约（`AGENTS.md` / `CLAUDE.md`）走不到这儿——它们**整篇照收**（见 `parseDocument`），
 * 所以「文档顶上一条横线」那种排版习惯不受这条影响。
 */
function splitFrontMatter(text: string): {
  readonly value: string | undefined
  readonly body: string
  readonly problem: string | undefined
} {
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return { value: undefined, body: text, problem: undefined }

  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '---') continue
    return {
      value: lines.slice(1, index).join('\n'),
      body: lines.slice(index + 1).join('\n').replace(/^\n+/, ''),
      problem: undefined,
    }
  }

  return {
    value: undefined,
    body: '',
    problem: 'front-matter 没闭合——头一行是 `---`，往下再没有第二条 `---`（补上收尾那条，或把开头这条删掉）',
  }
}


// ══ 落点与白名单 ══════════════════════════════════════════════════════

/**
 * 目标路径归位——**与沙箱同一条解析规则**（相对按默认根 · 绝对须落根内）。
 *
 * 两张表这里也要认（同权限域的理由）：用户手写的 `/tmp/proj` 在 macOS 上实为
 * `/private/tmp/proj`，模型会照**用户写的**那一串给路径——只认规范形的话，
 * 「`/tmp/proj/src` 该受 `src/**` 管」这条就判不出来了。
 *
 * 越界＝`undefined`（不报）：那一路本来就轮不到规约说话——越界的调用会先被闸门拦下。
 */
function placeTarget(
  raw: string,
  workspace: WorkspaceService,
  roots: readonly string[],
  declared: readonly string[],
): Place | undefined {
  let absolute: string
  let root: string

  try {
    const resolved = workspace.resolve(raw)
    absolute = resolved.absolute
    root = resolved.root
  } catch {
    return undefined
  }

  const declaredRoot = declared[roots.indexOf(root)] ?? root
  const real =
    declaredRoot === root || isInside(absolute, root)
      ? absolute
      : isInside(absolute, declaredRoot)
        ? root + absolute.slice(declaredRoot.length)
        : absolute

  return { root, absolute: real, relative: relativeTo(root, real) }
}

/**
 * 祖先目录——从目标**所在目录**往上走到根（含根），由外向内。
 *
 * 目标本身是目录时从它自己起算（`ls src` 要拿到 `src/AGENTS.md`）。
 * **只走到根为止**：根之外的家目录 / 上级仓库不是这个工作区的规约面——那是「读任意文件」
 * 那条路的入口，不是「按目录就近取约定」。
 */
function ancestorDirs(absolute: string, root: string): readonly string[] {
  const chain: string[] = []
  let current = isDirectory(absolute) ? absolute : dirname(absolute)

  for (let guard = 0; guard < 256; guard += 1) {
    if (!isInside(current, root)) break
    chain.push(current)
    if (current === root) break

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return chain.reverse()
}

/** 白名单——**注册的根之内**或**用户点名的补充来源**。两者之外一律不读（且报出来）。 */
function isAllowed(
  real: string,
  roots: readonly string[],
  declared: readonly string[],
  sources: readonly Source[],
): boolean {
  if (roots.some((root) => isInside(real, root))) return true
  if (declared.some((root) => isInside(real, root))) return true

  return sources.some((source) => (source.isDir ? isInside(real, source.real) : real === source.real))
}

// ══ 小件 ══════════════════════════════════════════════════════════════

/**
 * 相对写法——分隔符按平台（报给人的抬头，也是 `paths` 的比对基准）。
 *
 * ⚠️ **不能直接切 `base.length + 1`**：根是文件系统顶（`/`）时它**自带**分隔符，
 * `isInside` 认它、这里不认就会多吃一个字符——`/var/x` 会变成 `ar/x`，于是照「根相对」
 * 写对的 `paths` 一条都命不中，**且不报错**（`workspaceRoots: ["/"]` 或 `cd / && magic`）。
 */
function relativeTo(base: string, file: string): string {
  if (file === base) return ''
  if (!isInside(file, base)) return file

  const prefix = base.endsWith(sep) ? base : base + sep
  return file.slice(prefix.length)
}

/**
 * 内容版本——**真路径 ＋ 生效模式 ＋ 正文**。
 *
 * 三者缺一不可，各有一个由头：
 * - **真路径**是**文档身份**——不含它，两份**正文一模一样**的规约（根 `AGENTS.md` 与
 *   `src/AGENTS.md` 内容相同：复制粘贴起手、脚本生成、模板铺开，都很常见）会算出同一个
 *   版本号，而下游的 `delivered` 是**按版本**判「送过没有」的 ⇒ 送过根那一份之后，
 *   `src` 那一份会被当成「已送达」，**永远不送、也不拦**——「副作用之前送到」这条承诺
 *   就在最需要它的场景里（同一套约定按目录铺开）静默失效。**判「改没改」要的是内容，
 *   判「送没送」要的是身份，两者都得进这个号。**
 * - **生效模式**——模式变了，适用面就变了，故也算一版；
 * - **正文**——改一个字就是新的一版。
 */
function versionOf(rule: ProjectRule): string {
  // 四段之间的分隔符是 **NUL**，且**写成转义**而不是往源码里塞裸的控制字节：
  // 裸的读不出、diff 不了，还会让 grep 把整份文件当二进制而**一声不响地什么都不输出**
  // （本单元真栽过：两个 0x00 就藏在这一行里，`tsc` 照收、用例照绿）。
  // 用 NUL 而不是空格，是防「不同的段拼出同一个串」——`path` 与模式里都可能有空格。
  const material = [
    rule.path,
    rule.root ?? '',
    rule.scope ?? '',
    rule.paths.join(' '),
    rule.text,
  ].join('\u0000')
  let hash = 0x811c9dc5

  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `v${hash.toString(16).padStart(8, '0')}-${material.length.toString(16)}`
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 两条路径是不是同一份文件（软链接指同实体）。 */
function sameFile(left: string, right: string): boolean {
  const leftReal = tryRealpath(left)
  const rightReal = tryRealpath(right)

  return leftReal !== undefined && leftReal === rightReal
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
