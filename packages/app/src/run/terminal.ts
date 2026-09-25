/**
 * **终端这一端**（U48）——把一条到管理者的连接，接成外壳要的那几件。
 *
 * 设计明文：「**终端**：呈现与输入客户端，断流后自身应退出，不能空转充当后台执行者。
 * **空白启动页只有客户端，没有会话和执行者。**」这句话在这里是**结构上的**：
 *
 * | 装配那五步 | 窗口这一侧 |
 * | --- | --- |
 * | 记录域（开库 / 迁移 / blob） | **不造**——窗口一个字都不往库里写，也不开那条连接 |
 * | 外部工具服务器（拉进程） | **不造**——工具归执行者 |
 * | 权限闸门 · 工具域 · 对话域 | **不造**——它们在执行者那一头 |
 * | 控制域 | **不造**——命令与事件经管理者转，不经同进程通道 |
 * | **读配置 · 认工作区 · 认当下那个模型的窗** | 造——**呈现要它们**，且三件都不落盘、不起进程 |
 *
 * 最后一行那句话是这一层存在的全部理由：外壳要画出开屏那一屏（状态行 ④ 的分母、
 * `/resume` 的分组），而那几格**只有配置说得出来**。让窗口为了显示一个数去开库、
 * 去拉外部服务器，才是「空白启动页也有执行」——所以这里只造**既不落盘也不起进程**的
 * 那几件。
 *
 * ## 命令这一条上那道闸
 *
 * `history.read` 在**还没有目标**时被丢掉：它问的是「我这条会话的条目」，而没有目标
 * 就没有「我这条会话」——那时把它转给管理者，只会平白为一次开机白起一个执行者
 * （而「空白启动页……没有会话和执行者」正是要免掉这件事）。有了目标之后照常放行。
 */

import type {
  Command,
  ControlTransport,
  KernelEvent,
  MagicHome,
  ModelInfo,
  ModelInfoSnapshot,
} from '@magic/contracts'
import { parseRules } from '@magic/permission'
import { createProjectRules } from '@magic/execution'
import { createModelRegistry } from '@magic/model'
import type { ModelRegistry } from '@magic/model'
import type { RunTuiOptions } from '@magic/tui'
import type { ManagerClient } from './client.ts'
import { unreadSummaryOf } from '@magic/tui'
import { mcpNoticesOf, noModelNotice, workspaceOf } from '../assembly.ts'
import { cacheAccessFor } from '../cache-access.ts'
import { createFileModelInfoCache } from '../model-cache.ts'
import type { LoadedConfig } from '../config.ts'

/** 这一层要的那几件——**都是「从外面拿的值」**，判断一件都不在这儿。 */
export type TerminalInputs = {
  readonly client: ManagerClient
  /** 已加载的配置——窗口按它认工作区与当下那个模型的窗（**不重新加载一遍**）。 */
  readonly loaded: LoadedConfig
  readonly magic: MagicHome
  /** 启动目录——配置没写 `workspaceRoots` 时它就是默认根。 */
  readonly cwd: string
  /**
   * 开局的换模型请求（`--provider` / `--model`）。
   *
   * 它在这一层的用途**只有一个**：开屏那一格的分母要按**开局就落地**的那个选中算
   * （`cli.ts` 在起外壳之前先跑一次切换）。真正的切换发生在**执行者**那一头。
   */
  readonly switch?: { readonly provider?: string; readonly model?: string } | undefined
  /**
   * **开局就接的那条会话**（`--session <id>`）——只给开屏那张摘要当**排除项**
   * （U49：摘要说的是**其他**活跃工作）。
   */
  readonly session?: string | undefined
  /**
   * **模型信息缓存的读数**（U49 收口的那一格）——状态行 ④ **开机的分母**。
   *
   * 由头（U48 如实记的限度）：窗口这一侧原来**不读**这份缓存，于是「还没跑过任何一次
   * 调用」时那一格没有分母（`12.4k` 而不是 `12.4k/200k`），要等第一次
   * `model.call.start` 才归位。而「认当下那个模型的窗」**本来就是窗口这一侧的活**
   * （见本文件头注那张表最后一行）——补上它，那一格开局就与跑起来之后同形。
   *
   * 由 `cli.ts` 读好递进来（**一处读、一处判**），本层不自己碰盘。
   */
  readonly modelInfo?: ModelInfoLookup | undefined
}

/** 「某连接某模型已知的资料」的一处来路——形状与模型域的 `modelInfoOf` 同源。 */
export type ModelInfoLookup = (provider: string, model: string) => ModelInfo | undefined

/**
 * 造外壳要的那份入参——**订阅先接上**（构造即接），发命令是其后的事。
 *
 * 顺序纪律（技术方案 · 控制域：无订阅方时命令丢弃）在这里与同进程时**一字不差**：
 * `createShell` 构造即订阅，而「放开输入」是它之后的事。
 */
export function terminalOptions(inputs: TerminalInputs): RunTuiOptions {
  const { client, loaded, cwd } = inputs

  return {
    transport: clientTransport(client),
    // **没有 `boot`**：恢复是**执行者**那一头的事（它在装配之后、收第一条命令之前跑完）。
    // 窗口这一侧因此「一起来就放开输入」——而那不会让输入抢在恢复前面：管理者把命令
    // **攒到执行者报 `ready` 才放行**（见 `manager.ts` 的 `deliver`）。这道闸从
    // 「外壳那一跳」挪到了「执行者那一跳」，判据一字未松。
    contextWindow: startupContextWindow(inputs),
    workspaceRoots: workspaceOf(loaded, cwd).roots(),
    // **数据目录与家目录**（U71 · `/config` 第 4 行那一格）——与工作区根同一条：**呈现要它们**，
    // 而它们是**启动那一刻定下的**（配置 ＋ `MAGIC_HOME`），没有任何命令问得到。
    // 这一层手上本来就有（`inputs.loaded` / `inputs.magic`，见本文件头注那张表最后一行），
    // 故是**转手**、不是新读一遍盘。家目录只用来把屏上的路径缩成 `~/…`——不参与任何解析。
    dataDir: loaded.config.dataDir,
    home: inputs.magic.home,
    receipts: startupReceipts(inputs),
    // **运行事实**（U49）——管理者推来的那一份：`/resume` 每一行的状态据它，
    // 而开屏那张摘要也从它数（外壳自己在构造那一刻取一次初值，见 `ShellOptions.runs`）。
    runs: {
      current: () => client.runs(),
      subscribe: (listener) => client.onRuns(listener),
    },
    // **接回快照**（U49）——挂到某一代上之后管理者取来那一代的「此刻」
    resumed: {
      subscribe: (listener) => client.onResumed(listener),
    },
    // **停止那一族**（U50）——两个键（整体 / 局部）发出去，三拍回执收回来。
    //
    // ⚠️ **回执要带标题**：管理者只报「哪一条、哪一档、到了哪一拍」，话由外壳按它自己的
    // 目录拼——故这一跳**原样转手**，一个字都不加工（见 `wire.ts` 的 `stopped`）。
    stop: (session, scope) => client.stop(session, scope),
    stopped: (listener) => client.onStopped((report) => listener(report)),
    // **管理者说的那句话**（U50 接上）——U48 起了这条线、U49 没用上，屏上一直没有它
    // （「这一代已经过去了」「起不了执行者」那些话全落在空气里）。
    lines: (listener) => client.onLine((text) => listener(text)),
    // **刚刚发生了一件事**（U50）——完成 / 失败 / 需要你；三类之外管理者一个都不发
    notices: (listener) => client.onNotice((notice) => listener(notice)),
    ...(inputs.session === undefined ? {} : { openingSession: inputs.session }),
    // **管理者不在了 ⇒ 窗口自己退**（见 `run.ts` 的 `onGone`）：「断流后自身应退出，
    // 不能空转充当后台执行者」。连接断的那一刻界面已经没有任何内核可接。
    onGone: (listener: () => void) => {
      client.onClose(() => listener())
    },
  }
}

/**
 * 连接 → `ControlTransport`（外壳认得的那一件）。
 *
 * 两件在这一跳上：
 * - **事件原样转手**（含瞬时增量——渲染要实时）；管理者的 `line` 是一句**给人看**的话，
 *   它不走事件面（不是内核事实），故这一跳不转。
 * - **没有目标时丢掉 `history.read`**（见文件头注）。
 */
export function clientTransport(client: ManagerClient): ControlTransport {
  return {
    send(command: Command): void {
      if (command.type === 'history.read' && client.gen() === null) return
      client.send(command)
    },
    subscribe(listener: (event: KernelEvent) => void): () => void {
      client.onEvent((event) => listener(event))
      // 退订：这一条连接是整个窗口的，不退（窗口收摊时整条连接一起关）。
      // 外壳的 `dispose` 因此是空转——它现在的寿命与连接**同一个**，不是两个东西。
      return () => {}
    },
  }
}

/**
 * 窗口这一侧的注册表——**只用来看，不用来跑**。
 *
 * 走的是**注册表那一条既有路**（`ModelRegistry.capacityOf` / `use`），与执行者算出来的
 * 是同一份判定：窗口这一侧不另写一套「窗长怎么算 / 条目认不认」。
 *
 * 它做两件事，都是**呈现与开门**上的：
 * 1. **验一验开局那个选中**（`--provider` / `--model`）——认不得的条目**当场退场**
 *    （与今天同一条路、同一句话：今天那一次验发生在装配的注册表上）。⚠️ 真正**落地**
 *    的是执行者那一头（选中是**按 Agent 独立装配**的），这里验过之后请求才递进去；
 * 2. **开屏那一格的分母**（状态行 ④）。
 *
 * ⚠️ **与今天的两处差**（都记在 `terminal.ts` 的头注里）：
 * - 今天这条路还看得见**模型信息缓存**里那份资料（装配的 `modelInfoOf`），窗口这一侧
 *   不读那份缓存——读它要碰盘、还可能触发一次后台刷新，那已经超出「呈现」了。
 *   **第一次模型调用落地时这个数就归位**（`model.call.start` 自带 `inputBudget`）。
 * - 缺 key 时**不抛**（返回 `undefined`）：今天装配期缺 key 会响亮地抛，而那一跳现在
 *   归执行者——窗口这一侧拦下来只会把「谁该报这句错」搞反。执行者那一边照旧会报。
 */
export function startupRegistry(inputs: RegistryInputs): ModelRegistry | undefined {
  const { loaded, switch: request } = inputs
  // **按配置的缺省条目造**（不是按请求里那个）——认不认得**请求**里那一条，交给
  // `use()` 去判：它报得出「已注册的有哪些」（今天那句话正是这么来的）。
  // 拿请求里那个当缺省是个**会把错话吞掉**的捷径：条目压根不存在时，连注册表都造不出来，
  // 于是「认不得」变成一声不响。
  const provider = loaded.providerId
  if (provider === undefined || loaded.config.providers[provider] === undefined) return undefined

  let registry: ModelRegistry
  try {
    registry = createModelRegistry({
      providers: loaded.config.providers,
      defaultProvider: provider,
      // 造注册表要一个铸造器（`use()` 盖章用）——窗口这一侧**一次都不会调它**
      // （换模型走命令面，盖章的是执行者那一头）。给一个空的，不假装它能盖章。
      stamper: {
        stamp: () => {
          throw new Error('窗口这一侧不铸信封——换模型归执行者')
        },
        beginTurn: () => {},
      },
      configPath: loaded.path,
      // **模型信息缓存那一份资料**（U49 收口）——有它，配置与内置表都不认得那个模型时
      // 也拿得到窗长（状态行 ④ 开机的分母）。没有就是没有，判定照旧（`capacityOf`
      // 缺省那条路不会因为多给它一份而变松）。
      ...(inputs.modelInfo === undefined ? {} : { modelInfoOf: inputs.modelInfo }),
    })
  } catch {
    return undefined
  }

  // 开局那个选中**就在这一份上落地**（验不过＝这一次不跑，由调用方报错退场——
  // 而 `use` 失败时注册表**原样不动**，故它不会把分母带偏）
  if (request !== undefined) registry.use(request)
  return registry
}

/** `startupRegistry` 要的那几件——`TerminalInputs` 的一个子集（开屏那一格只需要它们）。 */
export type RegistryInputs = {
  readonly loaded: LoadedConfig
  readonly switch?: { readonly provider?: string; readonly model?: string } | undefined
  /** 模型信息缓存的读数（见 `TerminalInputs.modelInfo`）。 */
  readonly modelInfo?: ModelInfoLookup | undefined
}

/**
 * **读一份模型信息缓存**（U49）——开屏那一格的分母要用它，而它是**盘上的东西**。
 *
 * 由 `cli.ts` 在起外壳之前调一次（**一处读**）：窗口这一侧不自己碰盘，只照结果算分母。
 *
 * 三条：**读的是本范围的哪一份**（身份只判一处，见 `cache-access.ts` 的 `cacheAccessFor`）·
 * **读不到就是读不到**（没有那份文件 / 读不懂 / 认证走环境变量 ⇒ `undefined`，
 * 屏上照旧只报已用量——**不编**）· **不触发刷新**（`read` 是纯读，见 `model-cache.ts`）。
 */
export async function readModelInfo(loaded: LoadedConfig): Promise<ModelInfoLookup | undefined> {
  const provider = loaded.providerId
  if (provider === undefined) return undefined

  const entry = loaded.config.providers[provider]
  if (entry === undefined) return undefined

  const access = cacheAccessFor({
    provider,
    configPath: loaded.path,
    apiKey: entry.apiKey,
    processToken: crypto.randomUUID(),
  })
  if (!access.persistent) return undefined // 环境变量来路：盘上根本没有它那一份

  const cache = createFileModelInfoCache(loaded.config.dataDir)
  let snapshot: ModelInfoSnapshot | undefined
  try {
    snapshot = await cache.read(provider, access)
  } catch {
    // 读一份缓存读不动不该拦住开屏（它是**可重建**的东西）——照「拿不到」办
    return undefined
  }
  if (snapshot === undefined) return undefined

  return (_provider, model) => snapshot.models.find((one) => one.id === model)
}

/**
 * 开屏那一格的分母（状态行 ④）——**按开局落地的那个选中算**。
 *
 * 没有注册表 / 还没有去向 ⇒ `null`（**拿不到的不编**，与装配那一处同一条判据）。
 */
function startupContextWindow(inputs: TerminalInputs): number | null {
  const registry = startupRegistry(inputs)
  if (registry === undefined) return null

  const current = registry.current()
  if (current === undefined) return null

  return registry.capacityOf(current.provider, current.model)?.inputBudget ?? null
}

/**
 * 启动那几句——三样。
 *
 * | 话 | 来处 |
 * | --- | --- |
 * | 被拒的权限规则 | 配置（本函数现算） |
 * | 项目规约没加载上的 | 配置 ＋ 盘上那几份文件（本函数现算） |
 * | **外部工具服务器连不上 / 有件没收下** | **管理者的预检**（U48 第六段：`client.mcp`） |
 *
 * 第三样为什么在**管理者**那儿：那是一句「**此刻**通不通」——只有真连一遍才知道，
 * 而「连一遍」这件事按裁定归**本机服务**，不归窗口、也不为它单起后台。窗口这一侧
 * 只把读数**念出来**。
 *
 * 念的话**一字不改地**取自 `mcpNoticesOf`（与执行者的 `Assembly.notices` **同一处产出**）
 * ——同一条事实在两处说成两样，正是「底层换了就放过外观差别」那类毛病。
 *
 * ⚠️ **授权文件读不懂那一句不在**：它要碰授权文件，而那归执行者。
 */
function startupReceipts(inputs: TerminalInputs): readonly string[] {
  const { client, loaded, cwd } = inputs
  const said: string[] = [...mcpNoticesOf(client.mcp)]

  /**
   * **还没接供应商 / 还没选好走哪个模型**（U60）——新用户的第一步。
   *
   * 由头：在一台干净机器上起 TUI（0 供应商、配置空），**那一屏什么也没说**——他
   * 看着一块字标加一行输入提示，不知道要干什么、更不知道要先接供应商。
   * 而这一形**装置原先造不出来**（沙地写死一条合成 `local`），于是没人验过它。
   *
   * 为什么落在**起手那一句**上而不是状态行：配置**不回显**（见 `AGENTS.md`
   * 「屏幕上常驻的每一格，问它影响用户的哪个动作」——「用哪个模型」是用户自己定的配置）。
   * 而这一句说的是**此刻干不了活**，它影响的是**下一步动作**，那就该说。
   *
   * 两句分开是因为**缺的东西不一样、下一步也不一样**（合成一句就得含糊）：
   * - 一条连接都没有（新机器 · 刚把最后一条删了）⇒ 先去接；
   * - 有连接但没有缺省（删掉了原来那条默认的 · 手写的配置没写 `defaultProvider`）
   *   ⇒ 去挑一个。
   *
   * ⚠️ **「有连接」看的是配置**（`providers` 非空），**不是** `providerId`：后者说的是
   * 「缺省是谁」，两者答的是不同的问题。少了这半，删掉当前那条之后重新打开又会是一片静默。
   *
   * ⚠️ 话**一字不改地**取自 `noModelNotice`（与提交那一道拦共用「缺什么 · 怎么接」那半句）
   * ——同一条事实在两处说成两样，正是「底层换了就放过外观差别」那类毛病。
   * 判据这一侧给的是**开局那一刻的配置**：还没启动过一轮，缺省在就是「有得走」。
   */
  const noModel = noModelNotice({
    connections: Object.keys(loaded.config.providers).length,
    hasModel: loaded.providerId !== undefined,
  })
  if (noModel !== undefined) said.push(noModel)

  /**
   * **离开期间那几件事**（U50）——「下一次打开汇总未读事项」就落在这儿。
   *
   * 为什么与开屏那张运行摘要并列而不是合成一句：两张说的是**两件事**（一张「此刻有谁
   * 在跑」，一张「你不在的时候出了什么」），合成一句就分不清「它还在跑」与「它跑完了」。
   */
  const unread = unreadSummaryOf(client.unread)
  if (unread !== undefined) said.push(unread)
  const rejected = parseRules(loaded.config.permissions?.rules ?? []).rejected

  if (rejected.length > 0) {
    said.push(
      `配置里有 ${rejected.length} 条权限规则读不懂（未生效）——${loaded.path}（\`--check\` 看缘由）`,
    )
  }

  // 项目规约**只数「坏了」那一类**（取舍那类是产品按设计做的选择，报它就成了噪音
  // ——口径与 `Assembly.notices` 逐字同）
  try {
    const broken = createProjectRules({
      workspace: workspaceOf(loaded, cwd),
      sources: loaded.config.rules?.sources ?? [],
      linkSources: loaded.config.rules?.linkSources ?? [],
    })
      .load([])
      .problems.filter((problem) => problem.kind === 'error')

    if (broken.length > 0) said.push(`项目规约里有 ${broken.length} 条没能加载（\`--check\` 看缘由）`)
  } catch {
    // 规约读不动不拦住开屏——真正要它的是执行者，那一边照今天的样子报
  }

  return said
}
