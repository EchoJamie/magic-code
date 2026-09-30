import { expect, test } from 'bun:test'
import { linkOf } from '../src/run/wire.ts'

test('慢原生观察者合并中间完整投影，控制回执和已开始帧完整保留', () => {
  let writable = false
  const sent: Uint8Array[] = []
  let terminated = false
  const socket = {
    data: undefined as { drain(): void } | undefined,
    write(bytes: Uint8Array) { if (!writable) return 0; sent.push(bytes.slice()); return bytes.length },
    flush() {}, end() {}, terminate() { terminated = true },
  }
  const link = linkOf(socket as never)
  const projection = (revision: number) => ({ t: 'native.projection' as const, projection: { serviceInstance: 'service', revision, accepting: true, works: [] } })
  link.send(projection(1))
  for (let revision = 2; revision <= 1000; revision++) expect(link.send(projection(revision))).toBe(true)
  link.send({ t: 'native.stopped', request: 'one', session: 'work', phase: 'done' })
  writable = true
  socket.data!.drain()
  const messages = new TextDecoder().decode(Buffer.concat(sent)).trim().split('\n').map((line) => JSON.parse(line))
  expect(messages).toEqual([projection(1), { t: 'native.stopped', request: 'one', session: 'work', phase: 'done' }, projection(1000)])
  expect(terminated).toBe(false)
})
