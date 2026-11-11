/**
 * 工作区桩 —— `WorkspaceService` 的内存实现（**测试替身**）。
 *
 * 用处：工具域 / 权限域判「路径在不在根内」时要向闸门交出**根视图**（`PermissionContext`）；
 * 真装配里根来自配置与启动目录，测试里给一个固定根即可。
 *
 * **不发明行为**——越界就**抛**（契约 `resolve` 的口径是「越界即拒：抛」，
 * 沙箱侧捕之归 `reason: 'out-of-bounds'`）；解析规则与执行域**同源**
 * （相对按默认根 · 绝对须落根内）。阶段 1 语义＝**单根**。
 */

import type { ResolvedPath, WorkspaceService } from '@magic/contracts'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

/** 工作区桩的观察面。 */
export type FauxWorkspace = WorkspaceService & {
  /** 单根（阶段 1 语义）——已规范化。 */
  readonly root: string
}

/** 造桩入参。 */
export type FauxWorkspaceOptions = {
  /** 根——相对路径按进程 cwd 解析后**规范化**（后续判定一律用它）。 */
  readonly root: string
}

/** 造一个单根工作区桩。 */
export function makeFauxWorkspace(options: FauxWorkspaceOptions): FauxWorkspace {
  const root = resolvePath(options.root)
  const prefix = root.endsWith(sep) ? root : root + sep

  const inside = (absolute: string): boolean => absolute === root || absolute.startsWith(prefix)

  return {
    get root(): string {
      return root
    },

    roots(): readonly string[] {
      return [root]
    },

    // 桩只有一张表（**规范形**——根在这里就是 `resolvePath` 归一的那一串：
    // 测试里没有真符号链接要抹，两张表逐字相同）。真实现的差别见契约那一条。
    declaredRoots(): readonly string[] {
      return [root]
    },

    defaultRoot(): string {
      return root
    },

    resolve(path: string): ResolvedPath {
      const absolute = isAbsolute(path) ? path : resolvePath(root, path)
      if (!inside(absolute)) throw new Error(`路径越界：${path}`)
      return { absolute, root }
    },
  }
}
