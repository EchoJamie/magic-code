/** 仅供 attention-concurrency.test.ts 拉起；临时目录栅栏让独立进程同时写同一库。 */
import { existsSync, writeFileSync } from 'node:fs'
import type { AttentionItem } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'

const [dataDir, writerArg, countArg, readyFile, goFile] = process.argv.slice(2)
if (dataDir === undefined || writerArg === undefined || countArg === undefined ||
    readyFile === undefined || goFile === undefined) {
  throw new Error('用法：concurrent-attention-writer.ts <dataDir> <writer> <count> <ready> <go>')
}

const writer = Number(writerArg)
const count = Number(countArg)
const store = createRecordsStore({ dataDir, workspace: [dataDir] })
try {
  writeFileSync(readyFile, '')
  const deadline = Date.now() + 10_000
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error('并发注意事项测试未收到放行信号')
    Bun.sleepSync(1)
  }

  let inserted = 0
  for (let index = 0; index < count; index += 1) {
    const shared: AttentionItem = {
      id: `shared:${index}`,
      session: 'same-session',
      kind: 'needs-you',
      fact: `event:${index}`,
      at: 1_700_000_000_000 + index,
      unread: true,
      delivered: false,
    }
    if (store.attention.put(shared)) inserted += 1
    if (writer === 0 && index % 2 === 0) store.attention.markRead([shared.id])
    if (writer === 1 && index % 3 === 0) store.attention.markDelivered([shared.id])
    if (store.attention.put(shared)) throw new Error(`重复 put 返回了 true：${shared.id}`)

    // 同一会话的另一事实，不能因别的事项被确认而丢掉未读。
    if (!store.attention.put({
      ...shared, id: `private:${writer}:${index}`, fact: `private:${writer}:${index}`,
    })) throw new Error('独立事实意外重号')
  }
  console.log(JSON.stringify({ inserted }))
} finally {
  store.close()
}
