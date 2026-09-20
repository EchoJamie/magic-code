/**
 * 技能 —— **来源面**（U33）：发现 · 读取 · 去重 · 诊断。
 *
 * 契约那头是 `Skills`（`@magic/contracts`）。本文件只答「**有什么、在哪儿、读到的是什么**」；
 * 「选哪些、什么时候送进上下文」归对话侧（显式选定随提交、模型自主选用经受限读取入口）。
 * 分工的理由与项目规约同源：**文件读取在执行 / 基础设施边界，内容选择与提示词装配在对话侧**。
 *
 * ## 格式依据（Agent Skills 规范 · 2026-09-21 核对）
 *
 * 一个技能 ＝ 一个目录 ＋ 一份 `SKILL.md`：YAML front-matter（`name` / `description` 必填，
 * `license` / `compatibility` / `metadata` / `allowed-tools` 可选）＋ Markdown 正文。
 * 正文里的引用按**相对技能目录**的写法给出（`references/REFERENCE.md`、`scripts/x.py`）。
 *
 * **只认必填的两件**（`name` / `description`），其余一概**不进 Magic 的形态**：
 * - `allowed-tools` 是上游的**实验字段**，规范自己写着「各实现支持不一」。Magic 的规矩是
 *   「外部扩展不授予 Magic 权限」——收下它就等于让它绕过权限闸门，故**连读都不读**：
 *   模型手上的工具集由内核定，不由一份技能文档扩。
 * - `license` / `compatibility` / `metadata` 与本产品无关（我们不做安装器、不做市场）。
 *
 * **`name` 取 front-matter 的那一个，不取目录名**：两者规范要求一致，不一致时
 * 按**技能自己声明的名字**报（那是它自称的名字）。由头：Magic 不按目录名寻址——
 * 身份是「真路径」（见契约 `Skill.path`），名字只是显示与识别的入口；
 * 为一条排版级的不一致把整份技能判死，代价大于收益。`path` 因此必须与 `name` 一起带着走。
 *
 * ## 三类来源（原生在前，兼容顺带）
 *
 * 1. **项目**——各工作区根下的 `<root>/.magic/skills`（`magic`）与 `<root>/.agents/skills`
 *    （`agents`）；
 * 2. **用户**——`<home>/.magic/skills` 与 `<home>/.agents/skills`；
 * 3. **补充**——用户显式配置的 `skills.sources` 点名的目录（`configured`）。
 *
 * **次序即优先级**：项目 → 用户 → 配置；同作用域内 `magic` → `agents`。它不是排序偏好，
 * 是**同名时的取舍**（`/名字` 直达取靠前那份，其余同名项仍在列、仍可明确选中）。
 * 「Magic 自身第一」用在这儿：`.magic/skills` 是主，`.agents/skills` 是**兼容入口**；
 * 用户点名的目录是补充（与 `ProjectRule.kind` 把 `source` 排最后同一条理由）。
 *
 * ## 三条边界（都不是靠自觉，是代码里唯一的入口）
 *
 * - **只读**——本文件只有 `readdir` / `readFile` / `realpath` / `stat`，一个写操作都没有；
 *   技能**不**改 `permissions.rules`、**不**运行其中脚本、**不**接 hooks。
 * - **不能借加载器读任意文件**——发现面只有三类来源各自的**一层子目录**；
 *   读取面只有「已发现身份的技能目录」与「它来源内的相对引用」。
 *   越出技能目录的引用（绝对路径 / `..` / 经软链接绕出去）不是「读不到」，是**不许读**。
 * - **不设全仓 watcher**——每次调用现扫（时机由对话域定：装配提示词与按需读取两处），
 *   不缓存、不订阅；改过的技能因此**下一趟就是新的**（验收明写）。
 *
 * ## 与项目规约的两处不同（都是刻意的）
 *
 * - **没有 `truncated` 这一位**：规约树的深度不设限，于是「有没有该看而没看到的地方」
 *   成了一个问题；技能的树是**死的一层**（来源目录 → 技能目录 → `SKILL.md`），
 *   到不了的地方只有两处（来源目录读不动、份数到顶），各自都报得出来。
 * - **`maxMaterialChars` 是送出去的上限**：规约那边超限是「整批停下」（副作用前的一道闸）；
 *   技能这边是**一次读取失败**——「不给半截正文」，主文太长就照实说太长（见 `readAt`）。
 */

import type {
  Skill,
  SkillCatalog,
  SkillMaterial,
  SkillProblem,
  SkillRead,
  Skills,
  WorkspaceService,
} from '@magic/contracts'
import type { Dirent } from 'node:fs'
import { closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { isInside } from './workspace.ts'

/**
 * 一次工作的**上限**——超了报 `problems` 并停下，**不静默截**。
 *
 * 四个数各管一件事：一共几个技能 · 元数据头读多少 · 单份材料多大 · 送出去多少字符。
 * 数值本身是**实现级常量**（方向已有，量级归实现）。
 */
export type SkillLimits = {
  /** 发现面的**份数上限**——超出的报成 `problems`（不静默丢，见 `collect`）。 */
  readonly maxSkills: number
  /**
   * 发现时读 `SKILL.md` **头部**的字节上限——front-matter 落在这里面。
   *
   * 为什么只读头：启动那一趟要的是**名称与描述**（规范把 `description` 限在 1024 字符），
   * 正文一格都不需要。整份读进来再丢掉，等于每次装配提示词都把仓库里所有技能的全文
   * 过一遍盘——「未选中不加载正文」是设计要的行为，不该在发现这一步偷偷破功。
   */
  readonly maxMetadataBytes: number
  /** 单份材料（主文 / 引用）的**读取**字节上限——超了就是读失败。 */
  readonly maxFileBytes: number
  /** 单份材料**送进上下文**的字符上限——超了**明确失败**（不给半截正文）。 */
  readonly maxMaterialChars: number
}

/**
 * 缺省上限。
 *
 * `maxMetadataBytes` 取 8 KiB：`description` 至多 1024 字符，其余字段都是短值，
 * 一份写得再肥的 front-matter 也落得下；落不下的那份本来就该报「读不懂」。
 *
 * `maxMaterialChars` 取 20000：规范建议 `SKILL.md` 正文控制在 5000 token 以内
 * （≈ 一万余字符），20000 给了两倍余量；再长的那份**照实说太长**，
 * 由作者拆到 `references/` 去（那正是规范推荐的做法）。
 */
export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  maxSkills: 64,
  maxMetadataBytes: 8 * 1024,
  maxFileBytes: 256 * 1024,
  maxMaterialChars: 20_000,
}

/** 装配期构造入参——根视图 ＋ 用户目录 ＋ 用户点名的补充目录 ＋ 上限覆盖位（测试用）。 */
export type SkillsOptions = {
  /** 工作区（项目那一类来源的来处）。 */
  readonly workspace: WorkspaceService
  /**
   * **用户目录**（`~`）——用户那一类来源的来处（`<home>/.magic/skills` 等）。
   * 由装配给（本文件不读环境变量，同 `createProjectRules` 不读 `rules.sources` 之外的配置）。
   */
  readonly home: string
  /**
   * **用户显式配置**的补充技能目录（`skills.sources`，`~` 已由配置加载器展开）——
   * 绝对路径；既可指向「一摞技能」的目录，也可直接指向某一个技能目录。
   */
  readonly sources?: readonly string[]
  /** 上限覆盖位——缺省 `DEFAULT_SKILL_LIMITS`（测试要把超限路径跑出来时用）。 */
  readonly limits?: Partial<SkillLimits> | undefined
}

/** 技能的两种入口文件名——规范只定义了一份，故只有一个常量（`magic` 与 `agents` 共用）。 */
const SKILL_FILE = 'SKILL.md'

/** 两类默认来源下的两个子目录——**原生在前**（次序即优先级）。 */
const SKILL_DIRS = [
  { segment: '.magic', origin: 'magic' },
  { segment: '.agents', origin: 'agents' },
] as const

/**
 * 名称的**合法形态**（规范：1–64 字符，小写字母 / 数字 / 连字符，不以此开头结尾、
 * 不出现连续连字符）。
 *
 * **必须查**（不是洁癖）：这个名字就是用户敲 `/<名字>` 时敲的那一串，也是模型在
 * `skill` 工具里给的那一串——一个带空格或大写字母的名字，在两条入口上都对不上。
 * 与其让它在两处各失败一次，不如在发现这一步就说清「这个名字不成立」。
 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const MAX_NAME_CHARS = 64
const MAX_DESCRIPTION_CHARS = 1024

/** 一个**来源目录**——照优先级排好的一处（一个作用域 × 一个入口）。 */
type SourceDir = {
  /** 来源目录的绝对路径（项目 / 用户那两类不经 `realpath` 就报——读不动时说得出现场）。 */
  readonly dir: string
  readonly source: Skill['source']
  readonly origin: Skill['origin']
  /** 这一处**是用户点名的**——不存在时报 `error`（默认那几处不在是常态，不报）。 */
  readonly named: boolean
}

/**
 * 造技能来源面。
 *
 * 构造不做 I/O——扫不扫、什么时候扫由调用方定（装配提示词那一趟、以及每一次按需读取）。
 */
export function createSkills(options: SkillsOptions): Skills {
  const limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS, ...options.limits }

  return {
    discover: (): SkillCatalog => discover(options, limits),
    readMain: (name, path) => readAt(options, limits, name, path, undefined),
    readReference: (name, path, relative) => readAt(options, limits, name, path, relative),
  }
}

// ══ 发现 ══════════════════════════════════════════════════════════════

function discover(options: SkillsOptions, limits: SkillLimits): SkillCatalog {
  const skills: Skill[] = []
  const problems: SkillProblem[] = []
  /** 物理同源去重——真路径为键（软链接指同一个目录的两条入口只算一个实体）。 */
  const seen = new Set<string>()
  /** 到上限之后还剩几个没看——**如实计数并报出来**，不静默截。 */
  let skipped = 0

  for (const at of sourceDirs(options)) {
    for (const candidate of childrenOf(at, problems)) {
      if (seen.has(candidate)) continue
      // **先去重再判上限**：同一个实体经两处进来只算一个，不该占两个名额
      seen.add(candidate)

      if (skills.length >= limits.maxSkills) {
        skipped += 1
        continue
      }

      const one = readOne(candidate, at, problems, limits)
      if (one !== undefined) skills.push(one)
    }
  }

  if (skipped > 0) {
    problems.push({
      path: `skills 各来源`,
      kind: 'error',
      message:
        `技能数量到了上限 ${limits.maxSkills}，另外 ${skipped} 个没再看——` +
        `上限之外的那些**这一趟一个都没发现**（不是它们不存在）。` +
        `要收窄的话，先把用不上的技能目录挪走。`,
    })
  }

  return { skills, problems }
}

/**
 * 一次发现的**来源目录全表**——照优先级排（见文件头注「三类来源」）。
 *
 * 项目那一类的根序取 `workspace.roots()`（声明序，与别处同源）；用户与补充那两类
 * 排在项目之后。
 */
function sourceDirs(options: SkillsOptions): readonly SourceDir[] {
  const dirs: SourceDir[] = []

  for (const root of options.workspace.roots()) {
    for (const entry of SKILL_DIRS) {
      dirs.push({ dir: join(root, entry.segment, 'skills'), source: 'project', origin: entry.origin, named: false })
    }
  }

  for (const entry of SKILL_DIRS) {
    dirs.push({
      dir: join(options.home, entry.segment, 'skills'),
      source: 'user',
      origin: entry.origin,
      named: false,
    })
  }

  // 用户点名的那些：**不在这里判绝对 / 相对**——判据在 `childrenOf` 那一趟（读不动就是读不动，
  // 而相对串指哪儿取决于进程在哪儿启动，`childrenOf` 报的是那一处的原文）。
  for (const raw of options.sources ?? []) {
    dirs.push({ dir: raw, source: 'configured', origin: 'magic', named: true })
  }

  return dirs
}

/**
 * 一个来源目录下的**技能目录真路径**（一层，按目录名排序）。
 *
 * 三件如实报（都是 `error`）：
 * - 来源目录**读不动**（有它但列不出来）——底下那一摊一个都没看过；
 * - 某一项 `realpath` 取不到（坏链接 / 权限）；
 * - 某一项**不是目录**（技能目录下躺着一个同名文件）。
 *
 * 「来源目录不在」**默认那几处不报**（多数项目没有 `.magic/skills`，每次开屏报一句是噪音）；
 * **用户点名的那几处要报**——他写了那一行，就该知道自己写的指到哪儿了。
 */
function childrenOf(at: SourceDir, problems: SkillProblem[]): readonly string[] {
  // **点名的目录自己也可能是那份技能**（用户写的是 `…/my-skill`，不是「一摞」）——
  // 只对 `configured` 那一类成立：默认那几处（`.magic/skills` 等）是**容器**，
  // 它们自己不是技能（在那儿躺一份 `SKILL.md` 只是摆错了地方，不该被当成一个技能认下）。
  if (at.named && isFile(join(at.dir, SKILL_FILE))) return [realpathOf(at.dir)]

  let entries: Dirent[]
  try {
    entries = readdirSync(at.dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (at.named) {
        problems.push({
          path: at.dir,
          kind: 'error',
          message: `skills.sources 点名的目录不存在或不是目录——${reasonOf(error)}`,
        })
      }
      return []
    }
    problems.push({
      path: at.dir,
      kind: 'error',
      message: `这个技能来源目录没能列出来——${reasonOf(error)}（它底下的技能这一趟一个都没发现）`,
    })
    return []
  }

  const found: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue

    const child = join(at.dir, entry.name)
    let real: string
    try {
      // 软链接**跟出去**（规范里技能目录常常是指向别处的一份共享技能）——跟到哪儿，
      // 那儿就是只读来源；这**不**扩大执行范围（能不能对它跑工具是另一件事）
      real = realpathSync(child)
    } catch (error) {
      problems.push({ path: child, kind: 'error', message: `这一项的真身读不出来——${reasonOf(error)}` })
      continue
    }

    if (!isDir(real)) {
      problems.push({
        path: child,
        kind: 'error',
        message: '技能来源目录下只认子目录（一个子目录＝一个技能）——这一项不是目录，没当成技能。',
      })
      continue
    }

    found.push(real)
  }

  return found
}

/**
 * 读**一个技能目录的元数据**（名称 / 描述）——不读正文。
 *
 * 五件如实报（都是 `error`，这一份**不加载**）：`SKILL.md` 不在 / 读不动 ·
 * front-matter 缺失或读不懂 · `name` 不成立 · `description` 缺失或不成立。
 *
 * 「读不懂的不生效」是同一条口径（项目规约那边也是）：一份读不懂的技能照收下来，
 * 模型会按一个**内核都没看明白**的东西干活——那比不收更坏。
 */
function readOne(
  dir: string,
  at: SourceDir,
  problems: SkillProblem[],
  limits: SkillLimits,
): Skill | undefined {
  const file = join(dir, SKILL_FILE)
  const head = readHead(file, limits, problems)
  if (head === undefined) return undefined

  const front = splitFrontMatter(head)
  if (front.problem !== undefined) {
    problems.push({ path: file, kind: 'error', message: front.problem })
    return undefined
  }

  const name = front.fields['name']
  if (typeof name !== 'string' || name === '') {
    problems.push({
      path: file,
      kind: 'error',
      message: `front-matter 缺 \`name\`——技能的名字是它被调用的入口（规范：必填）`,
    })
    return undefined
  }
  if (name.length > MAX_NAME_CHARS || !NAME_PATTERN.test(name)) {
    problems.push({
      path: file,
      kind: 'error',
      message:
        `\`name\` 不成立（\`${name}\`）——规范要求：至多 ${MAX_NAME_CHARS} 字符，` +
        `只用小写字母、数字与连字符，不以连字符开头或结尾，也不出现连续连字符` +
        `（这个名字就是用户与模型敲的那一串，形态不对两边都对不上）`,
    })
    return undefined
  }

  const description = front.fields['description']
  if (typeof description !== 'string' || description.trim() === '') {
    problems.push({
      path: file,
      kind: 'error',
      message: `front-matter 缺 \`description\`——模型靠它认自己该不该用这个技能（规范：必填、非空）`,
    })
    return undefined
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    problems.push({
      path: file,
      kind: 'error',
      message: `\`description\` 太长（${description.length} 字符，规范上限 ${MAX_DESCRIPTION_CHARS}）`,
    })
    return undefined
  }

  return {
    name,
    description,
    path: dir,
    source: at.source,
    origin: at.origin,
    label: sourceLabelOf(at.source, at.origin),
  }
}

/**
 * 来源的人读标签（契约 `Skill.label`）——「哪一类来源 · 哪个入口」。
 *
 * 两段各有各的用处：**作用域**（项目 / 用户 / 配置）说「这是谁的技能」，
 * **入口**（`.magic` / `.agents`）说「它从哪个目录长出来的」。同名时两句都要有，
 * 人才分得清「项目里那个」与「我自己那个」。
 *
 * **写在这儿**（而不是消费侧各拼一遍）：这一处是唯一知道「哪个 segment 归哪个来源」的地方
 * ——别处拼的话，改一个目录名就要满仓找。
 */
function sourceLabelOf(source: Skill['source'], origin: Skill['origin']): string {
  const scope = source === 'project' ? '项目' : source === 'user' ? '用户' : '配置来源'
  const entry = origin === 'magic' ? '.magic/skills' : '.agents/skills'

  return `${scope} ${entry}`
}

/**
 * 读 `SKILL.md` 的头部若干字节——**只够 front-matter 用**（见 `maxMetadataBytes`）。
 *
 * 两件如实报：读不动（缺 / 权限 / 不是文件）· 头部就把上限吃满了（front-matter 落不下）。
 *
 * **`ENOENT` 与「读不动」分开措辞**：前者是最常见的一种手误（技能目录里没有 `SKILL.md`），
 * 说「读不出来（ENOENT: no such file…）」让人去猜系统调用的意思，不如直说。
 */
function readHead(file: string, limits: SkillLimits, problems: SkillProblem[]): string | undefined {
  try {
    // **只读这么多**（不是「整份读进来再切片」）：一份 100 MB 的 `SKILL.md` 也在这一步只花
    // 8 KiB ——上限的意义是**代价有界**，切片做不到这件事
    const buffer = new Uint8Array(limits.maxMetadataBytes)
    const handle = openSync(file, 'r')
    let bytes: number
    try {
      bytes = readSync(handle, buffer, 0, buffer.length, 0)
    } finally {
      closeSync(handle)
    }
    return new TextDecoder().decode(buffer.subarray(0, bytes))
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT'
    problems.push({
      path: file,
      kind: 'error',
      message: missing
        ? `技能目录里没有 ${SKILL_FILE}——一个技能至少要有这一份（规范：必备）`
        : `${SKILL_FILE} 读不出来——${reasonOf(error)}`,
    })
    return undefined
  }
}

// ══ 读取 ══════════════════════════════════════════════════════════════

/**
 * 取一份材料——主文（`relative` 缺省）或来源内的引用。
 *
 * **三步，缺一不可**：
 * 1. **归位**（`placeOf`）——`path` 必须是**某一个已知来源目录的直接子目录**。
 *    这一步是「不能借加载器读任意文件」的落点：不认这个身份，后面两步谈不上。
 * 2. **验明**——那份 `SKILL.md` 的 `name` 必须就是调用方给的名字。
 *    改名 / 删除 / 换了一份别的技能，都在这一步现形（**不退回同名项**）。
 * 3. **读**——引用的相对路径再验一遍边界（见 `within`），然后按上限读。
 *
 * 任何一步不过都走 `ok: false`（**判别式，不抛**）——失败是正常结果的一种，
 * 由对话侧决定「这一次交代不跑」。
 */
function readAt(
  options: SkillsOptions,
  limits: SkillLimits,
  name: string,
  path: string,
  relative: string | undefined,
): SkillRead {
  // **归位＝这一趟的发现结果里有一条身份就是它**（见 `locate`）。判据不是「路径长什么样」，
  // 而是「发现面认不认这一处」——目录软链接（发现返回的是真身）、直接点名的单技能目录
  // （发现返回的就是它自己）因此在两条路上身份一致；而来源之外的任意路径，**发现面压根
  // 不会返回它**，故照样进不来。
  const skill = locate(options, limits, path)
  if (skill === undefined) {
    return {
      ok: false,
      reason:
        `技能来源不认识「${path}」——它不在这一趟的发现结果里（发现面只有项目 / 用户的 ` +
        `.magic/skills 与 .agents/skills，以及配置里点名的那些；改名、删除、换来源都会落到这儿）`,
    }
  }
  if (skill.name !== name) {
    return {
      ok: false,
      reason:
        `技能「${name}」在 ${skill.path} 上不再成立——那一处现在叫「${skill.name}」。` +
        `来源变了就是变了，不拿同名项顶替。`,
    }
  }

  const dir = skill.path

  const file = relative === undefined ? join(dir, SKILL_FILE) : within(dir, relative)
  if (file === undefined) {
    return {
      ok: false,
      reason:
        `引用「${relative}」越出了技能目录（${dir}）——技能内的引用只能是相对技能目录的路径，` +
        `不认绝对路径，也不许用 \`..\` 绕到外面去（经软链接绕出去同样不认）`,
    }
  }

  const read = readMaterial(file, limits)
  if (!read.ok) return read

  // 主文＝**去掉 front-matter 的正文**（那段元数据不进上下文，同项目规约那一条）。
  // 解析失败**照失败报**（不交一份空正文上去）：`readOne` 那一步已经查过一遍头部，
  // 正常到不了这儿——但「正常到不了」不是可以静默给个空串的理由。
  const front = relative === undefined ? splitFrontMatter(read.text) : undefined
  if (front !== undefined && front.problem !== undefined) {
    return { ok: false, reason: `技能「${name}」的主文读不出来（${dir}）：${front.problem}` }
  }

  const text = front === undefined ? read.text : front.body
  if (text.length > limits.maxMaterialChars) {
    return {
      ok: false,
      reason:
        `${relative === undefined ? '主文' : `引用「${relative}」`}太长（${text.length} 字符，` +
        `上限 ${limits.maxMaterialChars}）——**没有送出去**：掐头去尾的技能正文比没有更坏。` +
        `按规范的做法，把长内容拆到 references/ 下的几份文件里，用到哪份取哪份。`,
    }
  }

  return { ok: true, material: materialOf(skill, text) }
}

/**
 * `path` 归位——**在发现结果里按身份找**（找不到＝这一点不在发现面里）。
 *
 * ## 为什么判据是「发现结果」而不是「路径的形状」
 *
 * 首轮用的是**父目录比对**（`dirname(真身)` 必须正是某个来源目录），它错在两处
 * ——两处都是**发现与读取各用一把尺子**，于是「列表里看得见、按返回的身份却读不出」：
 *
 * - **目录软链接**：`.magic/skills/linked -> <别处>/linked`。发现**跟出去**并把**真身**
 *   作为身份返回（契约 `Skill.path` 明写），可真身的父目录已经不在来源底下了 ⇒ 自己返回
 *   的身份自己不认识。
 * - **`skills.sources` 直接指一份技能目录**：发现返回的就是那个目录本身，
 *   它的父目录当然不是「来源目录」⇒ 同上。
 *
 * 改成「按发现结果认」之后，**发现认下的就是读取认的**（软链接、点名的单技能目录一并闭合），
 * 而边界一格没松：来源之外的任意路径**发现面根本不返回它**。
 *
 * ## 归位取**真身**
 *
 * `path` 的写法有来处——发现给的是真路径，外壳 / 用户 / 排队项手上却可能是别名
 * （macOS 上 `/tmp/x` 与 `/private/tmp/x` 是常客）。故先把给定路径取真身再比，
 * 别名因此照旧走得通；取不到真身（目录没了）时退回原串比，**自然就找不到**
 * ——那正是「来源没了」该有的结果。
 */
function locate(options: SkillsOptions, limits: SkillLimits, path: string): Skill | undefined {
  const real = realpathOf(path)

  return discover(options, limits).skills.find((skill) => skill.path === real)
}

/** `realpath`，取不到就给回原串（比较用——取不到本身就是「不匹配」）。 */
function realpathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 引用归位——相对技能目录，且**真身仍在目录内**。
 *
 * 两道都要过：
 * - **词法**（`..` 不许绕出去）——挡住 `../../etc/passwd` 这种写法；
 * - **真身**（`realpath` 之后仍在目录内）——挡住「目录里放一个软链接指到外面」。
 *   只看写法的话，后者是一条现成的绕行路（规范里的 `scripts/` 完全可以是软链接）。
 *
 * 取不到真身（不存在 / 坏链接）＝ `undefined`，与越界走同一个出口——
 * 对话侧要的都是「这份引用没取到」，措辞由上面 `readAt` 给。
 */
function within(dir: string, relative: string): string | undefined {
  if (isAbsolute(relative)) return undefined

  const lexical = normalize(join(dir, relative))
  if (!isInside(lexical, dir) || lexical === dir) return undefined

  const real = realpathOf(lexical)
  if (!isInside(real, dir) || !isFile(real)) return undefined

  return real
}

/** 读一份材料正文——读不动 / 太大都是**明确失败**（不抛、不截）。 */
function readMaterial(file: string, limits: SkillLimits): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  let bytes: number
  try {
    bytes = statSync(file).size
  } catch (error) {
    return { ok: false, reason: `${file} 读不出来——${reasonOf(error)}` }
  }

  if (bytes > limits.maxFileBytes) {
    return {
      ok: false,
      reason: `${file} 太大（${bytes} 字节，上限 ${limits.maxFileBytes}）——没有读`,
    }
  }

  try {
    return { ok: true, text: readFileSync(file, { encoding: 'utf8', flag: 'r' }) }
  } catch (error) {
    return { ok: false, reason: `${file} 读不出来——${reasonOf(error)}` }
  }
}

/**
 * 材料 —— 身份 ＋ 正文，**就这两件**。
 *
 * 首轮在这里算过一个内容版本（FNV-1a 的短串），用来锚「是哪一版」。2026-09-21 用户裁：
 * **材料动态读取，不做 hash 锚定**——用的时候读当前内容，排队期间文件变了不是缺陷。
 * 故这一串连同它的生成、传递、渲染与校验一处不留；「当时用了什么」由记录里的
 * **来源身份 ＋ 正文**答。
 */
function materialOf(skill: Skill, text: string): SkillMaterial {
  return { skill, text }
}

// ══ front-matter ══════════════════════════════════════════════════════

type FrontMatter = {
  readonly fields: Readonly<Record<string, unknown>>
  readonly body: string
  readonly problem: string | undefined
}

/**
 * 取出 front-matter——**技能这一份是必填的**（与规则文档不同：那边的 front-matter 可有可无）。
 *
 * 头一行不是 `---`：规范说「must contain YAML frontmatter」，故这**不是**「没有 front-matter」，
 * 是**写错了**——照收的话，模型会拿到一份没有名字、没有描述的东西（而这两件正是它被选中的理由）。
 *
 * YAML 交给 `Bun.YAML.parse`（与 `rules.ts` 同一处裁法：自己写词法就要自己写对 YAML 的
 * 全部边角，那不是这个单元该背的活）。
 */
export function splitFrontMatter(text: string): FrontMatter {
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return {
      fields: {},
      body: '',
      problem: `${SKILL_FILE} 开头没有 front-matter——规范要求它必须有（头一行是 \`---\`，往下一条 \`---\` 收尾，中间写 \`name\` 与 \`description\`）`,
    }
  }

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '---') continue
    end = index
    break
  }

  if (end === -1) {
    return {
      fields: {},
      body: '',
      problem: 'front-matter 没闭合——头一行是 `---`，往下再没有第二条 `---`（补上收尾那条）',
    }
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')

  let value: unknown
  try {
    value = Bun.YAML.parse(lines.slice(1, end).join('\n'))
  } catch (error) {
    return { fields: {}, body, problem: `front-matter 读不懂（YAML）：${reasonOf(error)}` }
  }

  if (value === null || value === undefined) {
    return { fields: {}, body, problem: 'front-matter 是空的——`name` 与 `description` 都必填' }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      fields: {},
      body,
      problem: `front-matter 得是一组「键: 值」，读到的${Array.isArray(value) ? '是一个列表' : `是「${String(value)}」`}`,
    }
  }

  return { fields: value as Record<string, unknown>, body, problem: undefined }
}

// —— 小件 ——

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 抛出的原委——`Error` 取 `message`，其余照字面（与执行域别处同一口径）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
