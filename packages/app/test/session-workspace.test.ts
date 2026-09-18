/**
 * U26 · 装配根 —— **会话归属工作区**在装配这一端的接线。
 *
 * 三件，都在「装配根只做选择与绑定」这条线之内：
 * ① **锚定的那一跳**——本进程的工作区（执行域 `roots()`）进记录域，会话建立时落进库里；
 * ② **交的是整组根**（多根下不是默认根、更不是启动目录）——那一列的用处是**恢复回到原位**；
 * ③ **外壳那一跳**——同样的工作区进 `runTui`（列表按工作区分组要用它比「哪个是别的项目」）。
 *
 * ⚠️ **判据取件、不复述**（缺陷 D16 那笔账）：接线只有装配里那两行，用例若自己
 * 「照同样方式接一遍」，倒回那两行照样绿。故 ③ 从 `tuiOptions` **取件**；
 * ①② 直读库表（不经 API 回读闭环）。
 */

import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { attachShell } from '../src/index.ts'
import { tuiOptions } from '../src/cli.ts'
import { makeStage, readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 库里那条会话锚下的工作区（JSON 一列 → 那组根）。 */
function anchoredWorkspace(databasePath: string): unknown {
  const raw = readDatabase(databasePath)
  try {
    const column = raw.sessions[0]?.workspace
    return column === null || column === undefined ? undefined : JSON.parse(column)
  } finally {
    raw.close()
  }
}

describe('建立时锚定——本进程的工作区进记录域', () => {
  test('首条消息按下回车 ⇒ 会话行带着启动目录（单根：配置没声明 `workspaceRoots`）', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)

      await shell.submit('看看这个工作区里有什么')
      shell.dispose()
      assembly.close()

      expect(anchoredWorkspace(assembly.paths.database)).toEqual([realpathSync(stage.workspace)])
    } finally {
      stage.dispose()
    }
  })

  test('配置声明了多根 ⇒ 记的是**整组根**（不是默认根、也不是启动目录）', async () => {
    // 两条另立的根（工作区根须已存在——执行域取 realpath）；启动目录**不在**这一组里
    const first = tempDir('magic-u26-first-')
    const second = tempDir('magic-u26-second-')
    const stage = makeStage({ config: { workspaceRoots: [first, second] } })

    try {
      const assembly = stage.assemble()
      const shell = attachShell(assembly.shell)

      await shell.submit('多根之下的一件事')
      shell.dispose()
      assembly.close()

      // 整组、**声明序**（`[0]` 默认根）——只记默认根的话，恢复就重建不回这个工作区
      expect(anchoredWorkspace(assembly.paths.database)).toEqual([
        realpathSync(first),
        realpathSync(second),
      ])
      expect(assembly.workspaceRoots).toEqual([realpathSync(first), realpathSync(second)])
    } finally {
      stage.dispose()
      removeDir(first)
      removeDir(second)
    }
  })
})

describe('外壳那一跳——同样的工作区进 `runTui`', () => {
  test('`tuiOptions` 带着工作区（列表按工作区分组要用它认「别的项目」）', () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      expect(tuiOptions(assembly).workspaceRoots).toEqual(assembly.workspaceRoots)
      expect(tuiOptions(assembly).workspaceRoots).toEqual([realpathSync(stage.workspace)])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
