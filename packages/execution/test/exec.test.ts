import { expect, test } from 'bun:test'
import { timeoutBoundOf } from '../src/sandbox.ts'

test('缺省、null 与非法超时均无上界，显式正值原样保留', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN]) {
    expect(timeoutBoundOf(value)).toBeNull()
  }
  expect(timeoutBoundOf(400)).toBe(400)
})
