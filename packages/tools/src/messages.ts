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

// —— 参数错误（工具集 v1 六件；键名见契约「参数键」）——

/** `read` / `ls` / `grep` / `glob` 的路径取不到。 */
export const OUTPUT_PATH_REQUIRED = '参数错误：path 须为非空字符串'

/** `write` 的内容取不到——**空串合法**（写一个空文件），故判据是「是不是串」。 */
export const OUTPUT_CONTENT_REQUIRED = '参数错误：content 须为字符串'

/** `grep` / `glob` 的模式取不到。 */
export const OUTPUT_PATTERN_REQUIRED = '参数错误：pattern 须为非空字符串'

/** `edit` 的待替换文本取不到——空串会让「唯一出现」失去意义（出现在每一处）。 */
export const OUTPUT_OLD_REQUIRED = '参数错误：old 须为非空字符串'

/** `edit` 的替换文本取不到——**空串合法**（＝删除）。 */
export const OUTPUT_NEW_REQUIRED = '参数错误：new 须为字符串'

// —— 空结果与截断（空输出会被当成失败——明说）——

/** `read` 读到空文件。 */
export const OUTPUT_FILE_EMPTY = '[文件为空]'

/** `read` 到了沙箱的读取上限——量由沙箱定，工具不猜数（契约 `ReadResult.truncated`）。 */
export const OUTPUT_READ_TRUNCATED = '[已截断——文件超长，只读到前一段]'

/** `ls` 空目录。 */
export const OUTPUT_EMPTY_DIR = '[空目录]'

/** `grep` / `glob` 无命中。 */
export const OUTPUT_NO_MATCH = '[无命中]'

/** 命中取满上限——**可能**还有更多（至多这么多条，不是说「就这么多」）。 */
export const cappedOutput = (limit: number): string => `[命中达到上限 ${limit}——可能还有更多]`

// —— `edit` 的四条「不改」——

/** 待替换文本不在文件里——失配即报，**不猜**（猜＝改错地方还说自己改了）。 */
export const OUTPUT_EDIT_NOT_FOUND = '未找到待替换文本——文件未改'

/** 出现多处——「唯一」是 `edit` 的全部语义，定位不了就不动（要改多处＝先给足上下文再改）。 */
export const OUTPUT_EDIT_AMBIGUOUS = '待替换文本出现多处——无法唯一定位，文件未改'

/**
 * 文件超长（读到的只是前一段）——**拒绝编辑并指出出口**。
 *
 * 这一条是数据安全件：读回的是截断文本，改完写回去＝把文件尾巴整段抹掉。
 * 报文的落点不是「失败」，而是**换条路**——`exec` 的 `sed` / `python` 分段改，
 * 这是本工具的出口（第一阶段 `edit` 只做「整读 → 唯一替换 → 写回」这一种改法）。
 */
export const editTooLargeOutput = (limitBytes: number): string =>
  `文件超长（超过 ${Math.round(limitBytes / 1024 / 1024)} MiB）——不做编辑，以免写回截断内容；改用 exec（如 sed / python）分段改`

/** 新旧文本相同——没有要改的（照实说，别写一遍骗一次「已替换」）。 */
export const OUTPUT_EDIT_SAME = 'old 与 new 相同——无需修改'

// —— 成功回执 ——

export const writeDoneOutput = (path: string, bytes: number): string =>
  `已写入 ${path}（${bytes} 字节）`

export const editDoneOutput = (path: string): string => `已替换 1 处（${path}）`

// —— 失败回填（名分 ＋ 沙箱的原委，沙箱的报文精确——本域只加名分、不改口径）——

export const readFailedOutput = (reason: string): string => `读取失败：${reason}`
export const writeFailedOutput = (reason: string): string => `写入失败：${reason}`
export const editFailedOutput = (reason: string): string => `编辑失败：${reason}`
export const searchFailedOutput = (reason: string): string => `搜索失败：${reason}`
export const listFailedOutput = (reason: string): string => `列目录失败：${reason}`

/** 工具名不在注册表内——不抛，照实回填（炸掉循环不是工具域该干的事）。 */
export const unknownToolOutput = (name: string): string => `未注册的工具：${name}`

/** 执行体自己抛了——同样以失败回填，报文带上原委。 */
export const crashedOutput = (message: string): string => `工具执行异常：${message}`
