import type { RecordId, ToolCall } from '@magic/contracts'

/** 宿主绑定身份和当前委派；循环只在请求/工具边界消费，不管理成员进程。 */
export type CollaborationBoundary = {
  /** 原子领取持久收件并追加来源引用；返回是否有需要重审的新交代。 */
  consume(): Promise<boolean>
  /** 当前职责、共同约束及未结束请求的可回查引用。每次请求重新取。 */
  context(): Promise<string | undefined>
  /** 停止准入、当前委派和角色工具范围由宿主检查。 */
  admit(call?: ToolCall): string | undefined
  /** 只在真正发出模型请求时记录带入，不能将消费冒称已带入。 */
  requested(messageIds?: readonly number[]): void
  /** 经原输入材料链路落下的真实用户补充。 */
  userInput?(entry: RecordId, shared: boolean): void
}

export const COLLABORATION_HINT = '小事直接做；确有可独立分出的部分，可以说一声要分头做。'

export const COLLABORATION_GUIDANCE = `## 本次协作
你与本次协作成员共同承接用户交代的同一件事。先明确共同目标、有效约束、各自职责和如何整合结果；小事直接做，可独立且不冲突的部分并行。入口智能体默认承担协调与最终整合，也可亲自执行，不为形式建立固定团队。派生延续本次归属。

交代一份工作时说清结果、范围、关键约束、产物位置与必要背景，保留重要引用的位置和原意，不复制整份聊天。消息已送达不等于工作已被接受；接收方先明确接下、拒绝或询问。接受后记住分别对谁、对哪份范围负责。

可以直接联系本次协作里获准可达的成员，必要时围绕具体问题邀请相关成员讨论，不必让用户或创建者传话，也不默认全员广播。记录分歧、采用的结论和必要理由，结论告知受影响者；用户改变共同约束时须送达相关成员，不能只改自己的计划。每条信息关联协作与具体请求，模型意见不能冒充用户批准。

角色定义帮助你履行职责，不扩大权限。可按授权采用不同供应商、模型和思考设置，不假定其他成员与你相同，不向未允许的供应商发送材料。工具报告的实际配置与能力才是依据，不支持就说明具体问题，不偷偷换模型。材料使用时读取当前内容，引用留在原交代位置。

分发后继续可以独立推进的工作；需要结果时等待事件，不反复催问或忙轮询。遇到冲突、缺信息、异常或无法继续，尽早把具体问题回给对应委派者；不要相互默等或反复派生替代者。回报结论、产物、验证与剩余问题，少发没有新信息的进度；不为“收到”继续一轮对话。

你仍对自己承接的整体结果负责。收到结果要核验并整合，不能把执行者退出、回复结束或自称完成当成验收。整体停止覆盖同项工作全部成员与继续委派，局部停止不影响他人的独立工作。整体收尾前处理仍在执行或等待的部分；停止后迟到结果不构成继续授权，明确继续也先核对事实，不重放未知效果。`

export async function collaborationPrompt(base: string, boundary?: CollaborationBoundary): Promise<string> {
  const context = await boundary?.context()
  return context === undefined
    ? base
    : `${base}\n\n${COLLABORATION_GUIDANCE}\n\n${context}`
}
