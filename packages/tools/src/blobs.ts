/**
 * 大块转存 —— 把「记录怎么存」与「模型看见什么」分开。
 *
 * 出处：技术方案 · 记录 · 规则 ②「大负载落 blob（阈值＝**实现级常量**）」＋ 标量口径
 * 「**blob 写权唯一归记录域**——沙箱不产引用（只截断回报），转存由**调用方**（工具分发）
 * 经记录域公开面完成」。本文件就是那个「调用方」的落点。
 *
 * 两件事分得很开，别混：
 * - **面向模型的文本**（`ToolInvocation.output`）＝ 沙箱给的终值，**不因转存而变**；
 * - **记录侧形态**（`ToolInvocation.content` ／ `tool.result.data.output`）＝ 小则内联、
 *   大则引用。
 *
 * 为什么阈值是**字节**不是字符：JSON 落库与传输都按字节算，中文一个字三字节——
 * 按字符计会让「看着不大」的文本撑爆事件行。
 *
 * 为什么转存失败要**回落内联**：转存是记录质量的事，不是这次调用的成败。抛出去会炸掉
 * 循环（工具域不该干的事），静默吞掉会丢结果——回落内联两者都不占：结果在，只是这一笔
 * 记大了。分不清「盘满」与「不该转存」的场合下，保住数据是唯一不会后悔的选择。
 */

import type { BlobStore, Content } from '@magic/contracts'

/**
 * 大负载阈值——单位**字节**（UTF-8）。超过即转存，**恰好等于不算超**。
 *
 * 定在 8 KiB 的理由：事件行要经 SQLite 落库、经控制面推送——单条 JSON 到这个量级还轻快，
 * 再大就该走引用了。注意这与沙箱的输出上限（`EXEC_MAX_OUTPUT_BYTES`，每道流）不是一个
 * 概念：**上限管「命令能产出多少」，阈值管「记录怎么存」**——前者截断，后者转存。
 */
export const BLOB_THRESHOLD_BYTES = 8 * 1024

const encoder = new TextEncoder()

/** 文本的 UTF-8 字节数。 */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** 按阈值定记录侧形态：小则内联，大则经记录域转存；转存失败回落内联（见文件头注）。 */
export async function toContent(output: string, blobs: BlobStore): Promise<Content> {
  if (byteLength(output) <= BLOB_THRESHOLD_BYTES) return { text: output }

  try {
    return { blob: await blobs.put(output) }
  } catch {
    return { text: output }
  }
}
