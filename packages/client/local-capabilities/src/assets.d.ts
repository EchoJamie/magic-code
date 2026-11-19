/**
 * 打包时嵌进 CLI 的二进制（`voice/build/magic-voice.bin`）。
 *
 * Bun 的 `with { type: 'file' }` 导入在源码态给的是**真路径**、编译后给的是 `/$bunfs/…`
 * 虚拟路径；两头都是「一个字符串」，故这里声明成 string 就够。
 */
declare module '*.bin' {
  const path: string
  export default path
}
