import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeHostDiscovery, decodeNativeMessage } from '../src/native-codec.ts'

const directory = new URL('../../../tests/fixtures/native-wire/', import.meta.url).pathname
for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
  test(`TS/Swift 共享契约 ${file}`, () => {
    const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { family: string; valid: boolean; message: unknown }
    const value = fixture.family === 'HostDiscovery' ? decodeHostDiscovery(fixture.message) : decodeNativeMessage(fixture.message)
    expect(value !== undefined).toBe(fixture.valid)
    if (fixture.valid) expect(JSON.parse(JSON.stringify(value))).toEqual(fixture.message)
  })
}
