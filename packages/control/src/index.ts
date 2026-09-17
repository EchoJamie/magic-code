/**
 * `@magic/control` —— 控制域（技术方案 · 领域划分：接入面——命令通道 · 事件订阅 · 配对 · 可序列化）。
 *
 * 公开面**只有端口**：
 * - `ControlHub` —— 域侧（装配 → 控制域）：`bind` 装命令路由、`attach` 接传输；
 * - `ControlTransport` —— 外壳侧（契约形态）：`send` 发命令、`subscribe` 收事件；
 * - `KernelTransport` —— 内核侧一端（与外壳侧镜像），供装配与换传输实现取用。
 *
 * `channel.ts` 是这些端口背后的**接线**（`send` / `onCommand` / `publish` / `subscribe`），
 * **不出本包**——旧的直接调用姿势已收进端口之内。
 *
 * 依赖：只 import `@magic/contracts`——域之间互不 import、域不认知外壳与装配
 * （依赖规则 1；越界由仓库级守护拦截）。
 */

export { createControlHub } from './hub.ts'
export type { ControlHubFace } from './hub.ts'

export { createInProcessTransportPair } from './transport.ts'
export type { InProcessTransportPair, KernelTransport, Unsubscribe } from './transport.ts'

export { assertSerializable, isSerializable } from './serializable.ts'
