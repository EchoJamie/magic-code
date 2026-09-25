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
 *   ⚠️ **U69 补上第三件**：「**做了，但没跑完**」（超时 / 取消）——它**跑过了**、话也说了，
 *   故既不许说成「没做」（伪造零副作用），也不许把已产出的输出丢掉。三件各有各的说法。
 * - **不吞原因**——沙箱给的 `reason` / `message` 原样带出（本域不替执行域改口径）；
 * - **不夹带判定**——危险归类归权限域，这里的措辞不出现「危险 / 安全」一类结论。
 */

import type { RefusalKind } from '@magic/contracts'

/** 闸门拒绝了这次调用——不执行。 */
export const OUTPUT_REJECTED = '已拒绝——未执行'

/**
 * **删除那一类被内核直接拒**——回执要指路（U77 · 设计 · 权限「`rm` 直接拒，指路 `trash`」）。
 *
 * ## 为什么不能只说一句「已拒绝」
 *
 * 拒这一类的理由不是「你该问我」（那是问的活），是「**这个命令不可逆**」——
 * 而**不可逆有可逆的替代**：`trash`（系统自带，macOS 15 起）把东西挪进废纸篓，
 * 找得回来、Finder 里还能「放回原处」。**光拒不说，模型只会换着花样再试**；
 * 说清「用什么」，它下一步就走在正道上。⇒ 这一句**是这一段回执的全部内容**。
 *
 * ## 三副面孔（都是实打实的分支，不是措辞偏好）
 *
 * - **`irreversible` ＋ 有 `trash`**：指路（这是常态）；
 * - **`irreversible` ＋ 没有 `trash`**（macOS 15 之前）：**如实说没有**——
 *   ⚠️ 工单明文「**不许假装它一定在**（指一个跑不了的命令，比不指更坏）」；
 * - **`no-substitute`**（`shred` / `srm`）：**不给替代**——它要的就是删得收不回来，
 *   换个更弱的做法等于没照它办（设计明文）。
 *
 * ## 版面：**第一行要能独立读**
 *
 * 被拒的工具在屏上折叠成**一行**，取的是输出的**首行**（`components/log.ts` 的
 * `verdictOf` —— `rejected` 那一支读 `firstLineOf`）。故「为什么 ＋ 用什么」压在第一行，
 * 补充说明（怎么用 / 交给用户）放第二行。
 *
 * `trashAvailable` 由**装配**探一次递进来（本域不碰文件系统、也不读环境）。
 */
export const refusalOutput = (kind: RefusalKind, trashAvailable: boolean): string => {
  if (kind === 'no-substitute') {
    return [
      '已拒绝——`shred` / `srm` 要的就是删得收不回来，内核不放这条路（也没有可替代的做法）。',
      '要真删就交给用户，别换一个更温和的写法糊过去——那等于没照它办。',
    ].join('\n')
  }

  if (!trashAvailable) {
    return [
      '已拒绝——`rm` 那类删除不可逆；而这台机器上没有 `trash`（macOS 15 起才有），没有可替代的命令。',
      '要删就交给用户，别换别的写法绕。',
    ].join('\n')
  }

  return [
    '已拒绝——`rm` 那类删除不可逆；改用 `trash`（它把东西挪进废纸篓，能捞回、也能「放回原处」）。',
    '用法照 `rm` 写目标：`trash 文件 目录…`——它没有 `-f`，目标不在会报错。',
  ].join('\n')
}

/** 取消发生在执行之前（入口即中止，或闸门在途被中止）——不执行。 */
export const OUTPUT_CANCELED_BEFORE_RUN = '已取消——未执行'

/** 取消发生在执行之中——命令被信号中止（U05 口径：命令被终止＝命令失败一例）。 */
export const OUTPUT_CANCELED_RUNNING = '已取消——命令被中止'

/**
 * 超时——命令**跑过了、被掐断**（U69 修 [[缺陷/D39 exec 超时说成「未能执行」且丢掉已有输出]]）。
 *
 * 三处与旧报文的不同，各有各的由头：
 * - **不说「未能执行」**——它**跑了**（用户那次是 `swift package resolve`，正在下载依赖），
 *   副作用**可能已经发生**；说成「未能执行」＝**伪造零副作用**，而这是设计明文禁的
 *   （「命令跑过的结果与调用不成立分开」）。这一支与**取消**同一口径。
 * - **带上那条上界**——「到了哪条上界」是模型推不出来的那一件（其余正文里都有），
 *   故抬头只说这一件。数取自**真报了的**那条上界（`ExecResult.timeoutMs`），不是本域自己记的。
 * - **一个裸英文词都没有**——旧报文里那个 `（timeout）` 是漏给用户看的中英夹杂。
 *
 * ⚠️ **与取消那一支互斥**：这一句以「已超时」起头，取消那句以「已取消」起头，两句不会同框
 * （超时的判定在取消之前，见 `composeOutcome`）。两支各说全自己那一件：那是**谁叫停的**，
 * 这一句是**哪条上界到点了**。
 */
export const execTimedOutOutput = (boundMs: number): string =>
  `已超时——命令跑过了、被掐断（${boundMs}ms 到点）`

/** 参数解析不出（`ToolCall.invalid`）——模型侧没给成形的参数，不再往下走。 */
export const OUTPUT_INVALID_ARGS = '参数解析不出——未执行'

/** `exec` 的命令字段取不到（键名锚定单一键 `cmd`——写错的键名不该被猜中）。 */
export const OUTPUT_EXEC_NO_CMD = '参数错误：cmd 须为非空字符串'

// —— `exec` 的后台那一形（U70）——

/**
 * 这次装配**没有接后台能力**——`background` 用不了。
 *
 * 为什么不静默退回前台跑：那是**改了这一条调用的意思**（模型说「交出去」，
 * 而它占着这一轮跑完才回），模型据回执作判断时会以为事情在后台。
 * 宁可当场说「用不了」，把「要不要按前台再发一次」交回给它。
 */
export const OUTPUT_BACKGROUND_UNSUPPORTED =
  '这次装配没有接后台能力——background 用不了；去掉它按前台跑（那一轮会一直等到命令结束）'

/**
 * **没交出去**（进程起不来 / 输出文件开不了）——与「交出去了、后来失败了」是两件事。
 *
 * 分开说的由头同 `ExecResult` 那条口径：前者**什么都没在跑**，后者**有东西在跑**——
 * 模型／用户此后的处置完全不同（一个该改命令，一个该去看那个文件）。
 */
export const backgroundStartFailed = (reason: string): string => `没能交出去：${reason}`

/**
 * **交出去了**——回执四件：认得出它的 id · 输出文件路径 · 怎么看进展 · 什么时候会有下一声。
 *
 * ## 两行的次序是**按屏上那一行**定的
 *
 * 工具成功那一行在屏上取的是**末行**（`components/log.ts` 的 `summaryOf`：`exec` 这类
 * 「取末行」，看的是「这一趟跑出了什么」）。故 id 与输出文件路径**写在末行**——
 * 写在首行就会被那一行省掉，而这两件恰好是用户唯一要的两件（它们是 `read` / `stop`
 * 的把手）。反过来说，首行留给「这一轮不等它」那句**因由**：展开时读得到，
 * 收起来也不损失屏幕上该有的信息。
 *
 * ## 措辞上的两处刻意
 *
 * - **「这一轮不等它」**——那是这一形存在的理由（模型由此知道可以接着干别的）；
 * - **末句钉住「安静 ≠ 结束」**——dev server 跑着就没结束（设计明写）。不钉的话，
 *   模型读到一段不再增长的文件很容易当成「它跑完了」。
 */
export const backgroundStarted = (id: string, outputPath: string): string =>
  [
    '已交出去，这一轮不等它——看进展用 read 读下面那个输出文件（跑着的时候读到的是眼下已有的那一段）',
    `〔${id}〕输出文件：${outputPath} —— 跑完会有一条消息带它回来；在那之前别当它已经结束`,
  ].join('\n')
/**
 * `exec` 的超时字段取不到合法值（U69）。
 *
 * **为什么不把 `0` 收下当「不设」**：`0` 读起来像「立刻超时」，`null` 才读得成「一直等」——
 * 一个值不该有两种读法，何况读反了的那一种会**掐掉一条正当的长活**。
 * 故三档写死：**不填 / `null`** ＝ 不设上界；**正数** ＝ 等它这么多毫秒；**其余**全是这一句。
 * 报文里把合法写法直接教给模型——它读到的是一句能照着改的话，不是一个「参数错」。
 */
export const OUTPUT_EXEC_BAD_TIMEOUT =
  '参数错误：timeoutMs 须为正数（毫秒）；不填或给 null ＝ 不设上界（一直等）'

/**
 * `background` 与 `timeoutMs` **一起给了**（U69 集成时加）。
 *
 * 为什么不静默用其中一个：后台那一形**根本不读** `timeoutMs`（它在 `run` 里早早转手就回了），
 * 静默收下＝**把模型给的那个上界丢了**，而它刚在 `timeoutMs` 的描述里读到「到点就按进程组掐断」。
 * 宁可当场说清「只能给一个」，把选择交回给它。
 */
export const OUTPUT_EXEC_BACKGROUND_WITH_TIMEOUT =
  '参数错误：background 与 timeoutMs 只能给一个——交出去的命令没有「等它多久」这一说；' +
  '要当场等结果的命令别给 background'

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

// —— 外部工具（MCP · U38）——
//
// 措辞的两条口径（交互约束 ·「MCP 查询、审批与失败恢复」）：
// - **不称远端撤销**——取消只报「已停止等待 / 已发取消请求」这个实际结果；
// - **不判效果**——超时与断连都**可能已经执行**，故一律写「未收到结果，远端可能已执行」，
//   把「要不要重试」交回用户（恢复也不自动重放效果不明的调用）。

/**
 * 超时 / 断连——**效果未知**是这两条共同的那件事。
 *
 * `reason` 是适配器给的原委（哪条服务器、什么错），本域只加这一句名分、不改它的措辞
 * （同沙箱报文那一条：`ExecResult` 的原委原样带出）。
 */
export const externalFailedOutput = (reason: string): string =>
  `未收到结果，远端可能已执行；核对后再决定是否重试（${reason}）`

/**
 * **这一次压根没发出去**（连接未建立 / 已释放 / 已断开）。
 *
 * 与上面那条分得很开：那条是**效果未知**（要人核对），这条**什么都没发生**——
 * 不许把「没发出去」也说成「远端可能已执行」（吓人，且教模型做无谓的核对）。
 */
export const externalNotSentOutput = (reason: string): string =>
  `未发出——本次调用没有送出去（${reason}）；远端不会执行`

/**
 * 取消（`Ctrl+C` 打断在途）——已停止等待 ＋ 已发取消请求，仅此两件事实。
 *
 * 不带适配器给的缘由：那一位在**在途取消**这一路上恒是「已发出取消请求」（前半句刚说过），
 * 缀上就是同一句话说两遍。**发出去之前**就被取消的那一路不走这儿（那是「没发出去」，
 * 见 `externalNotSentOutput`）——两者的事实不同，措辞也就该不同。
 */
export const externalCanceledOutput = (): string =>
  '已取消——已停止等待并发出取消请求（取消不等于远端撤销，未收到结果）'

/** 服务器自己说这次错了（MCP 的 `isError`）——**调用是成了的**，是「结果如此」。 */
export const externalRefusedOutput = (text: string): string =>
  text === '' ? '外部工具报错（服务器没给说明）' : `外部工具报错：${text}`

/** 回来了但没有内容——说清这一趟是成功的，免得空输出被读成失败。 */
export const externalEmptyOutput = (): string => '[服务器回了空结果——这次调用是成功的]'

/**
 * 非文本部件（图片 / 音频 / 资源）——**明确标示暂不支持**，不静默丢。
 *
 * 报类型与字节数两件：读的人据此知道「有这么个东西、多大」，而**内容本版不解析**
 * （终端显示与模型图像部件各有各的单元，不在这条链上顺手做）。
 */
export const externalPartNote = (
  type: string,
  mimeType: string | undefined,
  bytes: number | undefined,
): string =>
  `[${type} 部件${mimeType === undefined ? '' : `（${mimeType}）`}` +
  `${bytes === undefined ? '' : `：${bytes} 字节`}——本版不解析这类内容，未保留]`

/** 工具名不在注册表内——不抛，照实回填（炸掉循环不是工具域该干的事）。 */
export const unknownToolOutput = (name: string): string => `未注册的工具：${name}`

/** 执行体自己抛了——同样以失败回填，报文带上原委。 */
export const crashedOutput = (message: string): string => `工具执行异常：${message}`
