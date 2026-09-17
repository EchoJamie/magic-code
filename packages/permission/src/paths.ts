/**
 * 路径落点 —— 越界判据（技术方案 · 权限：三坐标之「对哪里做」· 执行：工作区）。
 *
 * **与执行域同源**（契约 `PermissionContext` 头注）：**相对按默认根 · 绝对须落于某根内**；
 * 越界 ＝ **所有根之外**。两处判据须一致——本文件是权限域这一侧的落点。
 *
 * ⚠️ 本域**不碰文件系统**（域间只经契约）：这里只做**字面归一**（`.` / `..` / 重复斜杠），
 * 不解符号链接、不问存在性——「能不能碰到」是沙箱的事（三坐标的第二条），不在此处。
 *
 * 判不出的形态（`~` 前缀——域不读环境变量）**按根外处置**：从严，
 * 宁可多问一次，不做「大概在根内」的假定。
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { PermissionContext } from '@magic/contracts'

/** 一个路径词条的落点。 */
export type Landing = {
  /** 原样（材料里显示用）。 */
  readonly given: string
  /** 归一后的绝对路径；**判不出**（如 `~` 前缀）为 `undefined`。 */
  readonly absolute: string | undefined
  /** 落在某个根内——判不出＝`false`（按根外处置）。 */
  readonly inside: boolean
  /** 落在哪个根内（`inside` 为真时有值）。 */
  readonly root: string | undefined
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
 * 判一个路径词条的落点。
 *
 * 三类：**绝对**（须落于某根内）· **相对**（按默认根解析——`..` 逃逸则出根）·
 * **判不出**（`~` 前缀——按根外）。
 */
export function landPath(given: string, ctx: PermissionContext): Landing {
  const roots = ctx.roots.map(normalizeRoot)

  // `~` 展开要读环境变量（HOME），域不读环境变量——判不出即从严（按根外）
  if (given === '~' || given.startsWith('~/')) {
    return { given, absolute: undefined, inside: false, root: undefined }
  }

  const absolute = isAbsolute(given)
    ? resolve(given)
    : resolve(normalizeRoot(ctx.defaultRoot), given) // 相对＝按默认根（与执行域同源）

  // 相对路径逃出默认根后仍可能落进**另一个**根（多根平铺）——故一律对全根比对
  const root = roots.find((candidate) => isInside(absolute, candidate))
  return { given, absolute, inside: root !== undefined, root }
}

/** 落点的材料显示——`影响面：<绝对或原样>（根内 / 根外 / 判不出）`。 */
export function describeLanding(landing: Landing): string {
  if (landing.absolute === undefined) return `${landing.given}（判不出——按根外处置）`
  return `${landing.absolute}（${landing.inside ? `根内 · ${landing.root ?? ''}` : '根外'}）`
}
