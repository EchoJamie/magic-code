import { expect, test } from 'bun:test'
import { INPUT_PREVIEW_TEXT_BYTES, pendingViews } from '../src/index.ts'
import type { StoredInput } from '../src/index.ts'

function input(text: string, state: StoredInput['state'] = 'pending', ref = 'r-1'): StoredInput {
  return { ref, input: { text }, purpose: 'current', at: 1, revision: 0, state }
}

test('待处理输入只带预览：正文封顶、附总字节数与截断标记', () => {
  const huge = '中'.repeat(INPUT_PREVIEW_TEXT_BYTES)
  const [view] = pendingViews([input(huge)])

  expect(view?.input.text.length).toBeLessThan(huge.length)
  expect(view?.truncated).toBe(true)
  expect(view?.textBytes).toBe(new TextEncoder().encode(huge).byteLength)
})

test('短输入原样通过，不带多余字段', () => {
  const [view] = pendingViews([input('短句')])
  expect(view?.input.text).toBe('短句')
  expect(view?.truncated).toBeUndefined()
  expect(view?.textBytes).toBeUndefined()
})

test('pending 与最近 consumed 各有上限，别的状态不进视图', () => {
  const many = Array.from({ length: 30 }, (_, index) => input(`p-${index}`, 'pending', `p${index}`))
  const consumed = Array.from({ length: 30 }, (_, index) => input(`c-${index}`, 'consumed', `c${index}`))
  const views = pendingViews([...many, ...consumed, input('w', 'withdrawn', 'w1')])

  expect(views.filter(one => one.state === 'pending')).toHaveLength(20)
  expect(views.filter(one => one.state === 'consumed')).toHaveLength(20)
  expect(views.some(one => one.state === 'withdrawn')).toBe(false)
})
