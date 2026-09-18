/**
 * `WorkspaceService` —— 工作区解析（技术方案 · 执行 · 工作区）。
 *
 * **多根（U18）**——根列表**平等平铺**，**默认根＝列表第一项**（平等平铺 ＋ 一个默认，
 * **不引入「主根」概念**——多一个概念就多一处解释）。单根＝一项的特例，走同一条路。
 * 各根逐条取 `realpath`：词法边界必须建在规范形上（见下「规范化」）。
 *
 * **根校验（加载时报错不降级——照 `dataDir` 的先例）**——四项，皆在**规范化之后**判：
 * - **不存在** / **不是目录** → 拒（工作区机器锚定在真路径上，根是沙箱唯一的承重假设）；
 * - **重复** → 拒：判在 `realpath` 之后，故 `/tmp/x` 与 `/private/tmp/x`（macOS 上实为
 *   同一目录）这类**写法不同而实为一条**的重复也拦得住——词法比较漏得掉。
 *   ⚠️ **限度**：这只保证 `realpath` 自己抹平的那几样（符号链接 · `.` · `..` · 尾斜杠）。
 *   **大小写不在其列**——「大小写不敏感卷上 `CaseDir` 与 `casedir` 是同一条」这件事，
 *   得靠运行时的 `realpath` 顺手规范化大小写，而这**不是它的普遍性质**：
 *   实测同一台机器上 bun 的 `realpathSync('/users')` 给 `/Users`、node 的给 `/users`。
 *   本程序跑 bun，故今天不漏；换成不做这一步的运行时，这类重复会漏过去（不误伤，只是漏拦）。
 *   故**别把它当 realpath 的普遍保证**——它是「本运行时替我们多做的这一点」。
 * - **相对路径** → 拒（根是绝对路径）。前导 `~` **不算绝对路径**，本域不展开它
 *   （`dataDir` 的 `~` 展开归配置加载器；根这一条未长该行为，写了即按相对路径拒）。
 * - 空列表 → 拒（工作区是「**≥ 1 条**」的联合作用域——零根无默认根可言）。
 *
 * 拒＝**抛**（不是静默丢弃一条继续跑）：一条根不合格即整份注册不成立——
 * 「跳过那条」会让用户对着一个少了一半的作用域发呆，而边界判定已按错的集合在跑。
 *
 * **边界规则**（技术方案 · 执行：相对按默认根、绝对须落于某根内；越界＝所有根之外）——
 * - 相对路径 → 按**默认根**拼出绝对路径（多根下亦只认默认根——「默认根承载相对路径
 *   与新文件」）；
 * - 绝对路径 → 必须落在**某一条**根内；`ResolvedPath.root` 报**承载它的那条**
 *   （多根才有的信息：同一条绝对路径，承载根可 ≠ 默认根）；
 * - **两者归一化之后**再判落点：`a/../b` 与 `/etc/../<root>/f` 一律先作差，
 *   归一后确在根内者放行（路径即事实，不按写法猜意图）；`../` 拱出根者＝拒。
 * - **段边界判定**——`<root>-sibling` 是**字符串**前缀相邻、不是路径在根内，
 *   故按分隔符切段比对（`<root>/` 前缀），不接受裸 `startsWith`。
 * - 落点同时落在两条根内（根**嵌套**）时取**声明序在前**的那条；词典已声明根
 *   「不嵌套」，故这是兜底而非语义（不为此长校验——不在四项之列）。
 *
 * **规范化**——根在构造时取 `realpath`（不存在 / 不可达即抛——宁可在装配期响亮失败，
 * 也不要一个边界永远判错的沙箱）。落点不作 realpath（`resolve` 是**同步纯词法**判定：
 * 待建的新文件尚不存在，且端口签名无异步位）——故**符号链接可绕过词法边界**，
 * 这是首站「薄隔离」的已知限度（隔离的承重墙是权限闸门；加厚归托管 / 多设备时
 * ——技术方案 · 执行 · 隔离姿态）。
 *
 * **越界即拒**——拒＝抛（端口注释「越界即拒」）。`ResolvedPath` 占位形态
 * `{ absolute, root }` 无失败位，本单元**不动契约包**（本轮只读），故以抛表达拒绝；
 * 「错误＝返回值」是**沙箱原语**（`exec` 等）的通则——`exec` 捕此抛并将其归为
 * `reason: 'out-of-bounds'`（见 `sandbox.ts`），故对面向沙箱的调用方仍是返回值。
 */

import type { ResolvedPath, WorkspaceService } from '@magic/contracts'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type WorkspaceOptions = {
  /**
   * 工作区根列表——**≥ 1 条**，**第一项＝默认根**（相对路径与新文件的落点）。
   *
   * 每项须是**已存在**的**绝对目录**路径：工作区机器锚定在真路径上，逐条取 `realpath`。
   * 缺列表 = 空注册，不是「落到 cwd」——**缺省值归装配根给**（阶段 1 的启动目录那一条
   * 在 `assembly.ts` 的 `options.cwd`，不在这里替用户猜）。
   */
  readonly roots: readonly string[]
}

/**
 * `absolute` 是否落在 `root` 内（含根自身）——按**段边界**判定，不认字符串前缀相邻。
 *
 * 签名与权限域的同名函数（`@magic/permission` · `paths.ts`）**同序同义**：两域各持一份
 * 边界判定，参数序若一个相反一个不反，读代码的人接反了不会当场红（多数组合都返回 false）。
 */
function isInside(absolute: string, root: string): boolean {
  if (absolute === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return absolute.startsWith(prefix)
}

/**
 * 一条根的规范化 ＋ 校验（四项里的三条：相对 / 不存在 / 不是目录）——报错**点名第几条**，
 * 多条根下用户得知道改配置里的哪一行。重复在列表外统一判（要跨条看）。
 */
function normalizeRoot(raw: string, index: number): string {
  const at = `第 ${index + 1} 条`

  if (!isAbsolute(raw)) {
    throw new Error(
      `工作区根须是绝对路径（${at}：${raw}）——相对路径不成立：` +
        `根是机器锚定的本机绝对路径（技术方案 · 执行 · 工作区）。`,
    )
  }

  let real: string
  try {
    real = realpathSync(resolvePath(raw))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`工作区根不存在或不可达（${at}：${raw}）——${reason}`)
  }

  if (!statSync(real).isDirectory()) {
    throw new Error(`工作区根不是目录（${at}：${raw}）——工作区是路径的联合作用域，不是文件。`)
  }

  return real
}

/**
 * 造一个工作区实例（多根；单根＝一项的特例）。
 *
 * 构造即逐条 `realpath` ＋ 校验：**不合格即抛**——宁可在装配期响亮失败，
 * 也不要一个边界永远判错的沙箱（根是沙箱唯一的承重假设）。
 */
export function createWorkspaceService(options: WorkspaceOptions): WorkspaceService {
  if (options.roots.length === 0) {
    throw new Error(
      '工作区根列表为空——工作区是「≥ 1 条」的联合作用域，零根无默认根可言' +
        '（技术方案 · 执行 · 工作区；缺省值归装配根给）。',
    )
  }

  const roots = options.roots.map((raw, index) => normalizeRoot(raw, index))

  // 重复判在**规范化之后**——两条写法不同、实为同一目录者也是重复（见文件头注）
  const seen = new Map<string, number>()
  roots.forEach((root, index) => {
    const first = seen.get(root)
    if (first !== undefined) {
      throw new Error(
        `工作区根重复（第 ${index + 1} 条与第 ${first + 1} 条是同一条：${root}）——` +
          `重复的根不构成更大的作用域，只是同一处边界说了两遍。`,
      )
    }
    seen.set(root, index)
  })

  const view: readonly string[] = roots
  const defaultRoot = roots[0] as string // 非空已判，故必有——「默认根＝列表第一项」

  return {
    roots: () => view,
    defaultRoot: () => defaultRoot,

    resolve(path) {
      const absolute = resolvePath(defaultRoot, path) // 相对按默认根；绝对原样（其后归一化）
      const root = roots.find((candidate) => isInside(absolute, candidate))

      if (root === undefined) {
        throw new Error(
          `工作区越界：${path}（落在所有根之外——已注册：${roots.join(' · ')}）`,
        )
      }

      const resolved: ResolvedPath = { absolute, root }
      return resolved
    },
  }
}
