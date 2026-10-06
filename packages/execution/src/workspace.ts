/**
 * 工作区注册与路径事实解析。根必须存在、为目录且互不重复；相对目标按默认根解析。
 * resolve 跟随符号链接（待建文件解析已有祖先），返回真实路径、所属根及文件身份快照。
 * 根外目标没有 root，不因此抛错。唯一权限决断在工具执行前的 PermissionGate。
 * 身份快照用于发现审批后的目标变更，不是通用操作系统文件系统隔离。
 */

import type { FileIdentity, ResolvedPath, WorkspaceService } from '@magic/contracts'
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'

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
 *
 * **导出给域内件用**（U32 起 `rules.ts` 也按同一把尺子判「这份规约落在哪条根里」）——
 * 域内复用，不上包的公开面（`index.ts` 不出它）。
 */
export function isInside(absolute: string, root: string): boolean {
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
    // 声明写法仍供配置与规则展示；工具目标以 realpath 结果为准。
    declaredRoots: () => declared,
    defaultRoot: () => defaultRoot,

    resolve(path) {
      const absolute = resolveTarget(resolvePath(defaultRoot, path))
      const hit = roots.find((root) => isInside(absolute, root.real))
      return { ...inspectTarget(absolute), ...(hit === undefined ? {} : { root: hit.real }) }
    },
  }
}

/** 解析目标与已有祖先，包括尚未创建的文件；不作权限决断。 */
export function resolveTarget(absolute: string, links = 0): string {
  if (links > 40) throw new Error(`符号链接循环：${absolute}`)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return absolute
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 悬空链接仍须跟到它指向的新文件，不能把链接本身当成新建目标。
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      return resolveTarget(resolvePath(dirname(absolute), readlinkSync(absolute)), links + 1)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return resolvePath(resolveTarget(parent, links), absolute.slice(parent.length + (parent === sep ? 0 : 1)))
}

/** 执行一致性检查：目标不能在裁决后被链接重定向；不是路径准入。 */
export function assertTarget(absolute: string): string {
  if (resolveTarget(absolute) !== absolute) throw new Error(`操作目标已改变：${absolute}`)
  return absolute
}

/** 文件身份用于核对本次目标，不能用它推导权限。 */
export function identityOf(info: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: String(info.dev), ino: String(info.ino) }
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export function inspectTarget(absolute: string): ResolvedPath {
  const identity = (path: string): FileIdentity | undefined => {
    try { return identityOf(statSync(path, { bigint: true })) }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
      throw error
    }
  }
  const parentIdentity = identity(dirname(absolute))
  return { absolute, identity: identity(absolute) ?? null, ...(parentIdentity === undefined ? {} : { parentIdentity }) }
}

export function assertIdentity(target: ResolvedPath): void {
  assertTarget(target.absolute)
  if (target.identity == null) return
  const actual = identityOf(statSync(target.absolute, { bigint: true }))
  if (!sameIdentity(actual, target.identity)) throw new Error(`操作目标已改变：${target.absolute}`)
}
