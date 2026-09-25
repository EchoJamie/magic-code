/**
 * 路径落点 —— 越界判据（技术方案 · 权限：三坐标之「对哪里做」· 执行：工作区）。
 *
 * **与执行域同源**（契约 `PermissionContext` 头注）：**相对按默认根 · 绝对须落于某根内**；
 * 越界 ＝ **所有根之外**。两处判据须一致——本文件是权限域这一侧的落点。
 *
 * ⚠️ 本域**不碰文件系统**（域间只经契约）：这里只做**字面归一**（`.` / `..` / 重复斜杠），
 * 不解符号链接、不问存在性——「能不能碰到」是沙箱的事（三坐标的第二条），不在此处。
 *
 * **两张表**（U22 · 技术方案 · 权限「权限域的根表要与执行域同源」）——`U27` 之后，执行域
 * 的落点判定认两样：`realpath` 之后的**规范形**与用户手写的**声明原形**。闸门这一侧原先
 * 只有规范形 ⇒ **声明原形下的读类每次弹卡**（沙箱认了、闸门不认 ✗）。本文件照执行域同源：
 *
 * - **规范形**（`ctx.roots`）＝根**身份**——材料与规则描述报的都是它；
 * - **声明原形**（`ctx.declaredRoots`，同序等长）＝用户**认得的那个写法**——
 *   落点对它也按**纯词法前缀**比。
 *
 * 判不出的形态（`~` 前缀——域不读环境变量）**按根外处置**：从严，
 * 宁可多问一次，不做「大概在根内」的假定。
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { PermissionContext } from '@magic/contracts'

/** 一条根的两张表（与 `PermissionContext` 同构；序＝声明序，`[0]` 是默认根）。 */
type RootTables = {
  /** `realpath` 之后的规范形——根的身份。 */
  readonly real: string
  /** 声明原形——用户手写的那一串。 */
  readonly declared: string
}

/** 一个路径词条的落点。 */
export type Landing = {
  /** 原样（材料里显示用）。 */
  readonly given: string
  /** 归一后的绝对路径；**判不出**（如 `~` 前缀）为 `undefined`。 */
  readonly absolute: string | undefined
  /**
   * 落在某个根内——判不出＝`false`（按根外处置）。
   *
   * ⚠️ **U80 起也含「内核自己的只读落点」那一支**（`via === 'own'`，见 `landPath`）：
   * 它**不是**一条工作区根，但判据上**不算越界**，故这一位为真。
   */
  readonly inside: boolean
  /** 落在哪个根内（`inside` 为真时有值）——报的是**规范形**（身份）。 */
  readonly root: string | undefined
  /**
   * **本路径的两种写法**——本写法 ＋ 另一张表下对应的那一个（见下 `formsOf`）。
   *
   * 规则那一格按它比对（`rules.ts` · `matchesPath`）：用户写 `src/**`（相对，按**规范形**
   * 的默认根展开）而模型给 `/tmp/proj/src/x`（声明原形）时，**只比一种写法就漏掉**——
   * 这正是「声明原形下的规则怎么写」那件事的答案：规则怎么写都行，**落点认两张**。
   *
   * 判不出落点（`~`）＝空数组——**判不出就不放行**。
   */
  readonly forms: readonly string[]
  /**
   * 命中是靠哪一张表——`'real'` ＝规范形 · `'declared'` ＝声明原形 ·
   * `'own'` ＝**内核自己的只读落点**（U80，见 `landPath`）· 判不出 / 根外为 `undefined`。
   * 只影响**材料措辞**（说清楚是「按哪一条判据认的」），不参与判定。
   */
  readonly via: 'real' | 'declared' | 'own' | undefined
}

/** 归一根——尾斜杠与 `.` 去掉，便于比对。 */
function normalizeRoot(root: string): string {
  const normalized = resolve(root)
  return normalized.endsWith(sep) && normalized !== sep
    ? normalized.slice(0, -sep.length)
    : normalized
}

/** `absolute` 是否落在 `root` 内（含根自身）。 */
export function isInside(absolute: string, root: string): boolean {
  const base = normalizeRoot(root)
  return absolute === base || absolute.startsWith(base + sep)
}

/**
 * 两条根的**两张表**（逐条配对）——与执行域同序（`real` 在前、`declared` 在后逐条看）。
 *
 * `declaredRoots[i]` 缺位时按**规范形**顶上（契约要求同序等长，缺位就是接线错了）：
 * 这个方向是**从严**——少认一种写法只会多问一次，不会多放一次。
 */
function tablesOf(ctx: PermissionContext): readonly RootTables[] {
  return ctx.roots.map((real, index) => ({ real, declared: ctx.declaredRoots[index] ?? real }))
}

/**
 * 同一个落点的**另一种写法**——把落在 `from` 这一张表里的 `absolute` 改写成 `to` 那一张
 * 底下的对应路径。**纯词法**：取余段接上去，不取 `realpath`（本域不碰文件系统）。
 */
function counterpart(absolute: string, from: string, to: string): string {
  return to + absolute.slice(from.length)
}

/** 两种写法去重——单根且本来就规范时两张表逐字相同，去重之后只剩一种。 */
function formsOf(primary: string, alternate: string): readonly string[] {
  return primary === alternate ? [primary] : [primary, alternate]
}

/**
 * 判一个路径词条的落点。
 *
 * 三类：**绝对**（须落于某根内）· **相对**（按默认根解析——`..` 逃逸则出根）·
 * **判不出**（`~` 前缀——按根外）。
 *
 * 落点对**两张表**都比，次序与执行域**同源**（逐条根：规范形在前、声明原形在后）。
 *
 * ## `readOnlyDirs`：内核自己的只读落点（U80）
 *
 * **除各根之外，读类调用另认的几处**——由调用方点名（本域**不自己拼、不自己猜**：
 * 名单归装配，与执行域那份 `SandboxOptions.readOnlyDirs` **同一个来源**）。
 * 当前只有一处：`exec` 后台那一形的**输出目录**（设计明写它落在工作区之外）。
 *
 * 它是**我们自己的产物**，不是用户的东西 ⇒ **不算越界**（这一步就是本条的全部：
 * `inside: true`）。由头：权限域那条「按路径的规则只认根内」之下，
 * **「本工作区总是允许 read」那一类规则盖不住它**（`rules.ts` · `matchesPath`）。
 * ⚠️ 那条摩擦（「每次读我们自己的产物都要问一次」）是 **U70** 记下的，那时链的底还是
 * 「默认问」；**U76 起判轻的默认通**，它已不复现 ⇒ **本单落的是判据**（规则那一格与
 * 落点判据），不是一处看得见的行为变化（见 `PermissionGateOptions.readOnlyDirs`）。
 *
 * ## 三条分寸
 *
 * - ⚠️ **「认一处」不是「放一片」**：认的是**点过名的这几处**，工作区外「用户的东西」
 *   照旧判根外（`inside: false`，规则照旧盖不住）。**那一条一个字没松**；
 * - ⚠️ **只给读类调用**（`analyze` 只把这一位交给 `analyzeSearch`）：`edit` / `write` /
 *   `exec` 不给 ⇒ 往那儿写 / 删 / 移照旧判根外。缺省（不给）＝**一处都不认**，
 *   既有调用因此一字不动；
 * - ⚠️ **不是第二条根**：不进 `ctx.roots`、不参与相对路径解析，也不进
 *   `WorkspaceService` 那张表（「根有几条」在装配与提示词那两处都不变）。
 *
 * 判定次序：**各条根先比**，都落不下再看这几处——落在根内的写法与措辞因此**逐字不变**。
 * 与工作区那条边界**同一把尺子**（`isInside`，纯词法，不额外承诺挡住符号链接）。
 */
export function landPath(
  given: string,
  ctx: PermissionContext,
  readOnlyDirs?: readonly string[],
): Landing {
  // `~` 展开要读环境变量（HOME），域不读环境变量——判不出即从严（按根外）
  if (given === '~' || given.startsWith('~/')) {
    return { given, absolute: undefined, inside: false, root: undefined, forms: [], via: undefined }
  }

  const absolute = isAbsolute(given)
    ? resolve(given)
    : resolve(normalizeRoot(ctx.defaultRoot), given) // 相对＝按默认根（与执行域同源）

  // 相对路径逃出默认根后仍可能落进**另一个**根（多根平铺）——故一律对全根比对
  for (const root of tablesOf(ctx)) {
    const real = normalizeRoot(root.real)
    const declared = normalizeRoot(root.declared)

    if (isInside(absolute, real)) {
      return {
        given,
        absolute,
        inside: true,
        root: real,
        forms: formsOf(absolute, counterpart(absolute, real, declared)),
        via: 'real',
      }
    }
    if (isInside(absolute, declared)) {
      return {
        given,
        absolute,
        inside: true,
        root: real, // 身份恒报规范形（同一条根不因写法不同裂成两条）
        forms: formsOf(absolute, counterpart(absolute, declared, real)),
        via: 'declared',
      }
    }
  }

  // 各条根都落不下 ⇒ 再看**内核自己那处**（U80）——次序如此，根内的写法与措辞一字不动。
  // `forms` 只给这一种写法：它不是一条根，没有「另一样写法」可言。
  for (const dir of readOnlyDirs ?? []) {
    const base = normalizeRoot(dir)
    if (!isInside(absolute, base)) continue
    return { given, absolute, inside: true, root: base, forms: [absolute], via: 'own' }
  }

  return { given, absolute, inside: false, root: undefined, forms: [absolute], via: undefined }
}

/**
 * 把**规则里的路径模式**展开成绝对形——相对按默认根、绝对按字面（与 `landPath` 同源：
 * 「相对按默认根 · 绝对须落根内」）。
 *
 * 展开用的是默认根的**规范形**（根的身份）——**故意只展开一种**：落点那一侧认两种写法
 * （`Landing.forms`），故用户写相对模式时，声明原形下的落点照样命中。反过来若这里也展开两次，
 * 同一条落点会被两种写法各命中一次，规则「命中第几条」的次序就变得看运气。
 *
 * 通配符（`**` / `*` / `?`）在这套归一里是**普通段**：`resolve` 只收 `.` / `..` / 重复斜杠，
 * 不碰它们，故 `src/**` 恰好拼成 `<根>/src/**`。模式里写 `..` 的，归一照做——
 * 用户写明的范围就是用户的范围（且放行与否仍过必闸禁区那关）。
 */
export function expandPattern(pattern: string, ctx: PermissionContext): string {
  return resolve(normalizeRoot(ctx.defaultRoot), pattern)
}

/** 落点的材料显示——`影响面：<绝对或原样>（根内 / 根外 / 判不出 / 内核自己的产物）`。 */
export function describeLanding(landing: Landing): string {
  if (landing.absolute === undefined) return `${landing.given}（判不出——按根外处置）`

  // **内核自己那处**（U80）——⚠️ **不印「根内 ·」那个前缀**：它判据上确实算根内
  // （`inside` 为真、规则照根内比对），但它**不是**一条工作区根（见 `landPath`）——
  // 印成「根内 · <那个目录>」会让读的人以为往那儿写也可以，而写 / 删 / 移那一侧
  // **照旧判根外**。说的话与判据说的是同一件事：**不算越界**。
  if (landing.via === 'own') return `${landing.absolute}（内核自己的产物——不算越界）`

  // 按**声明原形**认的要说出来：用户看到的路径与他写下的那一串对得上，
  // 才说得通「为什么这一条算在根内」（否则屏上是 `/private/tmp/…`，他写的是 `/tmp/…`）
  const where = landing.inside
    ? `根内 · ${landing.root ?? ''}${landing.via === 'declared' ? '（按声明原形认的）' : ''}`
    : '根外'

  return `${landing.absolute}（${where}）`
}
