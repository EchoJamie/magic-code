import type {
  AgentId,
  Command,
  KernelEvent,
  ModelChoice,
  ModelInfo,
  ModelRef,
  ReasoningSetting,
} from '@magic/contracts'
import { tokenLabel } from './components/lines.ts'
import type { ModelEditor } from './model-editor.ts'
import {
  editorRows,
  effectiveProtocol,
  modelEditor,
  modelOverride,
  protocolLabel,
  providerEditor,
  providerRequest,
} from './model-editor.ts'
import type { createPrompt } from './prompt.ts'
import type { Picker, PickerRow, ShellView } from './view.ts'
import type { ModelScope } from './view/models.ts'
import {
  cacheLabelOf,
  manageMetaOf,
  modelChoiceRows,
  modelHint,
  modelLabel,
  modelRows,
  modelSettingsRows,
  reasoningHint,
  reasoningRows,
  vendorRows,
} from './view/models.ts'
import { dayLabel } from './view/time.ts'

export type ModelNavigation = {
  readonly manageAt: string
  readonly detailAt: ModelRef
  readonly modelScope: ModelScope
  readonly collaborationModel: { readonly member?: AgentId } | null
}

export type ModelPicker = Picker & {
  readonly source: 'model' | 'model-choice' | 'model-detail' | 'model-reasoning' | 'model-manual' | 'model-editor' | 'provider' | 'provider-detail' | 'vendor'
}

/** 模型选择、连接编辑及待保存草稿；执行选择仍通过控制协议受理。 */
export function createModelSettings(ui: {
  readonly view: Pick<ShellView, 'models' | 'vendors' | 'modelCurrent' | 'configuredModels' | 'collaboration'>
  readonly picker: Picker | null
  present: (picker: ModelPicker | null) => void
  receipt: (message: string) => void
  send: (command: Command) => void
  enterLayer: () => void
  popLayer: () => void
  readonly prompt: Pick<ReturnType<typeof createPrompt>, 'open' | 'clear' | 'note'>
}) {
  const { present, receipt, send, enterLayer, popLayer } = ui

  // 开页意图与保存回执分离：撤销开页不能丢弃已经送出的保存。
  let opening: 'model' | 'connect' | 'manage' | null = null

  const request = (action: 'model' | 'connect' | 'manage' | 'refresh', provider?: string): Command => {
    opening = action === 'refresh' ? 'model' : action
    if (action === 'refresh') return { type: 'model.refresh', ...(provider ? { provider } : {}) }
    return { type: action === 'model' ? 'model.list' : 'provider.list' }
  }

  /** 编辑开始时捕获配置版本；异步回执只结束对应草稿。 */
  let catalogStamp: string | null | undefined
  let vendorQuery = false
  let mappingStamp: string | null | undefined
  let editor: (ModelEditor & { stamp?: string | null }) | null = null
  let savingEditor: { draft: ModelEditor & { stamp?: string | null }; attached: boolean } | null = null
  const editorDrafts = new Map<string, ModelEditor & { stamp?: string | null }>()
  let manageAt = ''
  let detailAt: ModelRef = { provider: '', model: '' }
  let modelScope: ModelScope = 'session'
  let collaborationModel: { readonly member?: AgentId } | null = null
  // 离开编辑上下文只撤销界面与应用动作；已发出的配置保存仍等待回执。
  let mappingSave: 'start' | 'update' | 'detached' | null = null

  const leaveContext = (): void => {
    if (savingEditor !== null) savingEditor.attached = false
    if (mappingSave !== null) mappingSave = 'detached'
  }

  /** 映射编辑取全局配置；工作选择与思考取对应 Agent 的有效组合。 */
  const scopeCurrent = (): ModelRef | null => {
    if (modelScope !== 'session') return ui.view.configuredModels[modelScope] ?? null
    if (collaborationModel === null) return ui.view.modelCurrent
    return (
      collaborationModel.member === undefined
        ? ui.view.collaboration?.collaboration?.defaultModel
        : ui.view.collaboration?.members.find((one) => one.agent.agentId === collaborationModel?.member)?.agent.model
    ) ?? null
  }

  const reasoningOf = (pick: ModelRef): ReasoningSetting | undefined => {
    const current = scopeCurrent()
    return current?.provider === pick.provider && current.model === pick.model && 'reasoning' in current
      ? current.reasoning as ReasoningSetting
      : undefined
  }

  /** 这一条模型在手上的资料（缓存里那一条；`undefined` ＝ 缓存里没有它）。 */
  const infoOf = (pick: ModelRef): ModelInfo | undefined => {
    const entry = ui.view.models.find(one => one.provider === pick.provider)
    const info = entry?.cache?.snapshot?.models.find(one => one.id === pick.model)
    const override = entry?.modelOverrides?.[pick.model]
    if (override === undefined) return info
    return {
      ...info,
      id: pick.model,
      limits: { ...info?.limits, ...override.limits },
      capabilities: { ...info?.capabilities, ...override.capabilities },
      ...(override.reasoningSupport === undefined ? {} : { reasoning: override.reasoningSupport })
    }
  }

  /**
   * **模型详情那一屏**——两条动作（思考设置 / 设为默认），资料写在下方那行说明里。
   *
   * 资料那几行都是**手上有才报**（规格 / 描述 / 缓存时间）：拿不到的不编——
   * 与状态行 ④ 那条「分母拿不到就不显示」是同一条规矩。
   */
  const openModelDetail = (pick: ModelRef): void => {
    const entry = ui.view.models.find((one) => one.provider === pick.provider)
    const info = infoOf(pick)
    const limits = info?.limits
    const protocol = effectiveProtocol(entry, ui.view.vendors.find(one => one.vendor === entry?.vendor), pick.model)
    const spec =
      limits === undefined
        ? '规格：供应商没给'
        : `规格：${[
          limits.maxInputTokens === undefined ? null : `输入 ${tokenLabel(limits.maxInputTokens)}`,
          limits.maxOutputTokens === undefined ? null : `输出 ${tokenLabel(limits.maxOutputTokens)}`,
          limits.maxContextTokens === undefined ? null : `窗口 ${tokenLabel(limits.maxContextTokens)}`,
        ]
          .filter((one): one is string => one !== null)
          .join(' · ') || '供应商没给'
        }`
    const lines = [
      `${pick.model}　@ ${entry?.name ?? pick.provider}`,
      ...(info?.name === undefined ? [] : [`显示名 ${info.name}`]),
      ...(info?.description === undefined ? [] : [info.description]),
      spec,
      `协议：${protocol === undefined ? '尚未核实此型号的支持范围' : protocolLabel(protocol)}`,
      entry?.modelOverrides?.[pick.model] === undefined ? '信息来源：供应商信息；缺项未知' : '信息来源：用户填写优先于供应商信息',
      `缓存：${entry?.cache?.snapshot === undefined
        ? '还没取过这一条的模型列表'
        : `${dayLabel(entry.cache.snapshot.fetchedAt)} 取的`
      }`,
    ]
    detailAt = pick
    present({
      source: 'model-detail',
      selected: 0,
      rows: [{ label: '编辑模型信息', meta: '用户填写优先；留空恢复来源', value: 'edit-info', current: false, oneLine: true }, { label: '返回型号列表', meta: '', value: 'back', current: false, oneLine: true }],
      hint: lines.join('\n'),
    })
    requestVendorInfo(pick)
  }

  const requestVendorInfo = (pick: ModelRef): void => {
    const vendor = ui.view.models.find(one => one.provider === pick.provider)?.vendor
    if (!vendorQuery && vendor !== undefined && !ui.view.vendors.some(one => one.vendor === vendor)) {
      vendorQuery = true
      send({ type: 'provider.list' })
    }
  }

  const reasoningSupportOf = (pick: ModelRef) =>
    ui.view.models.find(one => one.provider === pick.provider)?.effectiveReasoning?.[pick.model]

  /** 思考那一屏——**行由能力描述长出来**（见 `reasoningRows`），说明照实说清它声明了什么。 */
  const openReasoningPicker = (pick: ModelRef): void => {
    const support = reasoningSupportOf(pick)
    const rows = reasoningRows(support, reasoningOf(pick) ?? null)
    present({
      source: 'model-reasoning',
      selected: Math.max(0, rows.findIndex((row) => row.current)),
      rows,
      hint: [reasoningHint(support), collaborationModel === null ? '回车＝把这一条用到当前模型上' : `回车＝保存到${collaborationModel.member === undefined ? '后续派生默认' : ui.view.collaboration?.members.find((one) => one.agent.agentId === collaborationModel?.member)?.agent.name ?? '该成员'}`].join('\n'),
    })
  }

  const applyReasoning = (setting: ReasoningSetting): void => {
    const target = collaborationModel
    collaborationModel = null
    present(null)
    if (target !== null) send({ type: 'collaboration.configure', ...target, model: { reasoning: setting } })
    else send({ type: 'model.switch', reasoning: setting })
  }

  /** 接入字段集中编辑；刷新与移除仍是独立动作。 */
  const manageAction = (value: string): void => {
    const entry = ui.view.models.find((one) => one.provider === manageAt)
    if (entry === undefined) return
    if (value === 'edit') {
      const vendor = ui.view.vendors.find(one => one.vendor === entry.vendor)
      if (entry.vendor !== undefined && vendor === undefined) {
        receipt('供应商协议资料尚未加载，请重新打开管理连接')
        return
      }
      enterLayer()
      openEditor(providerEditor(entry.provider, vendor, entry))
      return
    }
    if (value === 'manual') {
      enterLayer()
      openModelEditor(entry.provider)
      return
    }
    if (value === 'refresh') {
      send({ type: 'model.refresh', provider: entry.provider })
      return
    }
    if (value === 'remove') {
      send({ type: 'provider.remove', provider: entry.provider })
    }
  }

  /** `/model manage` 的第一步：**连接一览**（同一份行，取材就是 `ui.view.models`）。 */
  const openManagePicker = (note: string): void => {
    const rows = ui.view.models.map((entry) => ({
      label: entry.name ?? entry.provider,
      meta: manageMetaOf(entry),
      current: false,
      value: entry.provider,
      oneLine: true,
    }))
    const lines = [
      rows.length === 0 ? '还没有接上任何供应商——/model connect 接一条' : '回车＝管理这一条',
      ...(note === '' ? [] : [note]),
    ]
    present({ source: 'provider', selected: 0, rows, hint: lines.join('\n') })
  }

  /**
   * 管理第二步：**这一条能做那几件**（改名 / 更新认证 / 刷新 / 移除）。
   *
   * 连接自己的那几格（id · 供应商 · 区域 · 地址 · 模型 · 缓存）写在**下方那行说明**里——
   * 它们是**查阅**用的，不占候选格（一屏上的每一格都得影响用户的动作）。
   */
  const openManageDetail = (who: string): void => {
    const entry = ui.view.models.find((one) => one.provider === who)
    if (entry === undefined) return // 一览里没有这一条＝不该走到这儿
    manageAt = who
    const lines = [`连接 ${entry.provider}`]
    present({
      source: 'provider-detail',
      selected: 0,
      rows: [
        { label: '编辑连接', meta: protocolLabel(entry.protocol ?? ''), current: false, value: 'edit', oneLine: true },
        { label: '手动填写模型', meta: '无需列表或详情接口', current: false, value: 'manual', oneLine: true },
        {
          label: '刷新这一条',
          meta: cacheLabelOf(entry),
          current: false,
          value: 'refresh',
          oneLine: true,
        },
        {
          label: '移除这条连接',
          meta: '已发生的记录不随它删除',
          current: false,
          value: 'remove',
          oneLine: true,
        },
      ],
      hint: lines.join('\n'),
    })
  }

  /**
   * 保存 / 移除 / 刷新之后**照新的读面重铺**（抽屉还开着才动它，收起时就只留那一行回执）。
   *
   * 重铺哪一屏由**当下开着的那一扇**说了算（加上 `manageAt` 那位：管理明细是**某一条连接**的
   * 一屏）——不靠行内容反推（那要靠字面比较，改一句话就静默失配）。
   *
   * 连接**没了**（刚移除掉）就退回一览：明细说的是那一条，它不在了，这一屏就立不住。
   */
  const refreshManagePicker = (): void => {
    if (ui.picker === null) return
    if (ui.picker.source === 'provider') {
      openManagePicker('')
      return
    }
    if (ui.picker.source === 'provider-detail') {
      if (ui.view.models.some((one) => one.provider === manageAt)) {
        openManageDetail(manageAt)
        return
      }
      // 这一条没了（刚移除掉）⇒ **把这一屏收起**，退回输入行——明细说的是那一条，
      // 它不在了，这一屏就没有主语了。⚠️ 不改成「开一张空的一览」：0 行的抽屉接管着
      // 输入却不给东西可点（打不了字、没得选，看着就是卡死——`openPicker` 那条 P0 的由来）
      present(null)
    }
  }

  const openModelEditor = (provider: string, model = ''): void => {
    const entry = ui.view.models.find(one => one.provider === provider)
    openEditor(modelEditor(provider, model, entry?.modelOverrides?.[model], entry, ui.view.vendors.find(one => one.vendor === entry?.vendor)))
    requestVendorInfo({ provider, model })
  }

  const editorKey = (draft: ModelEditor): string => `${draft.kind}:${draft.provider}:${draft.model ?? ''}`

  const openEditor = (draft: ModelEditor): void => {
    editor = editorDrafts.get(editorKey(draft)) ?? { ...draft, stamp: catalogStamp }
    editor.models = [...new Set([...Object.values(ui.view.configuredModels).filter(one => one.provider === draft.provider).map(one => one.model), ...Object.keys(draft.original?.modelOverrides ?? {}), ...(draft.original?.cache?.snapshot?.models.map(one => one.id) ?? [])])]
    editorDrafts.set(editorKey(editor), editor)
    showEditor()
  }

  const showEditor = (): void => {
    if (editor === null) return
    const focused = ui.picker !== null && ui.picker.source === 'model-editor' ? ui.picker.rows[ui.picker.selected]?.value : undefined
    const rows = editorRows(editor)
    const selected = Math.max(0, rows.findIndex(one => one.value === focused))
    present({
      source: 'model-editor',
      selected,
      rows,
      hint: [
        editor.kind === 'provider' ? `连接 ${editor.provider} · 确认后一次保存` : `连接 ${editor.provider} · 原始型号原样发送；信息可留空`,
        editor.kind === 'model' ? `协议：${protocolLabel(effectiveProtocol(editor.original, editor.vendor, editor.values.model ?? '') ?? '')}；填写能力不代表调用已验证` : '',
        editor.kind === 'provider' && !editor.vendor && editor.original && editor.values.baseURL !== editor.original.baseURL ? '地址已改变：请重新填服务凭据或选择无需认证' : '',
        editor.note ?? '',
      ].filter(Boolean).join('\n')
    })
  }

  const settleEditor = (saved: boolean, note?: string): void => {
    const pending = savingEditor
    if (pending === null) return
    const held = pending.draft
    savingEditor = null
    held.pending = false
    held.note = note ?? (saved ? '已保存' : '保存失败；草稿已保留')
    const visible = editor === held && ui.picker !== null && ui.picker.source === 'model-editor'
    if (!saved) {
      if (visible) showEditor()
      return
    }
    editorDrafts.delete(editorKey(held))
    held.values.apiKey = ''
    if (!visible) return
    if (!pending.attached) {
      // 继续编辑的是已保存配置的新草稿，版本和认证/覆盖基线一起更新。
      const entry = ui.view.models.find(one => one.provider === held.provider)
      const vendor = ui.view.vendors.find(one => one.vendor === entry?.vendor)
      const fresh = held.kind === 'provider'
        ? providerEditor(held.provider, vendor, entry)
        : modelEditor(held.provider, held.values.model ?? '', entry?.modelOverrides?.[held.values.model ?? ''], entry, vendor)
      Object.assign(held, fresh, { stamp: catalogStamp })
      editorDrafts.set(editorKey(held), held)
      showEditor()
      return
    }
    editor = null
    popLayer()
    if (held.kind === 'provider') openManageDetail(held.provider)
    else openModelPicker(note ?? '已保存模型信息；选择型号以设置映射')
  }

  const editorAction = (key: string): void => {
    const held = editor
    if (held === null || held.pending) return
    if (key === 'cancel') {
      popLayer()
      return
    }
    if (key === 'expand') {
      held.expanded = !held.expanded
      showEditor()
      return
    }
    if (key === 'save' || key === 'remove-override') {
      if (savingEditor !== null) {
        held.note = '上一笔保存尚未完成，请稍后重试'
        showEditor()
        return
      }
      try {
        const command: Command = held.kind === 'provider'
          ? { type: 'provider.save', ...providerRequest(held), expectedStamp: held.stamp }
          : {
            type: 'model.override',
            provider: held.provider,
            model: held.values.model!,
            override: key === 'remove-override' ? null : modelOverride(held),
            expectedStamp: held.stamp
          }
        savingEditor = { draft: held, attached: true }
        held.pending = true
        held.note = '正在保存…'
        showEditor()
        send(command)
      } catch (error) {
        held.note = error instanceof Error ? error.message : '保存失败'
        showEditor()
      }
      return
    }
    const field = held.fields.find(one => one.key === key)
    if (field === undefined) return
    if (field.choices !== undefined) {
      held.changed?.add(key)
      const at = field.choices.findIndex(one => one.id === held.values[key])
      held.values[key] = field.choices[(at + 1) % field.choices.length]!.id
      if (key === 'protocol' && held.vendor === undefined && !held.changed?.has('auth') && held.original?.auth === undefined) held.values.auth = held.values.protocol === 'messages' ? 'api-key' : 'bearer'
      showEditor()
      return
    }
    enterLayer()
    ui.prompt.open({
      label: field.label,
      secret: field.secret ?? false,
      value: held.values[key] ?? '',
      caret: (held.values[key] ?? '').length,
      placeholder: field.key === 'model' ? '服务要求的原始 model 标识' : field.key === 'baseURL' ? 'http://localhost:端口/服务前缀' : '留空保持未知或恢复来源',
      note: field.secret ? '隐藏输入；不进入会话或输入历史' : '回车返回编辑页；最后点击保存',
      submit: () => null,
      change: value => {
        held.changed?.add(key)
        held.values[key] = value
      },
      local: value => {
        held.changed?.add(key)
        held.values[key] = value
        popLayer()
        showEditor()
      },
    })
  }

  const freeIdOf = (vendor: string): string => {
    const taken = new Set(ui.view.models.map((entry) => entry.provider))
    if (!taken.has(vendor)) return vendor
    for (let at = 2; ; at += 1) {
      const next = `${vendor}-${at}`
      if (!taken.has(next)) return next
    }
  }

  /** 官方名单由适配提供；自定义入口始终可用。 */
  const openVendorPicker = (): void => {
    present({
      source: 'vendor',
      selected: 0,
      rows: [...vendorRows(ui.view.vendors), { label: '自定义', meta: '本机、局域网或远端服务', value: 'custom', current: false, oneLine: true }],
      hint: '选择供应商；没有模型列表也可以手动填写原始型号',
    })
  }

  const modelTarget = (): string => collaborationModel === null ? '当前工作'
    : collaborationModel.member === undefined ? '后续派生默认'
      : ui.view.collaboration?.members.find(one => one.agent.agentId === collaborationModel?.member)?.agent.name ?? '该成员'

  const modelPickerHint = (note: string): string => {
    if (modelScope === 'default' && ui.view.configuredModels.default === undefined) return [
      '使用此模型开始：设为默认，并先用于尚未配置的三个能力档位，之后可分别调整', note,
    ].filter(Boolean).join('\n')
    const same = modelScope === 'session' && ui.view.configuredModels.cantrip !== undefined
      && ui.view.configuredModels.spell?.provider === ui.view.configuredModels.cantrip.provider && ui.view.configuredModels.spell?.model === ui.view.configuredModels.cantrip.model
      && ui.view.configuredModels.arcane?.provider === ui.view.configuredModels.cantrip.provider && ui.view.configuredModels.arcane?.model === ui.view.configuredModels.cantrip.model
    return [modelHint(ui.view.models, note || undefined, modelScope),
    modelScope === 'session' ? `模型选择与思考设置作用于：${modelTarget()}；映射编辑是全局配置` : '',
    same ? '当前三个档位使用同一模型' : '',
    ].filter(Boolean).join('\n')
  }

  const openModelPicker = (note: string): void => {
    // 设置与工作选择共用读数；实际型号只在映射编辑层出现。
    const rows = modelScope === 'session' ? modelSettingsRows(ui.view.models, ui.view.configuredModels, scopeCurrent(), modelTarget()) : modelRows(ui.view.models, scopeCurrent(), ui.view.configuredModels)
    present({
      source: 'model',
      // 落在**此刻会走的那一条**上（没有去向就从头起——不拿首项冒充当前）
      selected: Math.max(0, rows.findIndex((row) => row.current)),
      rows,
      hint: modelPickerHint(note),
    })
  }

  const refreshModelPicker = (note: string): void => {
    if (ui.picker === null) return
    // 详情 / 思考两屏的资料也来自这一份读数（规格 · 缓存时间 · 思考能力）——照旧的读数重铺
    if (ui.picker.source === 'model-detail') {
      openModelDetail(detailAt)
      return
    }
    if (ui.picker.source === 'model-reasoning') {
      openReasoningPicker(detailAt)
      return
    }
    if (ui.picker.source === 'model-choice') {
      const rows = modelChoiceRows(ui.view.configuredModels, scopeCurrent())
      present({ ...ui.picker, source: 'model-choice', rows })
      return
    }
    if (ui.picker.source !== 'model') return
    const held = ui.picker.rows[ui.picker.selected]?.pick
    const rows = modelScope === 'session' ? modelSettingsRows(ui.view.models, ui.view.configuredModels, scopeCurrent(), modelTarget()) : modelRows(ui.view.models, scopeCurrent(), ui.view.configuredModels)
    const hint = modelPickerHint(note)
    const at =
      held === undefined
        ? ui.picker.selected
        : rows.findIndex((row) => row.pick?.provider === held.provider && row.pick.model === held.model)
    present({
      ...ui.picker,
      source: 'model',
      rows,
      // 认不回来（那条模型从列表里没了）⇒ **夹回范围内**，不跳远、也不越界
      selected: Math.min(
        Math.max(0, at === -1 ? ui.picker.selected : at),
        rows.length - 1,
      ),
      hint,
    })
  }

  const select = (row: PickerRow): boolean => {
    if (ui.picker === null) return false
    // 实际型号详情只读；思考从当前工作/成员设置入口调整。
    if (ui.picker.source === 'model-detail') {
      if (row.value === 'back') {
        popLayer()
        return true
      }
      if (row.value === 'edit-info') {
        enterLayer()
        openModelEditor(detailAt.provider, detailAt.model)
      }
      return true
    }
    if (ui.picker.source === 'model-reasoning') {
      if (row.value === 'budget') {
        const budget = reasoningSupportOf(detailAt)?.budget
        if (budget === undefined) return true
        const current = reasoningOf(detailAt)
        const value = current?.mode === 'budget' ? String(current.budgetTokens) : ''
        enterLayer()
        ui.prompt.open({
          label: '思考 token 预算',
          secret: false,
          value,
          caret: value.length,
          placeholder: '正整数',
          note: `范围：${budget.minTokens ?? '未声明下限'} ～ ${budget.maxTokens ?? '未声明上限'}；回车应用到${modelTarget()}`,
          submit: () => null,
          local: text => {
            const tokens = Number(text)
            if (!Number.isSafeInteger(tokens) || tokens <= 0 || (budget.minTokens !== undefined && tokens < budget.minTokens) || (budget.maxTokens !== undefined && tokens > budget.maxTokens)) {
              ui.prompt.note('预算须为支持范围内的正整数；输入已保留')
              return
            }
            ui.prompt.clear()
            applyReasoning({ mode: 'budget', budgetTokens: tokens })
          },
        })
        return true
      }
      if (row.reasoning !== undefined) applyReasoning(row.reasoning)
      return true
    }
    if (ui.picker.source === 'provider') {
      enterLayer() // 进了明细那一屏（U61）——`←` 退回一览
      openManageDetail(row.value)
      return true
    }
    // 管理明细那一屏：四件动作各走各的（★ 都已由内核的**回话**收尾——见 `onEvent`）
    if (ui.picker.source === 'provider-detail') {
      manageAction(row.value)
      return true
    }
    if (ui.picker.source === 'model-editor') {
      editorAction(row.value)
      return true
    }
    if (ui.picker.source === 'model-manual') {
      enterLayer()
      openModelEditor(row.value)
      return true
    }
    if (ui.picker.source === 'vendor') {
      const vendor = ui.view.vendors.find(one => one.vendor === row.value)
      if (row.value !== 'custom' && vendor === undefined) return true
      enterLayer()
      openEditor(providerEditor(freeIdOf(row.value), vendor))
      return true
    }
    // 工作选择只发档位；实际组合由执行侧读取配置解析。
    if (ui.picker.source === 'model-choice') {
      const choice = row.value as ModelChoice
      if (ui.view.configuredModels[choice] === undefined) {
        receipt(`${modelLabel(choice)} 尚未配置；请在 /model 的模型档位或默认模型中设置`)
        return true
      }
      if (collaborationModel !== null) send({ type: 'collaboration.configure', ...collaborationModel, model: { choice } })
      else send({ type: 'model.switch', choice })
      collaborationModel = null
      modelScope = 'session'
      present(null)
      return true
    }
    if (ui.picker.source === 'model') {
      if (row.value.startsWith('edit:')) {
        enterLayer()
        mappingStamp = catalogStamp
        modelScope = row.value.slice(5) as ModelChoice
        openModelPicker('')
        return true
      }
      if (row.value === 'choose') {
        enterLayer()
        present({
          source: 'model-choice',
          selected: 0,
          rows: modelChoiceRows(ui.view.configuredModels, scopeCurrent()),
          hint: `作用对象：${modelTarget()}；选定只影响此对象，思考等级独立。`
        })
        return true
      }
      if (row.value === 'reasoning') {
        const chosen = scopeCurrent()
        if (chosen === null) {
          receipt('请先配置并选择默认模型或模型档位')
          return true
        }
        detailAt = chosen
        enterLayer()
        openReasoningPicker(chosen)
        return true
      }
      if (row.value === 'manual') {
        enterLayer()
        present({
          source: 'model-manual',
          selected: 0,
          rows: ui.view.models.map(one => ({ label: one.name ?? one.provider, value: one.provider, meta: '手动填写原始型号', current: false, oneLine: true })),
          hint: '选择模型所属连接'
        })
        return true
      }
      if (row.pick === undefined) {
        if (row.value === 'connect' || row.value === 'manage' || row.value === 'refresh') send(request(row.value))
        return true
      }
      // 保存配置与应用工作选择是两个动作；首次明确开始才同时应用 Default。
      if (modelScope !== 'session') {
        if (mappingSave !== null) return true
        const choice = modelScope
        const first = choice === 'default' && ui.view.configuredModels.default === undefined
        mappingSave = first ? 'start' : 'update'
        send({
          type: 'model.configure',
          expectedStamp: mappingStamp,
          choice,
          provider: row.pick.provider,
          model: row.pick.model,
          ...(first ? { initialize: true } : {})
        })
        // 保存回执到达前保留选择与页面。
      }
      return true
    }
    return false
  }

  const receive = (event: Extract<KernelEvent, { kind: 'model.catalog' | 'provider.catalog' }>): void => {
    const intent = opening
    if ((event.kind === 'model.catalog' && intent === 'model') ||
        (event.kind === 'provider.catalog' && (intent === 'connect' || intent === 'manage'))) opening = null
    if (event.kind === 'model.catalog') {
      catalogStamp = event.data.stamp
      if (savingEditor?.draft.kind === 'model' && event.data.saved !== undefined) settleEditor(event.data.saved, event.data.note)
      if (mappingSave !== null && event.data.saved !== undefined) {
        const visible = mappingSave !== 'detached' && ui.picker !== null
          && ui.picker.source === 'model' && modelScope !== 'session'
        const start = visible && mappingSave === 'start'
        mappingSave = null
        // 映射保存只给回执；首次明确开始在成功回执后应用 Default。
        if (visible && event.data.saved === true) {
          modelScope = 'session'
          present(null)
        } else if (!visible) {
          refreshModelPicker(event.data.note ?? '')
        }
        if (start && event.data.saved === true) send({ type: 'model.switch', choice: 'default' })
        if (event.data.note !== undefined) receipt(event.data.note)
      } else if (intent === 'model') {
        openModelPicker(event.data.note ?? '')
      } else {
        // 两处都试：各自只认自己那一扇开着（刷新模型那一屏 / 管理那两屏上刚发起的「刷新这一条」）
        refreshModelPicker(event.data.note ?? '')
        refreshManagePicker()
      }
    }
    if (event.kind === 'provider.catalog') {
      catalogStamp = event.data.stamp
      if (editor?.kind === 'model') {
        editor.vendor = ui.view.vendors.find(one => one.vendor === editor?.original?.vendor)
        if (ui.picker !== null && ui.picker.source === 'model-editor') showEditor()
      }
      refreshModelPicker('')
      if (savingEditor !== null && (savingEditor.draft.kind === 'provider' || event.data.saved === false) && event.data.saved !== undefined) settleEditor(event.data.saved, event.data.note)
      if (intent === 'connect') {
        enterLayer()
        openVendorPicker()
      } else if (intent === 'manage') {
        enterLayer()
        openManagePicker(event.data.note ?? '')
      } else {
        if (event.data.note !== undefined) receipt(event.data.note)
        refreshManagePicker()
      }
    }
  }
  return {
    request,
    cancelOpen: () => { opening = null },
    snapshot: (): ModelNavigation => ({ manageAt, detailAt, modelScope, collaborationModel }),
    restore: (state: ModelNavigation) => {
      opening = null
      leaveContext()
      manageAt = state.manageAt
      detailAt = state.detailAt
      modelScope = state.modelScope
      collaborationModel = state.collaborationModel
    },
    clearTarget: () => { opening = null; leaveContext(); collaborationModel = null },
    sessionScope: () => { leaveContext(); modelScope = 'session' },
    target: (member?: AgentId) => {
      leaveContext()
      collaborationModel = member === undefined ? {} : { member }
      modelScope = 'session'
    },
    receive,
    select,
    showEditor,
    openDetail: openModelDetail,
    dispose: () => {
      editorDrafts.clear()
      editor = null
      savingEditor = null
    },
  }
}
