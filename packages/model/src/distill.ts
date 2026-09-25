/**
 * **提炼面**（`PageDistiller` · U72）——「取网页」那一次**按问题提炼**的模型调用。
 *
 * 出处：设计 · 工具执行与权限「工具可以调模型——但只到『终点』为止」；端口在契约 `ports.ts`。
 * 本文件是**那一次调用**的实现：把页面正文与问题拼成一次请求，拉完流，把正文交回去。
 *
 * ## ⚠️ 三条护栏，各落在哪一行
 *
 * 1. **不带任何工具**——`ModelRequest` 那一处**根本没有 `tools` 这一格**（见 `distill` 函数体）。
 *    模型域收到 `tools: undefined` 时**连这个键都不发给供应商**（`ai-sdk.ts` 那一行），
 *    故「发不出工具调用」是**结构上**发不出，不是靠这一行的注释守规矩。深度恒为 1 同此。
 * 2. **不是主会话的一轮**——本流的事件**一条都不 `sink.emit`**（同 `compact.ts` 的 `summarize`，
 *    那边写了理由：这是内核自己的一次内务调用；转发了外壳会把提炼出来的那段字当成
 *    **助手的答复**渲染出来，用量也会记成「用户这一轮花的」）。
 * 3. **用哪一条模型——由构造者定死**（`options.model` ＋ `options.gateway`）：
 *    本文件不认「当前会话的模型」，也不去问注册表——**「取网页用的模型」是配置里它自己那一条**
 *    （2026-09-25 用户定）。注册表那条路走不通也**不能走**：它会把选中项盖在 `request.model`
 *    之上（`registry.ts` 的 `stream`），于是「不跟当前会话的模型走」当场失效。
 */

import type { DistillOutcome, ModelGateway, ModelMessage, PageDistiller } from '@magic/contracts'

/**
 * 系统提示词——**读者是那一次提炼调用**（一个临时的、只干这一件事的模型）。
 *
 * 五条各防一种坏答案：
 * - 「只依据这一页」防**用自己的知识补**（那是最难发现的一种错：答案对，但不是这一页说的）；
 * - 「没提到就明说」防**编**，也正是回执里那句「没问到的，页面未必没有」在模型那一侧的落点；
 * - 「别复述整页」防它把**提炼**做成**摘要**（工单验收②判的正是这两者的分别）；
 * - 「照抄不要改写」防数字 / 名称 / 代码在转述里走形；
 * - 「尽量短」防它把省下的上下文又还回去。
 */
const INSTRUCTION = [
  '你在替一个编码助手读一个网页，只把那件事的答案找出来。',
  '',
  '- 只依据下面这一页的正文回答；不要用你自己的知识补，也不要推测页面没写的东西；',
  '- 页面里没提到那件事时，直接说「这一页没有提到」——不要编，也不要含糊过去；',
  '- 直接给答案，不要复述整页、不要写「根据网页内容」一类套话（这一页不会给读的人看）；',
  '- 属于那件事的原文（数字、名称、代码、引用）照抄，不要改写；',
  '- 答案尽量短。',
].join('\n')

export type PageDistillerOptions = {
  /**
   * 那一条模型连接上的网关——**调用方按「取网页用的模型」那一条配置构造好**递进来
   * （见文件头注第 3 条：本文件不自己解析配置、不问注册表）。
   */
  readonly gateway: ModelGateway
  /** 型号名——随本次请求发给那一条连接（`request.model`）。 */
  readonly model: string
}

export function createPageDistiller(options: PageDistillerOptions): PageDistiller {
  return {
    async distill(input, opts): Promise<DistillOutcome> {
      const messages: ModelMessage[] = [
        { role: 'system', content: INSTRUCTION },
        {
          role: 'user',
          content: [
            `问题：${input.prompt}`,
            `页面地址：${input.url}`,
            '',
            '页面正文（markdown）：',
            input.page,
          ].join('\n'),
        },
      ]

      // ⚠️ **这里就是护栏 1**：请求里没有 `tools` 这一格，且**也不许有**
      //（契约 `PageDistiller` 的入参里根本没有来处）。加参数时先读那一段。
      //
      // **这一次的思考设置：明确不要思考**（U99，照压缩那一条口径）。
      // 由头同 `compact.ts` 的 `summarize`，逐条同构：提炼是**信息搬运**（照着问题把页面
      // 正文里那几段摘出来），**不是解题**——思考在这里只烧钱、只拖时间，改不了答案。
      // 且它同属**内核的内务调用**（头注第 2 条：一条都不 `sink.emit`）。
      //
      // ⚠️ **这里一个字不判供应商**：给的是**一套设置**，翻由适配层做（`vendors.ts` 的
      // `reasoningOf`）——翻得出来照发（DeepSeek ⇒ `thinking.type = 'disabled'`）；
      // 这家没有对应参数（MiniMax / 兼容接入）⇒ **什么都不发**，既不静默、也不硬塞一个
      // 没依据的参数；`{ gap }` 那条缺口的说明本就没有听众（内务调用，无用户可报）——
      // 与压缩那一处**同一形制**（见 `compact.ts` 那一段注）。
      //
      // ⚠️ **设置由这里直给，中途没有补齐者**（U99 查清的那一件，与压缩那边不同）：
      // 本件走的网关是装配按 `webFetch.provider` **单造的** `createModelGateway`
      //（`assembly.ts`：不经注册表——那边的 `stream` 会把当前选中盖在 `request.model` 上，
      // 而这件要的恰恰是配置里它自己那一条）。故注册表 `withReasoning` 那条路**一步都不到**，
      // 这一位从 `gateway.ts` 的 `stream` **原样递到取件层**（`ai-sdk.ts` 的 `reasoningOption`
      // 是唯一的读点）——**只改这一行就够**，注册表一个字不用动。
      const stream = options.gateway.stream(
        { model: options.model, messages },
        {
          reasoning: { mode: 'off' },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
      )

      let text = ''
      let failure: { readonly tier: string; readonly message: string } | undefined

      // 事件流要**拉到底**（`ModelStream` 的约定：不拉完，聚合结果不落定）
      for await (const event of stream.events) {
        if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
        // `model.error` 是本流的定论信号——看的是**事件**（域内形态不出口，见 `compact.ts` 同法）
        if (event.kind === 'model.error') failure = event.data
      }

      const settled = await stream.result

      if (failure !== undefined) {
        return { ok: false, kind: 'failed', reason: `${failure.tier}：${failure.message}` }
      }
      if (settled.complete !== true) {
        return { ok: false, kind: 'failed', reason: '这一次提炼没走完（流被掐断了）' }
      }

      const answer = text.trim()
      // **空答案＝坏答案**（同压缩那一条：落一个空回复，读的人只会以为「这一页什么都没有」）
      if (answer === '') {
        return { ok: false, kind: 'failed', reason: '模型没有给出答案正文' }
      }

      return { ok: true, answer, model: options.model }
    },
  }
}
