/**
 * 契约代码层 —— 五份已冻结契约的**代码落点**（U01 第 3 轮）。
 *
 * 单元之间只经「契约」交互，不得依赖对方源码内部（工作分解 · 并行规约 1）。
 * 本目录即该规约在代码层的落点：跨单元引用一律经此处。
 * 单元落位与公开面（工作分解 · 契约清单）——U02 `records/` · U03 `provider/` ·
 * U05 `sandbox/` · U08 `control/`；公开面＝各目录 `index.ts`。
 *
 * 转写自技术方案对应章节，**不加设计**——未定处标 `TODO(规划侧)`；
 * 含糊处回规划侧锚定（工作分解 · 并行规约 4：契约变动回规划侧）。
 *
 * 提示词**已出册**（M04）——段结构降为对话域内部件（`@magic/conversation` 的 `prompt/`），
 * 不再是跨域契约：原 `./prompt.ts` 已删，转出行随之摘除。
 */

export * from './records.ts'
export * from './control.ts'
export * from './sandbox.ts'
export * from './tools.ts'
export * from './config.ts'
