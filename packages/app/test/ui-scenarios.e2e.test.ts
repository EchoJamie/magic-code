import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SCENARIOS, runScenario, type ScenarioResult } from './ui/scenarios.ts'
import { removeDir, tempDir } from './tmp.ts'

let artifacts: string
beforeEach(() => { artifacts = tempDir('magic-ui-test-') })
afterEach(() => { removeDir(artifacts) })

describe('界面产品场景（真实 CLI 与 PTY）', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name} · ${scenario.title}`, async () => {
      const result = await runScenario(scenario.name, { artifacts })

      // 挂了就把**判据名 + 最后那一眼**打出来——比一句「ok 是 false」有用得多
      expect(failureLine(result)).toBeNull()
      expect(result.checks.length).toBeGreaterThan(0)
      const failed = result.checks.filter(check => !check.ok).map(check => `${check.what}：${check.detail}`)
      expect(failed).toEqual([])
      expect(result.runDirs.length).toBeGreaterThan(0)
    }, 300_000)
  }
})

/** 失败的一句话（过了＝`null`）——把判据名、缘由、最后屏幕一并带上。 */
function failureLine(result: ScenarioResult): string | null {
  if (result.ok) return null

  const screen = (result.lastScreen ?? []).join('\n')
  return `${result.name} 挂在「${result.failure?.what}」：${result.failure?.detail}\n最后一眼：\n${screen}`
}
