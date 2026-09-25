/**
 * U88 · 反面（**本单最要紧的一条**）：搜索这件工具**不在给模型的工具集里**。
 *
 * ## 为什么要在装配这一层再咬一遍
 *
 * 域内那条用例（`@magic/tools` 的 `test/web-search-tool.test.ts`）能证明的只是
 * 「**默认集**里没有它」；而**模型真正看见的那一份**是装配拼出来的
 * （默认七件 ＋ 追加出口那一束：技能 · 计划与历史 · 取网页 · MCP）。本单的要害正是
 * 「模型看不见它」——那就得看**真发出去的那份请求**：真配置加载 · 真装配 ·
 * 真对话域那一轮，读它发给模型的 `tools`。
 *
 * ## 这一条为什么咬得住
 *
 * 判据不是「代码里没写」而是「**发出去的那一份里没有**」：谁把 `web_search` 接进
 * 装配那一行（`assembly.ts` 的 `tools:` 那一处），这一条当场红。除了点名那一个，
 * 还咬一条**含 `search` 的一个都没有**——改个名绕过去也躲不掉（`grep` 搜的是工作区里的
 * 文件内容，名字里没有这两个字，不会误伤）。
 *
 * 用例把那一份清单**印出来**（`[U88]` 那几行）——归档里要的就是这次实读的原文。
 */

import { describe, expect, test } from 'bun:test'
import { lastModel, makeStage } from './support.ts'

async function until(test: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

describe('U88 · 搜索不注册——模型看不见它', () => {
  test('真装配跑一轮：送给模型的那份请求里没有 web_search', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble()

      // 一句即可——本用例要看的是**这一轮发给模型的工具表**，不是它干了什么
      assembly.shell.send({ type: 'input.submit', text: '随便说一句' })
      await until(() => lastModel(stage).requests.length >= 1, '首轮模型请求')

      const names = (lastModel(stage).requests[0]?.tools ?? []).map((tool) => tool.name)

      // 归档要的那一份原文：此刻这一趟**模型看得见什么**
      console.log(`[U88] 送给模型的工具清单（${names.length} 件）：`)
      for (const name of names) console.log(`[U88]   · ${name}`)
      const searched = names.filter((name) => name.includes('search'))
      console.log(`[U88] 其中名字含 search 的：${searched.length === 0 ? '（无）' : searched.join('、')}`)

      expect(names).not.toContain('web_search')
      expect(searched).toEqual([])
      // 清单本身不是空的——不然上面两条是「什么都没看」的假绿
      expect(names.length).toBeGreaterThan(0)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
