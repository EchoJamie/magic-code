/**
 * `@magic/client` —— 客户端本地能力。
 *
 * 0.2.0 先收拢剪贴板（读图 / 写文本）；文件选择、截图、打开/定位随后按同一模块归位。
 * 它只操作本机资源，不读写记录、配置或引擎实现。
 */
export { readClipboardImage, writeClipboardText } from './clipboard.ts'
export type { ClipboardImage } from './clipboard.ts'
