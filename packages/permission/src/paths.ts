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
  /** 落在某个根内——判不出＝`false`（按根外处置）。 */
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
   * 命中是靠哪一张表——`'real'` ＝规范形 · `'declared'` ＝声明原形 · 判不出 / 根外为 `undefined`。
   * 只影响**材料措辞**（说清楚「是按用户写的那个写法认的」），不参与判定。
   */
  readonly via: 'real' | 'declared' | undefined
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
 */
export function landPath(given: string, ctx: PermissionContext): Landing {
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

/** 落点的材料显示——`影响面：<绝对或原样>（根内 / 根外 / 判不出）`。 */
export function describeLanding(landing: Landing): string {
  if (landing.absolute === undefined) return `${landing.given}（判不出——按根外处置）`

  // 按**声明原形**认的要说出来：用户看到的路径与他写下的那一串对得上，
  // 才说得通「为什么这一条算在根内」（否则屏上是 `/private/tmp/…`，他写的是 `/tmp/…`）
  const where = landing.inside
    ? `根内 · ${landing.root ?? ''}${landing.via === 'declared' ? '（按声明原形认的）' : ''}`
    : '根外'

  return `${landing.absolute}（${where}）`
}
