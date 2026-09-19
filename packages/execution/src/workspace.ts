/**
 * `WorkspaceService` —— 工作区解析（技术方案 · 执行 · 工作区）。
 *
 * **多根（U18）**——根列表**平等平铺**，**默认根＝列表第一项**（平等平铺 ＋ 一个默认，
 * **不引入「主根」概念**——多一个概念就多一处解释）。单根＝一项的特例，走同一条路。
 * 各根记**两张表**：`realpath` 之后的规范形与**声明原形**（见下「两张表」）。
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
 *   ——展开归配置加载器（`dataDir` 与根同源，U27 起根这一条也长了该行为：
 *   `~/work` 到不了这里；径直把 `~/work` 交给本域仍按相对路径拒）。
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
 * - **落点按两张表**（U27 · `U18` 待决 4）：落点在**任一条根**的**任一张表**内即通过
 *   （见下「两张表」）。
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
 * **两张表**（U27 · `U18` 待决 4）——每条根记两样，落点对**两张都按纯词法前缀**比：
 * - **规范形**（`realpath`）＝根**身份**：`roots()` / `defaultRoot()` / `ResolvedPath.root`
 *   / 越界报文都用它——一条根一个身份，不因写法不同裂成两条（记录那一列 · 列表分组
 *   认的都是它）。
 *   ⚠️ **一张表判不完整**（U22）：权限域原先只拿到这一张（`tools` 把 `roots()` 递给闸门）
 *   ⇒ 声明原形下的读类每次弹卡（沙箱认了、闸门不认）——故 `declaredRoots()` 把它也**露出去**
 *   （契约那一条），闸门那一侧照两张表判。
 * - **声明原形**（用户手写的那串，`resolvePath` 归一、**不** realpath）＝用户**认得的那个写法**。
 *   由头：单根时代根＝启动目录（`getcwd()` 给的是物理路径），**用户写不出非规范形**；
 *   **多根之后用户在配置里手写** `/tmp/proj`（macOS 上 `/tmp` 实为 `/private/tmp`），
 *   注册成真路径，而模型照用户写的给 `/tmp/proj/src`——只比规范形的话它被判越界 ✗
 *   （词法比对够不着）。**多根把这个坑激活了，就在激活它的同时收掉。**
 *   ——「按声明原形做纯词法前缀匹配」即此；真路径那一张**照旧**（U18 的行为一条不丢）。
 *
 * ⚠️ **限度**（两条，都是词法判定的固有面）：
 * ① 两张表都**一个 `realpath` 都不再取**（`resolve` 是同步纯词法判定，见上）——故
 *    「用户写规范形、模型给某个别名」这一向**接不住**（反过来的那一向才是本轮的坑，
 *    因为**声明**那一侧是用户手写的、模型照着它说）；别名链再深也照样绕得过边界（同上）。
 * ② 声明原形取的是**归一后**的写法（`/proj/./` 与 `/proj` 是同一条）——只归一，不解析
 *    符号链接，故它仍可能本身就是个非规范形（那正是它要接住的那一类）。
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

/** 一条根的**两张表**（见文件头注「两张表」）——身份用规范形，匹配两张都认。 */
type Root = {
  /** `realpath` 之后的规范形——根的身份（`roots()` / `ResolvedPath.root` / 报文都用它）。 */
  readonly real: string
  /** **声明原形**——用户手写的那串（`resolvePath` 归一、**不** realpath）。 */
  readonly declared: string
}

/**
 * 一条根的规范化 ＋ 校验（四项里的三条：相对 / 不存在 / 不是目录）——报错**点名第几条**，
 * 多条根下用户得知道改配置里的哪一行。重复在列表外统一判（要跨条看）。
 *
 * 两张表都在这一步定下（见文件头注「两张表」）：`declared` 先归一（`.` / `..` / 尾斜杠
 * 一并作差——与落点是同一把尺子），再照它取 `realpath` 得身份。
 */
function normalizeRoot(raw: string, index: number): Root {
  const at = `第 ${index + 1} 条`

  if (!isAbsolute(raw)) {
    throw new Error(
      `工作区根须是绝对路径（${at}：${raw}）——相对路径不成立：` +
        `根是机器锚定的本机绝对路径（技术方案 · 执行 · 工作区）。`,
    )
  }

  const declared = resolvePath(raw)

  let real: string
  try {
    real = realpathSync(declared)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`工作区根不存在或不可达（${at}：${raw}）——${reason}`)
  }

  if (!statSync(real).isDirectory()) {
    throw new Error(`工作区根不是目录（${at}：${raw}）——工作区是路径的联合作用域，不是文件。`)
  }

  return { real, declared }
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

  // 重复判在**规范形之后**——两条写法不同、实为同一目录者也是重复（见文件头注）。
  // 声明原形不必另判：两条真路径相同即已撞上，而真路径相同是「实为一条」的判据本身。
  const seen = new Map<string, number>()
  roots.forEach((root, index) => {
    const first = seen.get(root.real)
    if (first !== undefined) {
      throw new Error(
        `工作区根重复（第 ${index + 1} 条与第 ${first + 1} 条是同一条：${root.real}）——` +
          `重复的根不构成更大的作用域，只是同一处边界说了两遍。`,
      )
    }
    seen.set(root.real, index)
  })

  const view: readonly string[] = roots.map((root) => root.real)
  /** 声明原形那一张表——**同序等长**（契约 `WorkspaceService.declaredRoots`）。 */
  const declared: readonly string[] = roots.map((root) => root.declared)
  const defaultRoot = view[0] as string // 非空已判，故必有——「默认根＝列表第一项」

  return {
    roots: () => view,
    // 声明原形露出去（U22）——权限域要与执行域**同源**：模型照用户写的那串给路径时，
    // 闸门那一侧也得认得出它在根内（原先只认规范形 ⇒ 声明原形下的读类每次弹卡 ✗）。
    declaredRoots: () => declared,
    defaultRoot: () => defaultRoot,

    resolve(path) {
      const absolute = resolvePath(defaultRoot, path) // 相对按默认根；绝对原样（其后归一化）
      // 落点对**两张表**都比（声明序在前者胜出）：规范形那一张是 U18 的行为，
      // 声明原形那一张是 U27 收的坑（见文件头注「两张表」）
      const hit = roots.find(
        (root) => isInside(absolute, root.real) || isInside(absolute, root.declared),
      )

      if (hit === undefined) {
        throw new Error(
          `工作区越界：${path}（落在所有根之外——已注册：${view.join(' · ')}）`,
        )
      }

      // `root` 报**规范形**——同一个落点，承载它的那条根恒是同一个身份（见文件头注）
      const resolved: ResolvedPath = { absolute, root: hit.real }
      return resolved
    },
  }
}
