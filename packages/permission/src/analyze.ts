/**
 * 机械分析 —— 判定（该不该问）与呈现（怎么问）的**唯一入口**。
 *
 * 出处：技术方案 · 权限：判定 ＝ 内核的机械分析——工具调用是结构化的（工具名 ＋ 参数）：
 * 命令可解析、路径可比对工作区边界、读写类型天然可分；**不押模型自述**。
 * 姿态：**默认通**——`exec` 上**只剩改权限那一类要问**（删除那一类 U77 起**直接拒**，
 * 见下），另有**工具自己的那几处必闸**；**判不出来的按默认通**（U76 · 2026-09-25 用户定）。
 *
 * 本域只做**域内机械分析**：不 import 执行域 / 工具域，不碰文件系统（域间只经契约）。
 * 故凡需「文件是否存在 / 内容是什么」才能判的形态（如 `write` 的新建 vs 覆盖）
 * **本域判不出**——**在工具那一路上照旧按不可逆假定问**（U76 的射程只到 `exec`）。
 *
 * ## `weight` 是什么（U76 起，两路各表）
 *
 * `weight` 仍是「要不要过闸」那一问的**唯一产出**，但**两路的底不一样**了：
 *
 * - **`exec` 那一路**（`analyzeExec` → `commands.ts`）：**默认通**——**判重的只剩
 *   改权限 / 属主 / 属性 / ACL 那一类**（删除那一类 U77 起走**另一形**：`refusal`，
 *   见 `AnalysisRefused`），其余（移动 · 覆盖 · 破坏性 git · `sudo` 那类 · 越界 · 外发 ·
 *   `trash` · **判不出来**）一律判轻 ⇒ 不必配规则就过。
 *   （U76 把底从"默认问"翻成"默认通"；**U77 把删除移出"问"那一档**。）
 * - **非 `exec` 那一路**（`write` · `edit` · `web_fetch` · MCP 外部操作 · 表外工具）：
 *   **一个字没动**——判重的仍判重（`write` 的判不出 · `edit` 的越界 · 取网页的外发 ·
 *   外部操作一律必闸）。⚠️ **射程只到 `exec`**（工单明文），别顺手把这一路也放宽：
 *   那几处的例外（`byHost` 按域名）正是靠"判重"立着的。
 *
 * 阶段 1 全人工门下本节只定呈现轻重；阶段 2 起清单是自动放行禁区（U14）——
 * **U77 之后那份清单只剩一条**（改权限），且链的底是**默认通**（见 `gate.ts` 头注）。
 */

import type {
  DangerReason,
  DecisionWeight,
  ExternalToolRef,
  PermissionContext,
  RefusalKind,
  ToolCall,
} from '@magic/contracts'
import { mcpToolLabel, parseMcpToolName, webTargetOf } from '@magic/contracts'
import type { SegmentAnalysis } from './commands.ts'
import { OP_LABEL, OP_REASON, decompose } from './commands.ts'
import type { RuleOp } from './ops.ts'
import type { Landing } from './paths.ts'
import { describeLanding, landPath } from './paths.ts'

/**
 * 一次调用的分析结论。
 *
 * - `weight: 'heavy'` ＝ 必闸类（技术方案 · 权限：危险分级 v0 必闸清单）——材料须给足判断依据；
 * - `weight: 'light'` ＝ 放行区方向（读与搜索 · 新建 · 增量编辑 · 只读命令）；
 * - `reason` 只在 `heavy` 时给——命中的必闸判据（`unknown` ＝看不懂）；
 * - `ops` / `landings` ＝ **规则轴**（阶段 2）：规则条目是（工具 × 路径模式 × 操作类型），
 *   后两格照这两个字段比对。它们与 `weight` **同一处产出**——规则匹配与危险判定读的是
 *   同一份结论，两条路径因此结构上无从分叉（必闸 ＞ 规则 ＞ 默认问）；
 * - `host`（U72）＝ **规则轴上的第四格**，只在「取网页」那一件上有值：外发的去向是**域名**，
 *   它不是路径（不落在任何根里）、也不是操作类型（`outbound` 已经说了「往外发」）。
 *   给它单列一格而不是塞进路径：两条判据的语义毫不相干，混用会让「根内那几个字」
 *   突然要能匹配域名（`rules.ts` 的 `matchesHost` 与 `matchesPath` 因此各判各的）。
 */
export type Analysis = AnalysisPass | AnalysisRefused

/** 「问 ／ 通」那一形——**判据决定轻重**，闸门照轻重走（见 `AnalysisRefused` 的反面）。 */
export type AnalysisPass = {
  /** **`refusal` 缺席是这一形的判据**（判别式）——见 `AnalysisRefused`。 */
  readonly refusal?: undefined
  readonly weight: DecisionWeight
  readonly reason?: DangerReason
  readonly material: string
  /** 本次调用的**操作类型**——多段命令取并集（每一段都算数）。 */
  readonly ops: readonly RuleOp[]
  /** **影响面词条**——路径模式的对照面（与越界判据同一处产出）。 */
  readonly landings: readonly Landing[]
  /**
   * **卡上那个名字**（U38）——缺省（不给这一位）＝ `ToolCall.name`（内置工具照旧）。
   *
   * 外部工具给的是 **`服务器 / 工具`**：身份由注册表来，措辞由本域一处产出
   * （外壳不自己拼字符串——两处各拼一份，改一处漏一处）。
   */
  readonly title?: string
  /** **这一次是外部操作**（U38）——外壳据以换口径（效果由服务器决定）、不给「总是允许」。 */
  readonly external?: boolean
  /**
   * **这一次发往哪个域名**（U72）——取网页那一件给得出就给。
   *
   * 它同时是**规则轴多出来的那一格**（`rule.host`）：卡上说清去向、「总是允许」按域名记，
   * 两件事读的都是这一个值（见 `Analysis` 头注那条「一处产出」）。
   * 给不出（地址不合格 / 参数读不出）＝缺席——那时**没有可记的域名**，
   * 规则那一格也无从比对（见 `rules.ts` 的 `matchesHost`）。
   */
  readonly host?: string
}

/**
 * **内核直接拒**那一形（U77）——删除那一类（设计 · 权限「`rm` 直接拒，指路 `trash`」）。
 *
 * ## 为什么另立一形，而不是给 `AnalysisPass` 添一格布尔
 *
 * 因为**次序错一步就是灾难**：拒的那一笔若落到"默认通 / 全放行"那一条支上，
 * `--allow-all` 之下 `rm` 就会被**放行**——而这一单要的恰恰是**全放行也照拒**。
 * 做成判别联合之后，**`weight` 在这一形上根本不存在**：闸门想读它必须先分支，
 * 「忘了先判拒」**编译期就报**（不是靠注释提醒）。
 *
 * ## 这一形上有什么
 *
 * - `refusal` ＝**拒的理由**（两支，措辞不同，见契约 `RefusalKind`）；
 * - `material` ＝ 同一份命令分解（**为什么出格**照旧说得出来：`判据：不可逆（收不回）`）
 *   ——它如今不上面板（没有卡），留着是为了审计与用例读得出同一个结论；
 * - `ops` / `landings` / `title` / `external` / `host` ＝ 与另一形同义（规则轴与呈现的原料，
 *   一律照旧产出——**别让"拒了"变成"少算了几格"**）。
 *
 * ⚠️ **不受 `--allow-all` 影响**：那一档只动「问不问」（三个维度里的第一个），
 * 而这里拒的理由是「**这个命令不可逆**」——两件事不混（规划侧定，见工单）。
 */
export type AnalysisRefused = {
  readonly refusal: RefusalKind
  readonly material: string
  readonly ops: readonly RuleOp[]
  readonly landings: readonly Landing[]
  readonly title?: string
  readonly external?: boolean
  readonly host?: string
}

/**
 * 判据的中文（材料用——呈现是给人的）。
 *
 * ⚠️ **`system` 那一行 U76 改过措辞**：从前它说的是「提权 · 系统」那一大类
 * （`sudo` · `brew` · `systemctl` …），如今**只有改权限 / 属主 / 属性 / ACL 那一族**
 * 产出它（名单第二类，见 `commands.ts` 的 `PERMISSION`）——措辞跟着收窄，
 * 不然卡上会给 `chmod` 配一句「机器全局 / 已装环境」，读着不对。
 *
 * 其余几行仍是**非 `exec` 那一路**在用的（`write` 的判不出 · `edit` 的越界 ·
 * `web_fetch` 的外发 · MCP 的外部操作）——那一路本单没动（工单：射程只到 `exec`）。
 */
const REASON_LABEL: Readonly<Record<DangerReason, string>> = {
  external: '外部操作（效果由服务器决定）',
  irreversible: '不可逆（收不回）',
  'out-of-bounds': '越界（工作区之外）',
  system: '系统级（改权限 / 属主 / 属性 / ACL）',
  outbound: '外发（出去即收不回）',
  unknown: '看不懂（无法归类——按不可逆假定问）',
}

/** 判据的代表序——具体优先（外部 / 越界 / 系统 / 外发 ＞ 不可逆 ＞ 看不懂）。 */
const REASON_ORDER: readonly DangerReason[] = [
  'external',
  'out-of-bounds',
  'system',
  'outbound',
  'irreversible',
  'unknown',
]

/** 取代表判据（多中时按 `REASON_ORDER`）。 */
function representative(reasons: readonly DangerReason[]): DangerReason | undefined {
  return REASON_ORDER.find((reason) => reasons.includes(reason))
}

// —— 外部工具（MCP · U38）——

/**
 * 取这次调用的**外部身份**——两处来路，**都不是模型能自报的**：
 *
 * 1. `call.external` ＝**注册表给的**（分发查表之后附上）——**权威**，它在就用它；
 * 2. 名字的形态（`mcp__<服务器>__<工具>`）——注册名由内核合成，名字对不对**由注册表说了算**
 *    （执行那一步会查表；表里没有就是「未注册的工具」，跑不起来）。用它是为了**从严**：
 *    一个抄了外部名字、却没在表里的调用**照样按外部问**，不会掉进更宽的那条路。
 *
 * 参数里写个 `server` 字段冒充来源在这两处都一文不值——本域从头到尾不读它。
 */
function externalOf(call: ToolCall): ExternalToolRef | undefined {
  return call.external ?? parseMcpToolName(call.name)
}

/**
 * 外部操作——**一律必闸**（`weight: 'heavy'`），且**不给规则放行的口子**。
 *
 * 三条判据各有出处：
 * - **必闸**——「第一版沿用未知外部操作的人工闸门」（设计明文）；禁区的判据不押规则作者的
 *   自觉，故命中了任何规则也照问（`gate.ts` 的「必闸 ＞ 规则」那一格）；
 * - **不因自报放权**——服务器自报的只读 / 幂等（MCP 的 `annotations`）**不进这里**，
 *   也不影响 `weight`（`defineMcpTools` 那侧就不读它）。重试同理：不是「它说幂等」就能重放；
 * - **不说可逆 / 不可逆**——本机判不出效果，口径由契约那句 `MCP_EXTERNAL_CAVEAT` 说了算
 *   （卡上的副题由外壳渲染，本域只给身份与 `external` 那一位）。
 *
 * 材料只给**参数**（卡上的标题已经是 `服务器 / 工具 · 外部操作 · 效果由服务器决定`）——
 * 一屏上的每一条各说一件别处没说的，别把身份再说一遍。
 */
function analyzeExternal(
  call: ToolCall,
  ref: ExternalToolRef,
  registered: boolean,
): Analysis {
  const lines: string[] = []

  // 名字像外部工具、可注册表里没有它——说清这一件（它仍按外部问，不会掉到宽的那条路上）
  if (!registered) {
    lines.push('这一件不在已配置的服务器工具表里（名字像外部工具，但注册表里没有它）。')
  }
  if (call.invalid === true) {
    lines.push('参数解析不出（模式不符 / JSON 残缺）——调用形态不可信。')
  }

  lines.push('参数：', ...parameterLines(call.args))

  return {
    weight: 'heavy',
    reason: 'external',
    material: lines.join('\n'),
    // 操作类型记 `unknown`（判不出它做了什么）——它同时保证没有规则命中这一格
    // （规则是「工具 × 路径模式 × 操作类型」，而必闸类本来就够不着规则那条路）
    ops: ['unknown'],
    landings: [],
    title: mcpToolLabel(ref),
    external: true,
  }
}

/** 业务参数的呈现——**折叠但完整**（不给省略 JSON：审批看的就是这一份实际参数）。 */
function parameterLines(args: Readonly<Record<string, unknown>>): readonly string[] {
  const json = JSON.stringify(args, null, 2)
  // 参数不是可序列化的值（循环引用一类）——照实说，不编一个空对象糊过去
  if (json === undefined) return ['（参数无法序列化——原样如下）', String(args)]
  return json.split('\n')
}

// —— 参数取值 ——

/**
 * 命令字段名——**单一键**（技术方案 · 工具：参数键部分锚定——`exec` 的命令字段名＝`cmd`）。
 * 取不到即从严（不再按候选键兜底：写错的键名不该被猜中）。
 */
const COMMAND_KEY = 'cmd'

/** 路径字段的候选键——`path` / `file` / `dir` 系的常见拼法（去分隔符后比对）。 */
function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  return (
    normalized === 'path' ||
    normalized === 'filepath' ||
    normalized === 'file' ||
    normalized === 'filename' ||
    normalized === 'dir' ||
    normalized === 'dirname' ||
    normalized === 'directory' ||
    normalized === 'target' ||
    normalized === 'cwd' ||
    normalized === 'root' ||
    normalized.endsWith('path') ||
    normalized.endsWith('dir') ||
    normalized.endsWith('file')
  )
}

function firstString(
  args: Readonly<Record<string, unknown>>,
  match: (key: string) => boolean,
): { readonly key: string; readonly value: string } | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && match(key)) return { key, value }
  }
  return undefined
}

// —— 兜底：看不懂从严 ——

/**
 * 看不懂 —— 唯一的兜底出口。**按不可逆假定问**（技术方案 · 权限：危险分级 v0 末条）。
 *
 * 材料只陈述**为什么判不出**——不假装知道风险在哪；判断交给人。
 */
export function unclassifiable(tool: string, why: string): Analysis {
  return {
    weight: 'heavy',
    reason: 'unknown',
    material: [
      `工具：${tool}`,
      `判不出：${why}`,
      `处置：按不可逆假定问（${REASON_LABEL.unknown}）。`,
    ].join('\n'),
    ops: ['unknown'],
    landings: [],
  }
}

// —— 主入口 ——

/**
 * 分析一次工具调用。
 *
 * **兜底即从严**：分析表覆盖不到的形态一律 `heavy` · `reason: 'unknown'`——
 * 「漏判即按『看不懂』入单」（技术方案 · 权限：危险分级维护条）。
 *
 * 分析表**对标工具集 v1 的静态危险归类**（`ToolSpec.danger`）：静态归 `by-call` 的
 * （`exec` · `write`）在此**按调用落定**——这正是「按调用判定」的落点。
 *
 * ## 第三参：内核自己的只读落点（U80）
 *
 * ⚠️ **只交给「读与搜索」那一支**（`analyzeSearch`）——`edit` / `write` / `exec` 一律不接，
 * 故往那几处写 / 删 / 移**照旧判根外**（判据见 `landPath` 头注那三条分寸）。
 * 「哪几处」由闸门给（`PermissionGateOptions.readOnlyDirs`），缺省＝一处都不认。
 */
export function analyze(
  call: ToolCall,
  ctx: PermissionContext,
  readOnlyDirs?: readonly string[],
): Analysis {
  // **外部调用先认身份**（U38）——参数解析得出与否都不改变「这是一次外部操作」：
  // 身份有两处来路，都**不是模型说的**（见 `externalOf`）。
  const external = externalOf(call)
  if (external !== undefined) return analyzeExternal(call, external, call.external !== undefined)

  // 参数都没解析出来，工具名与参数都不可信——最先归「看不懂」
  if (call.invalid === true) {
    return unclassifiable(call.name, '参数解析不出（模式不符 / JSON 残缺）——调用形态不可信')
  }

  switch (call.name) {
    case 'exec':
      return analyzeExec(call, ctx)
    case 'read':
    case 'grep':
    case 'glob':
    case 'ls':
      return analyzeSearch(call, ctx, readOnlyDirs)
    case 'edit':
      return analyzeEdit(call, ctx)
    case 'write':
      return analyzeWrite(call, ctx)
    case 'skill':
      return analyzeSkill(call, ctx)
    case 'web_fetch':
      return analyzeWebFetch(call, ctx)
    case 'plan_read':
    case 'history_read':
      return analyzeSessionRead(call.name)
    case 'plan_update':
      return analyzePlanUpdate()
    default:
      return unclassifiable(call.name, `工具「${call.name}」不在机械分析表内`)
  }
}

// —— 计划与历史（U34 · 三个会话内置辅助工具）——

/**
 * **三个内置辅助工具**（`plan_read` / `plan_update` / `history_read`）——**一律轻**。
 *
 * ⚠️ 这三格**必须显式写**（与 `skill` 那格同一条理由，见其注）：分析表覆盖不到的形态
 * 一律兜底 `heavy`，而 `ToolSpec.danger` **不参与**这条判定——不写，它们每次调用都会弹卡。
 *
 * ## 为什么是轻
 *
 * 三件只动**同一份协作笔记与会话记录**（设计：读写与历史查询绑定当前会话）：
 * - **不碰工作区**——没有文件被读被写被删，故 `landings` 为空、操作类型只有读 / 改笔记；
 * - **不给模型新的可达面**——会话 id 与记录位置都不是参数（工具入口那一侧卡死），
 *   模型给不出第二个会话、也指不了库文件或任意 blob；
 * - **不外发、不执行**——不出网、不起进程（`@magic/tools` 那三件不接沙箱）。
 *
 * 故它们与「放行区：读与搜索」同类，走既有的「轻操作 ＋ 规则命中」放行路径
 * （装配按名字追加内存规则，见 `@magic/app` · `assembly.ts`）。
 *
 * ## 影响面为空，规则只能按名字写
 *
 * `landings: []` 是有意的：这三件**没有路径可判**（它们不解析任何参数中的路径）。
 * 于是「缺省路径＝根内」那一格对它们恒真（`rules.ts`：空影响面不受路径格约束），
 * 规则轴实际上按**工具名**命中——正是装配要的那一种窄规则。
 */
function analyzeSessionRead(tool: string): Analysis {
  const what =
    tool === 'plan_read'
      ? '读的是这个会话的计划笔记（步骤清单与辅助笔记）'
      : '读的是这个会话的一段实际记录（用户交代、助手答复、工具调用与结果）'

  return {
    weight: 'light',
    material: [`${what}——不碰工作区里的文件。`, '会话由内核绑定：调用的参数里没有会话标识。'].join('\n'),
    ops: ['read'],
    landings: [],
  }
}

/** 更新笔记（`plan_update`）——写的是协作笔记，不是工作区里的文件。 */
function analyzePlanUpdate(): Analysis {
  return {
    weight: 'light',
    material: [
      '写的是这个会话的计划笔记（整体替换或清空）——不碰工作区里的文件。',
      '它保存模型的判断，不验证工作完成、也不控制执行。',
    ].join('\n'),
    // 操作类型记 `edit`（改的是已有笔记），不记 `overwrite`：后者的词义是整写文件，
    // 混进来会让「放行整写」一类规则意外覆盖到它（虽然规则还要过路径那一格）
    ops: ['edit'],
    landings: [],
  }
}

/**
 * **技能读取**（`skill` · U33）——**只读材料，一律轻**。
 *
 * ⚠️ 这一格**必须显式写**（不能只靠 `ToolSpec.danger: 'light'` 声明）：
 * 分析表覆盖不到的形态一律兜底 `heavy`（「漏判即按看不懂入单」），
 * 而 `ToolSpec.danger` **不参与**这条判定——不写这一格，`skill` 每次调用都会弹卡。
 *
 * **为什么是轻**：它读的是**技能目录**（只读来源），不是工作区里的动作，
 * 与「放行区：读与搜索」同类。而**边界不由这一格担保**——能读哪些由工具入口
 * （`Skills` 端口）按已发现身份与来源内相对引用卡死：`..` 越出、绝对路径、
 * 软链接绕出去，在那边就拒了。闸门这一层只需要知道「这不是一次写动作」。
 *
 * **不收回执的落点**：不因为 `skill` 是「本单新加的」，就顺带放宽别的未知工具——
 * 兜底那一支一个字没动（`default` 仍是 `unclassifiable`）。
 *
 * **没有影响面词条**（`landings: []`）：模型**给不出**技能目录。原先它手上有个 `source`
 * 参数（同名有多个来源时用它指明取哪一个），那一格就是拿它算的；同名在发现那一层只剩一条
 * 之后那个参数收掉了（见 `@magic/tools` 的 `skill-tool.ts`），落点也就没有来处——
 * 「按名字取哪一份」由工具入口按已发现的身份归位，与「模型指了哪儿」无关。
 * ⚠️ 技能目录**可能在**工作区之外（用户目录下的 `~/.magic/skills`），但这**不构成越界必闸**
 * ——必闸清单的越界条目管的是「工作区外的**写 / 删 / 移**」，读材料不在此列
 * （同 `analyzeSearch` 那条口径）。
 */
function analyzeSkill(call: ToolCall, _ctx: PermissionContext): Analysis {
  const path = firstString(call.args, (key) => key === 'name')
  const what = path === undefined ? '技能材料' : `技能「${path.value}」的正文或引用`

  return {
    weight: 'light',
    material: [`读的是一份只读材料：${what}`, '来源：技能目录（按名字取，落点由工具入口按已发现的身份归位）'].join('\n'),
    ops: ['read'],
    landings: [],
  }
}

/**
 * **取网页**（`web_fetch` · U72）——**外发 ⇒ 必闸**，而「总是允许」**落在域名上**。
 *
 * ## 为什么必闸
 *
 * 必闸清单里「外发」那一条（设计 · 工具执行与权限）管的就是这一件：请求发出去即收不回。
 * 它同时是**唯一一条说得出去处**的外发——`exec` 跑 `curl` 时去向藏在命令行里、
 * 由命令分析去猜；这一件的去处就是参数里那一个域名，**照实写出来**正是卡该做的事。
 *
 * ## 「总是允许」为什么按域名给（而不是按工具）
 *
 * 按工具给＝「取网页」这一类从此不再问 ⇒ 往后的每一次取网都自动放行，**包括从没见过的域名**；
 * 那正好把外发这一条必闸掏空。按域名给＝用户答的是「**往这家发**」这一件事，换一家照问
 * ——这一件里「总是允许」的实际含义本来就是它（设计 · 网页与搜索：「按域名给，不按工具给」）。
 *
 * ## 落点：`Analysis.host` ＋ 规则那多出来的一格
 *
 * `host` 交出去之后有两位用处，都在这一个值上（`host` 的注）：
 * 卡上写清去向（`tool.decision.request.host`）；授权凝成 `{tool, op, host}` 那一条
 * （`grants.ts` 的 `grantOf`），于是「同一域名不再问、别的域名照问」是**匹配本身**的结果。
 *
 * ⚠️ **没有域名的不给授权**：参数里读不出合格地址（本机 / 无点 / 非 http(s)）时 `host` 缺席，
 * 那时 `a` 根本不给（卡上那一格没有）——「总是允许」记的是一个**域名**，
 * 而这个调用没有域名可记。工具那一侧会**在发请求之前**拒（同一个 `webTargetOf`）。
 */
function analyzeWebFetch(call: ToolCall, _ctx: PermissionContext): Analysis {
  const raw = call.args['url']
  const target = webTargetOf(raw)

  // 地址不合格——**它一个字节都发不出去**（工具在发请求之前就拒）。这一步仍照必闸问：
  // 分析表覆盖不到的形态一律兜底从严，而这一件本就是必闸类；材料照实说清「不会发出去」，
  // 让人看明白这一张卡批的是什么。⚠️ 不给 `host`（没有域名可记，见上注）。
  if (!target.ok) {
    return {
      weight: 'heavy',
      reason: 'outbound',
      material: [
        `工具：${call.name}`,
        `这个调用取不得：${target.reason}`,
        '处置：不会发出任何请求；批准与否都不改变这一点（要访问这类地址，用 exec ＋ curl）。',
      ].join('\n'),
      ops: ['outbound'],
      landings: [],
    }
  }

  const asked = firstString(call.args, (key) => key === 'prompt')

  return {
    weight: 'heavy',
    reason: 'outbound',
    material: [
      `取网页：GET ${target.url}`,
      `域名：${target.host}`,
      '外发：只把上面这个地址发过去——问的是什么、看的是什么，都不会发到这个站点。',
      ...(asked === undefined ? [] : [`问的是：${oneLine(asked.value)}`]),
    ].join('\n'),
    ops: ['outbound'],
    landings: [],
    host: target.host,
  }
}

/**
 * 一句话压成一行（材料是**逐行**铺的，换行会把卡上的行数撑开）。
 * 只做这一件事，不截断——参数原样看得见是卡的规矩（`parameterLines` 同此）。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * **路径必填**的读类工具——照**参数键全表**（契约 · 工具：`read` —— `path`，
 * 而 `ls` / `grep` / `glob` 是 `path?`）。「缺席合不合法」只认这张表。
 */
const PATH_REQUIRED_TOOLS: readonly string[] = ['read']

/**
 * 「没给路径」的落点＝**默认根**——`.` 经 `landPath` 的「相对按默认根」正好归一出
 * 默认根本身，与执行域同一判据（不另造一条算法）。
 */
const DEFAULT_ROOT = '.'

/**
 * 读与搜索（`read` · `grep` · `glob` · `ls`）——**放行区方向，一律轻**。
 *
 * 读的**越界不闸**：必闸清单的越界条目限「**工作区外的写 / 删 / 移**」，
 * 而放行区明列「读与搜索」（技术方案 · 权限：放行区）。
 *
 * **没给路径**的形态（缺陷 D15）按**参数键全表**分两种——「可选键缺席即取缺省」是通则：
 * - `ls` / `grep` / `glob` 的 `path` **是可选键**，而缺省就是**默认根**
 *   （工具 schema 的说明一字不差：「缺省＝工作区根」）⇒ `ls {}`（列当前目录）是
 *   **合法且常见**的形态，仍归**轻**；
 * - `read` 的 `path` **是必填**——缺了就是模式不符的调用（工具那边回 `OUTPUT_PATH_REQUIRED`），
 *   此处**不假装知道落点** ⇒ 归「判不出」。
 *
 * ⇒「判不出」只留给**真正看不懂**的形态，不再兜住「没给参数」这种合法写法。
 *
 * ## 内核自己的只读落点（U80）——**只有这一支**接那位
 *
 * 读类调用的落点除各根之外**另认几处**（`readOnlyDirs`，当前一处：`exec` 后台那一形的
 * 输出目录）——那是**我们自己的产物**、不是用户的东西 ⇒ **不算越界**。
 * 由头与三条分寸见 `paths.ts` · `landPath` 的头注；**「哪几处」不在这儿拼**，由闸门给。
 *
 * ⚠️ **只有读与搜索这一支接**：本支出的操作类型恒为 `read`，而这四件也正是「读材料」那一类
 * （设计 · 权限：「读材料不在此列」）。`edit` / `write` / `exec` 那三支**不接**——
 * 往那处**写 / 删 / 移照旧判根外**（「认一处」不等于「放一片」，那是本单的要害）。
 *
 * ⚠️ **与沙箱那一半的分寸不完全对称**（如实记）：执行域那处只认 `read` 一件
 * （`SandboxOptions.readOnlyDirs`：`list` / `match` 都不认），而这一支是**读与搜索一类四件**。
 * 于是 `ls` / `grep` / `glob` 点名那处时，**判据上算根内、执行上仍够不着**（沙箱照旧回越界）。
 * 这一格**不是本单的射程**（工单明写「不动 U70 已经落的那半」）——此处不按工具名分两路，
 * 正是因为「判据落在一处，别散」：**归类的边界是「读材料」这一类，不是某几个工具名**。
 */
function analyzeSearch(
  call: ToolCall,
  ctx: PermissionContext,
  readOnlyDirs?: readonly string[],
): Analysis {
  const path = firstString(call.args, isPathKey)

  if (path === undefined && PATH_REQUIRED_TOOLS.includes(call.name)) {
    return unclassifiable(call.name, `参数里缺必填的路径字段（参数键全表：${call.name} 的 path 必填）`)
  }

  const landing = landPath(path?.value ?? DEFAULT_ROOT, ctx, readOnlyDirs)
  const material =
    path === undefined
      ? `影响面：${describeLanding(landing)}（调用没给路径——参数键全表：缺省＝默认根）`
      : `影响面：${describeLanding(landing)}`

  return { weight: 'light', material, ops: ['read'], landings: [landing] }
}

/** 增量编辑（`edit`）——放行区方向（diff 可审）；**但工作区外的写＝必闸**。 */
function analyzeEdit(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  if (landing.inside) {
    return { weight: 'light', material: `影响面：${describeLanding(landing)}`, ops: ['edit'], landings: [landing] }
  }

  return {
    weight: 'heavy',
    reason: 'out-of-bounds',
    material: impact([landing], '工作区外的写——**工具侧的**必闸：越界（技术方案 · 权限：必闸清单 · 越界）。'
        + '⚠️ `exec` 那一路的名单收缩（U76）**只到命令那一层**——这两处是工具自己的判定，不在那次收缩的射程里。'),
    ops: ['edit'],
    landings: [landing],
  }
}

/**
 * 整写（`write`）——静态归类 `by-call`：**新建＝轻；覆盖＝必闸**。
 *
 * ⚠️ 判不出：权限域**不碰文件系统**（域间只经契约、fs 边界归执行域），问不到「文件在不在」。
 * 故一律按**覆盖**假定——即「看不懂从严」（技术方案 · 权限：危险分级 v0 末条）。
 * 存在性若由调用方带进来（参数模式补 `overwrite` 之类），此处即可分流——见回报「待决」。
 */
function analyzeWrite(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  // 操作类型记 `overwrite`：按**覆盖**假定（判不出新建还是覆盖＝从严那一侧），
  // 故本格的显示与规则都按「整写」认它——待存在性进得来（见回报「待决」）再分流 `create`。
  const ops: readonly RuleOp[] = ['overwrite']

  if (!landing.inside) {
    return {
      weight: 'heavy',
      reason: 'out-of-bounds',
      material: impact([landing], '工作区外的写——**工具侧的**必闸：越界（技术方案 · 权限：必闸清单 · 越界）。'
        + '⚠️ `exec` 那一路的名单收缩（U76）**只到命令那一层**——这两处是工具自己的判定，不在那次收缩的射程里。'),
      ops,
      landings: [landing],
    }
  }

  return {
    weight: 'heavy',
    reason: 'unknown',
    material: [
      `影响面：${describeLanding(landing)}`,
      '判不出：新建还是覆盖——本域不碰文件系统，问不到存在性。',
      `处置：按不可逆假定问（覆盖＝必闸——工具集 v1：write 新建＝轻、覆盖＝必闸）。`,
    ].join('\n'),
    ops,
    landings: [landing],
  }
}

// —— exec ——

/**
 * 命令执行（`exec`）——静态归类 `by-call`：**按命令解析**。
 *
 * 逐段分解 → 归类 → 越界比对；多段取并集，**任一段入必闸即重**。
 */
function analyzeExec(call: ToolCall, ctx: PermissionContext): Analysis {
  const command = firstString(call.args, (key) => key === COMMAND_KEY)
  if (command === undefined) {
    return unclassifiable('exec', `参数里找不到命令字段（该字段名锚定为「${COMMAND_KEY}」）`)
  }

  const segments = decompose(command.value, ctx)
  return judge(segments)
}

/**
 * 逐段裁决 → 轻重 ＋ 代表判据 ＋ 命令分解材料。
 *
 * **逐段判、取最严**（设计明文）：`&&` / `;` / `|` 串起来的**每段各自判**，
 * 一段的无害**不许被别段带累**，反过来一段入名单也**不许被别段冲淡**——
 * `cd x && rm -rf y` 里那段 `rm` **照落名单**（这正是「复合命令按段判」那一半要的效果）。
 *
 * ⚠️ **这里只收「入名单」那两类判据**（`OP_REASON` 给得出东西的才收）：
 * 越界 · 外发 · 覆盖 · 移动 · 判不出**一律不再入判据**（U76：它们不在名单里）。
 * 影响面词条照旧逐段取（`segment.landings`）——材料要说得清它动了哪儿，
 * 但**动过哪儿不等于要拦**：越界那一条撤了（设计 · 权限：`sudo` · 越界 · 外发都默认通）。
 */
function judge(segments: readonly SegmentAnalysis[]): Analysis {
  const reasons: DangerReason[] = []

  for (const segment of segments) {
    const reason = OP_REASON[segment.op]
    if (reason !== undefined) reasons.push(reason)
  }

  const reason = representative(reasons)
  const material = renderDecomposition(segments, reason === undefined ? [] : reasons)

  // 规则轴：操作类型取**并集**（每一段都算数——规则须覆盖全部才命中），
  // 影响面取各段词条之并
  const ops = [...new Set(segments.map((segment) => segment.op))]
  const landings = segments.flatMap((segment) => segment.landings)

  // **删除那一类先落地**（U77）——一段落拒，整条就拒（逐段判、取最严那一半）。
  // 一支里同时有 `rm` 与 `shred` 时取 `no-substitute`（**不给替代**那一支）：
  // 指路说"用 trash"在那种串里是**错的**（`shred` 那半截换个更弱的做法就是没照它办）。
  const refusals = segments.map((segment) => segment.refusal).filter((one) => one !== undefined)
  const refusal: RefusalKind | undefined = refusals.includes('no-substitute')
    ? 'no-substitute'
    : refusals[0]

  if (refusal !== undefined) return { refusal, material, ops, landings }

  return reason === undefined
    ? { weight: 'light', material, ops, landings }
    : { weight: 'heavy', reason, material, ops, landings }
}

/** 命令分解 —— 重呈现的判断材料（逐段：做了什么 · 影响面）。 */
function renderDecomposition(
  segments: readonly SegmentAnalysis[],
  reasons: readonly DangerReason[],
): string {
  const lines = [`命令分解（${segments.length} 段）：`]

  segments.forEach((segment, index) => {
    lines.push(`  ${index + 1}. ${segment.raw} —— ${OP_LABEL[segment.op]}`)

    for (const landing of segment.landings) lines.push(`       影响面：${describeLanding(landing)}`)
    for (const note of segment.notes) lines.push(`       ${note}`)
  })

  const unique = REASON_ORDER.filter((candidate) => reasons.includes(candidate))
  if (unique.length > 0) {
    lines.push(`判据：${unique.map((candidate) => REASON_LABEL[candidate]).join(' · ')}`)
  }

  return lines.join('\n')
}

/** 单路径工具的影响面材料。 */
function impact(landings: readonly Landing[], why: string): string {
  return [`影响面：${landings.map(describeLanding).join('；')}`, `判据：${why}`].join('\n')
}
