import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsRequest, settingsResult } from '../src/settings-codec.ts'
import { decodeHostDiscovery, decodeNativeMessage } from '../src/native-codec.ts'

const directory = new URL('../../../tests/fixtures/native-wire/', import.meta.url).pathname
for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
  test(`TS/Swift 共享契约 ${file}`, () => {
    const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { family: string; valid: boolean; message: unknown }
    const settingsValid = fixture.family === 'SettingsRequest' ? settingsRequest(fixture.message) : fixture.family === 'SettingsResult' ? settingsResult(fixture.message) : undefined
    const value = settingsValid !== undefined ? (settingsValid ? fixture.message : undefined) : fixture.family === 'HostDiscovery' ? decodeHostDiscovery(fixture.message) : decodeNativeMessage(fixture.message)
    expect(value !== undefined).toBe(fixture.valid)
    if (fixture.valid) expect(JSON.parse(JSON.stringify(value))).toEqual(fixture.message)
  })
}


test('旧 dataDir 协议与已撤除的 data.set 动作不再解码', () => {
  const hello = { t: 'hello', role: 'observer', protocol: 1, version: '0.1.0', source: '/helper', dataDir: '/old' }
  expect(decodeNativeMessage(hello)).toBeUndefined()
  expect(decodeHostDiscovery({ ...hello, hostInstance: 'host', serviceInstance: 'service', socket: '/s', app: '/app' })).toBeUndefined()
  expect(decodeNativeMessage({ t: 'native.settings.apply', request: 'r', serviceInstance: 's', base: '/profile/.magic', stamp: null, action: { type: 'data.set', directory: '/other' } })).toBeUndefined()
})
