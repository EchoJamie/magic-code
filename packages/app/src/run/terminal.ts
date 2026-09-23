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

import type { Command, ControlTransport, KernelEvent, MagicHome } from '@magic/contracts'
import { parseRules } from '@magic/permission'
import { createProjectRules } from '@magic/execution'
import { createModelRegistry } from '@magic/model'
import type { ModelRegistry } from '@magic/model'
import type { RunTuiOptions } from '@magic/tui'
import type { ManagerClient } from './client.ts'
import { workspaceOf } from '../assembly.ts'
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
}

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
    // 启动那几句——只算**配置说得出来的**那两条（权限规则 / 项目规约）。
    // 另两条（授权文件读不懂、外部服务器连不上）要碰授权文件与 MCP 连接，归执行者；
    // 它们到站之后会走 `/grants` 与 `/mcp` 那两屏（那一屏本来就说的是同一件事）。
    receipts: startupReceipts(inputs),
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
 * 启动那几句——**只算配置说得出来的那两条**（被拒的权限规则 · 项目规约没加载上的）。
 *
 * 与 `Assembly.notices` 的关系：那一条通道有四样话，另两样（授权文件读不懂、外部
 * 服务器连不上）**要碰授权文件与外部连接**，归执行者；窗口这一侧不算它们。
 * 两条通道说的是同一批事实的两半，不重不漏——用户看到的那些话，来处各是各的。
 */
function startupReceipts(inputs: TerminalInputs): readonly string[] {
  const { loaded, cwd } = inputs
  const said: string[] = []
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
