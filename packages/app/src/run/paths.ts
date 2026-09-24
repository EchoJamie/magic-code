/**
 * **运行目录**（U48）——管理者 · 执行者 · 客户端三方的**会合点**。
 *
 * 解决的是「谁在管、去哪儿找它」这一件事：管理者在这一处留下它的本机 socket，
 * 执行者与终端窗口都按**同一个键**算到同一条路径，于是不必问谁要地址。
 *
 * ## 键为什么是「规范化 dataDir」而不是基础目录
 *
 * 设计明文：**同一用户、同一规范化 dataDir 只有一个**。基础目录（`<MAGIC_HOME>/.magic`）
 * 管的是配置 / 授权 / 技能，而**运行**这件事的范围由数据目录定——两个 Magic 实例
 * 配置同一份 `config.json`、却各指一个 dataDir 时，它们是两摊互不相干的运行
 * （设计 · 会话与运行管理：「显式使用不同数据目录的 Magic 实例不伪称已被一个列表
 * 全局发现」）。
 *
 * 故运行目录 ＝ `<基础目录>/run/<dataDir 的指纹>/`——**同一个 dataDir 算到同一处**，
 * 不同 dataDir 各一摊。用指纹而不是把整条路径拼进去，是为了 socket 路径的长度：
 * `sun_path` 在 macOS 上是 104 字节、Linux 108，而 dataDir 可以很深
 * （用例的临时目录就已经到七十几字符了）。
 *
 * ## 规范化到什么程度
 *
 * `realpath` 一跳到**所有软链接之外**的那条真路径——`/var` 与 `/private/var`、
 * 符号链接、尾随 `/` 三种写法都要收进**同一个键**（U47 那把锁按规范化文件路径取键，
 * 是同一条由头：两个写法必须落在同一把锁上，否则「只有一个管理者」当场不成立）。
 *
 * ⚠️ 目录**可能还不存在**（首次启动，dataDir 由记录域自己 mkdir）——`realpath` 对
 * 不存在的路径会抛，故这里退到「最近的已存在祖先 ＋ 余下的相对段」：
 * 前者取真路径，后者原样拼回。这样 `/tmp/x/../y` 与 `/tmp/y` 也归一到一处。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import type { MagicHome } from '@magic/contracts'

/**
 * 本机 socket 路径的长度上界（字节）——留一格给结尾的 NUL。
 *
 * macOS `sun_path` ＝ 104、Linux ＝ 108；取小的一边。超了不是「性能差一点」，
 * 是 `bind` 当场失败（`ENAMETOOLONG` 或路径被截断到别处），故宁可在这里响亮地退一步。
 */
const MAX_SOCKET_PATH = 103

/** 运行目录下那几件东西的名字——**一处定义**，三方都从这里取。 */
const RUN_DIR_NAME = 'run'
const SOCKET_NAME = 'm.sock'
/** 管理者自报身份的那一份（pid / 起始时刻 / 数据目录）——诊断与重启核对用。 */
const RECORD_NAME = 'manager.json'
/**
 * **运行登记**（U49）——「上次有哪几代、各自跑到哪儿」的那一份。
 *
 * 它与 `manager.json` 是两件事：那一份说的是**管理者自己**（谁在管、什么时候起的），
 * 这一份说的是**它管的那些运行**（哪条会话、第几代、进程号、什么状态）。重启核对要的是
 * 后者——U48 时只有前一份，于是核对只到「路径有没有尸首」。
 */
const RUNS_NAME = 'runs.json'

/** 一条 socket 路径放不下的说明——超长时用它报给人听（不是「内部错误」）。 */
export class SocketPathTooLong extends Error {
  constructor(
    readonly socketPath: string,
    readonly limit: number,
  ) {
    super(
      `本机 socket 路径太长（${Buffer.byteLength(socketPath)} 字节 > ${limit}）：${socketPath}——` +
        '数据目录太深了（Unix socket 路径有 104 字节的硬上限），把 dataDir 挪浅一点',
    )
    this.name = 'SocketPathTooLong'
  }
}

/** 一摊运行的三条路径——三方（管理者 / 执行者 / 客户端）按同一份算。 */
export type RunPaths = {
  /** 运行目录本身（0700——**本机 socket 限该用户访问**就靠它）。 */
  readonly dir: string
  /** 管理者监听的 socket。 */
  readonly socket: string
  /** 管理者自报身份的那一份。 */
  readonly record: string
  /** **运行登记**那一份（见 `RUNS_NAME`）。 */
  readonly runs: string
}

/**
 * **规范化一个数据目录**——所有软链接之外的那条真路径。
 *
 * 目录还不存在时（首次启动的常态）退到「最近的已存在祖先取真路径 ＋ 余下原样拼回」：
 * 直接 `realpath` 会抛，而「路径还不存在」不是错误，是这一刻的实情。
 *
 * 不做的事：**不建目录**（建目录是记录域构造那一跳的事，那里有它自己的错误处置）。
 */
export function normalizeDataDir(dataDir: string): string {
  const absolute = resolvePath(dataDir)
  const missing: string[] = []
  let head = absolute

  while (!existsSync(head)) {
    const parent = dirname(head)
    // 走到根还是不存在（相对路径 / 盘符）＝没有可归一的祖先，原样交回
    if (parent === head) return absolute
    missing.unshift(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    head = parent
  }

  try {
    return missing.length === 0 ? realpathSync(head) : join(realpathSync(head), ...missing)
  } catch {
    // 祖先在、但它自己读不动（权限）：原样交回——归一失败不该拦住启动
    return absolute
  }
}

/** 规范化数据目录的**指纹**（运行目录那一层目录名）——同一 dataDir ⇒ 同一指纹。 */
export function fingerprintOf(normalizedDataDir: string): string {
  return createHash('sha256').update(normalizedDataDir).digest('hex').slice(0, 10)
}

/**
 * 算出一摊运行的路径。
 *
 * 两条落点，按**同一个键**：
 * 1. 首选 `<基础目录>/run/<指纹>/`——跟随 `MAGIC_HOME`，与配置 / 授权 / 技能同源；
 * 2. 放不下那条 socket（基础目录太深）时退到 `<tmpdir>/magic-run-<指纹>/`——
 *    系统临时目录天然短，且**同一台机器上同一个用户**算到同一处。
 *
 * ⚠️ **两处都算不到才抛**：静默截断一个 socket 路径是能编出来的最坏处置
 * （它会 bind 到一条**别的**路径上去，于是「唯一管理者」当场有两个）。
 *
 * @param tmpdir 系统临时目录——由调用方给（app 是能读环境的层，本文件不读 `process.env`）
 */
export function runPathsOf(magic: MagicHome, dataDir: string, tmpdir: string): RunPaths {
  const key = fingerprintOf(normalizeDataDir(dataDir))
  const preferred = pathsIn(join(magic.base, RUN_DIR_NAME, key))
  if (fits(preferred.socket)) return preferred

  const fallback = pathsIn(join(tmpdir, `magic-run-${key}`))
  if (fits(fallback.socket)) return fallback

  throw new SocketPathTooLong(fallback.socket, MAX_SOCKET_PATH)
}

function pathsIn(dir: string): RunPaths {
  return {
    dir,
    socket: join(dir, SOCKET_NAME),
    record: join(dir, RECORD_NAME),
    runs: join(dir, RUNS_NAME),
  }
}

function fits(socketPath: string): boolean {
  return Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH
}

/**
 * 把运行目录**立起来**——`0700`，一层不多一层不少。
 *
 * 「本机 socket **限该用户访问**」这条纪律落在这一处：socket 文件自己的权限位在
 * BSD 上不生效（`bind` 之后 chmod 才是准的，且有的实现根本不看它），而**把 socket 关在
 * 一个只许本人进入的目录里**是各平台都成立的同一件事。故目录的 mode 是这道门的本体，
 * socket 那一手 0600 只是把「另一种实现下的同一件事」也补上。
 *
 * ⚠️ 目录**已存在时也 chmod 一次**：它可能是上一次以更宽的 mode 建的（或被人改过），
 * 而「第一次建对了、以后就不管」在这里等于没有这道门。
 */
export function ensureRunDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/** 尽力把 socket 文件也收成 0600—— BSD 上不生效，但对别的实现是同一件事的另一种写法。 */
export function tightenSocket(socketPath: string): void {
  try {
    chmodSync(socketPath, 0o600)
  } catch {
    // 文件还没落地 / 平台不给改：目录那道门已经在了，这一手是补的，不改判据
  }
}
