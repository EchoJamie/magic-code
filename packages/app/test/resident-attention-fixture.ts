import { createRecordsStore } from '@magic/records'

/** 只经记录端口导出本次隔离数据的事项事实，不依赖数据库或旧 JSON 的内部形制。 */
export function attentionFacts(dataDir: string, workspace: string) {
  const records = createRecordsStore({ dataDir, workspace: [workspace] })
  try {
    return records.attention.list()
  } finally {
    records.close()
  }
}
