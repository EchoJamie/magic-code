/**
 * 回填给模型的固定报文 —— 集中一处。
 *
 * 为什么单列一文件：这些字符串**是模型的输入**（`ModelMessage('tool').output`），
 * 不是给人看的日志。措辞一变，模型的下一步行为就变——故收在一处、由用例钉死，
 * 改口径时一眼看全（而不是散在分发与各工具的角落里靠 grep）。
 *
 * 口径三条：
 * - **说清「没做」还是「做了但失败」**——「未执行」与「跑了、非 0」是两件事，模型据此
 *   决定重试还是改法；
 * - **不吞原因**——沙箱给的 `reason` / `message` 原样带出（本域不替执行域改口径）；
 * - **不夹带判定**——危险归类归权限域，这里的措辞不出现「危险 / 安全」一类结论。
 */

/** 闸门拒绝了这次调用——不执行。 */
export const OUTPUT_REJECTED = '已拒绝——未执行'

/** 取消发生在执行之前（入口即中止，或闸门在途被中止）——不执行。 */
export const OUTPUT_CANCELED_BEFORE_RUN = '已取消——未执行'

/** 取消发生在执行之中——命令被信号中止（U05 口径：命令被终止＝命令失败一例）。 */
export const OUTPUT_CANCELED_RUNNING = '已取消——命令被中止'

/** 参数解析不出（`ToolCall.invalid`）——模型侧没给成形的参数，不再往下走。 */
export const OUTPUT_INVALID_ARGS = '参数解析不出——未执行'

/** `exec` 的命令字段取不到（键名锚定单一键 `cmd`——写错的键名不该被猜中）。 */
export const OUTPUT_EXEC_NO_CMD = '参数错误：cmd 须为非空字符串'

/** 工具名不在注册表内——不抛，照实回填（炸掉循环不是工具域该干的事）。 */
export const unknownToolOutput = (name: string): string => `未注册的工具：${name}`

/** 执行体自己抛了——同样以失败回填，报文带上原委。 */
export const crashedOutput = (message: string): string => `工具执行异常：${message}`
