/**
 * `WorkspaceService` —— 工作区解析（技术方案 · 执行 · 工作区）。
 *
 * 阶段 1 **单根**：启动目录＝默认根（唯一）；阶段 3 多根（U18）在此扩展——
 * 根列表平等平铺，本文件的判定次序（先规范化、再逐根看落点）届时不必改。
 *
 * **边界规则**（技术方案 · 执行：相对按默认根、绝对须落于某根内；越界＝所有根之外）——
 * - 相对路径 → 按**默认根**拼出绝对路径；
 * - 绝对路径 → 必须落在某根内；
 * - **两者归一化之后**再判落点：`a/../b` 与 `/etc/../<root>/f` 一律先作差，
 *   归一后确在根内者放行（路径即事实，不按写法猜意图）；`../` 拱出根者＝拒。
 * - **段边界判定**——`<root>-sibling` 是**字符串**前缀相邻、不是路径在根内，
 *   故按分隔符切段比对（`<root>/` 前缀），不接受裸 `startsWith`。
 *
 * **规范化**——根在构造时取 `realpath`：词法边界必须建在规范形上，否则
 * macOS 上经符号链接给出的根（`/tmp` → `/private/tmp` 一类）会对**真实**路径
 * 误判越界。落点不作 realpath（`resolve` 是**同步纯词法**判定：待建的新文件尚不存在，
 * 且端口签名无异步位）——故**符号链接可绕过词法边界**，这是首站「薄隔离」的已知限度
 * （隔离的承重墙是权限闸门；加厚归托管 / 多设备时——技术方案 · 执行 · 隔离姿态）。
 *
 * **越界即拒**——拒＝抛（端口注释「越界即拒」）。`ResolvedPath` 占位形态
 * `{ absolute, root }` 无失败位，本单元**不动契约包**（本轮只读），故以抛表达拒绝；
 * 「错误＝返回值」是**沙箱原语**（`exec` 等）的通则——`exec` 捕此抛并将其归为
 * `reason: 'out-of-bounds'`（见 `sandbox.ts`），故对面向沙箱的调用方仍是返回值。
 */

import type { ResolvedPath, WorkspaceService } from '@magic/contracts'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type WorkspaceOptions = {
  /** 阶段 1：启动目录（唯一根）。须为**已存在**的路径——工作区机器锚定在真路径上。 */
  readonly root: string
}

/** 落点是否在根内（含根自身）——按**段边界**判定，不认字符串前缀相邻。 */
function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/**
 * 造一个工作区实例（单根）。
 *
 * 构造即 `realpath` 根：**不存在 / 不可达即抛**——宁可在装配期响亮失败，
 * 也不要一个边界永远判错的沙箱（根是沙箱唯一的承重假设）。
 */
export function createWorkspaceService(options: WorkspaceOptions): WorkspaceService {
  const root = realpathSync(resolvePath(options.root))
  const view: readonly string[] = [root]

  return {
    roots: () => view,
    defaultRoot: () => root,

    resolve(path) {
      const absolute = resolvePath(root, path) // 相对按默认根；绝对原样（其后归一化）

      if (!isInside(root, absolute)) {
        throw new Error(`工作区越界：${path}（落在根 ${root} 之外）`)
      }

      const resolved: ResolvedPath = { absolute, root }
      return resolved
    },
  }
}
