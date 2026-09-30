# Native wire fixtures

权威：`packages/contracts/src/native.ts` 及其引用的 RunState / NoticeKind / StopPhase。

每个 JSON 文件包含 `family`（Swift 对应 Codable 类型，也对应 TS wire 类型）、`valid`（是否合法）、`message`（原始 wire JSON）。TS 可遍历同一批文件校验；Swift 会解码后再编码，并比较 JSON 语义相等。特别覆盖必填 nullable `gen` / `native.attached.session`，不是缺省字段。

所有路径、标题与身份均为合成内容，不连接真实服务。
