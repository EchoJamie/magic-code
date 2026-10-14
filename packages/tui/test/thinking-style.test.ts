import { describe, expect, test } from 'bun:test'
import { BREATH_MS } from '../src/motion.ts'
import { event, TEST_AT } from './events.ts'
import { createStage, showScreen } from './screen.ts'

// U125 替换思考标签、局部计时与呼吸；工具及计划动效仍由各自规格测试覆盖。
describe('思考块 · 静态细竖线', () => {
  for (const reduced of [false, true]) {
    test(`流式与收束均静态，减少动效=${reduced}`, async () => {
      const stage = createStage({ reducedMotion: reduced })
      stage.feed([event('model.delta', { channel: 'thinking', text: '先想一下。\n再想一下。' }, { id: 10 })])
      const colors = []
      for (const at of [0, BREATH_MS / 2, BREATH_MS, BREATH_MS * 2]) {
        stage.at(TEST_AT + 10 + at)
        const frame = await stage.screen({ columns: 100, rows: 40 })
        const line = frame.rowOf('│ 先想一下。')
        colors.push(frame.cellsOf(line)[0]?.fg)
        expect(frame.textAt(line)).toBe('│ 先想一下。')
        expect(frame.has('（思考')).toBe(false)
      }
      expect(new Set(colors).size).toBe(1)
      stage.feed([event('model.delta', { channel: 'text', text: '回答。' }, { id: 20 })])
      const full = await showScreen(stage.shell.getView())
      expect(full.has('│ 先想一下。')).toBe(true)
      expect(full.has('│ 再想一下。')).toBe(true)
      stage.shell.dispose()
    })
  }
})
