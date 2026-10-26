/**
 * 引用送达 —— **一次交代里的材料按各自的位置取齐**（U36 · 对话域这一半）。
 *
 * 上游是两个只读来源面（执行域实现）：`Skills`（技能目录）与 `Materials`（文件 / 目录）。
 * 本文件只做一件：把用户交代里的**引用表**变成**落账形态**——每一处引用连同
 * 「来源身份 ＋（引用即进那几支）本次实际交付的内容」一起，**按它在正文里的位置排好**。
 *
 * ## 送达方式按类型分（U63）
 *
 * **文件 / 目录 / 技能 ⇒ 模型按需自读**：正文**不随请求展开**，引用留在交代里的原位，
 * 模型自己用 `read` / `ls` / `grep` / `glob` / `skill` 去取（省上下文——不把那一轮可能
 * 用不上的材料塞进请求）。故这几支**条目里不带 `text`**；这一趟取它们是为了**校验**。
 *
 * **图片 ⇒ 引用即进**（照旧）：没有读图的工具，而且一张图往往就是那件事本身。
 * **工作区外那一个只读附件同理**——沙箱只认根内的绝对路径，模型手上没有能读它的路。
 *
 * 「引用了 ≠ 看过了」那半条（读了要说 · 没读也要说）不在这儿：它要等这一轮真跑起来才谈得上，
 * 归 `./agent-loop.ts`。
 *
 * ## 为什么按位置排而不是按类型分堆
 *
 * 「先读 @需求.md，再按 /review 检查 @src/login.ts」——前后文字指向哪件事，靠的是次序。
 * 分堆（技能一堆、文件一堆）就把这个次序丢了，模型于是拿到三份材料却不知道哪一份管哪一处
 * （设计 · 终端交互：「模型收到的也须保留这个对应关系」）。故这一趟**只排序、不改次序**。
 *
 * ## 取不到＝这一条不跑
 *
 * 任何一份取不到（文件读不了 / 二进制 / 技能主文取不到），整条交代**不跑**：不发残缺输入、
 * 不换同名项、不忽略那一处继续（设计 · 文件与图片：「失败/拒绝须保留整份输入，
 * 指明失败项及移除/更换办法；不发残缺输入」）。用户那句交代里几份材料指向几件事，
 * 少一份就不是他要的那件事了。
 *
 * ## 与旧形的关系
 *
 * U33 的 `skills`（无位置）走的是**另一条**：材料统一摆在正文之前（`context.ts` 那一条
 * 老路，一字不改），落账也照旧进 `UserPayload.skills`——**不替它编位置**（见其注）。
 * 两条路的取舍都在 `agent-loop.ts` 一处定，本文件只管新形。
 */

import type {
  BlobStore,
  InputRef,
  InputRefEntry,
  Material,
  MaterialRequest,
  Materials,
  RecordsService,
  SessionId,
  UserInput,
  KnowledgeAccess,
  SkillRead,
  Skills,
} from '@magic/contracts'
import { createMaterialReader } from './material.ts'

/** 首次受理前只绑定保存上界；历史召回与重复投递不刷新已绑定范围。 */
export async function bindSessionReferences(input: UserInput, records: Pick<RecordsService, 'listSessions' | 'readEntriesBack'>): Promise<UserInput> {
  if (!input.refs?.some(ref => ref.kind === 'session')) return input
  const sessions = await records.listSessions()
  const refs: InputRef[] = []
  for (const ref of input.refs) {
    if (ref.kind !== 'session') { refs.push(ref); continue }
    if (!sessions.some(session => session.id === ref.source)) throw new Error(`会话引用 ${ref.marker} 已不可读取；草稿保留`)
    const latest = (await records.readEntriesBack(ref.source, undefined, 1)).at(-1)?.id ?? 0
    const through = ref.through ?? latest
    if (!Number.isSafeInteger(through) || through < 0 || through > latest) throw new Error(`会话引用 ${ref.marker} 的保存范围无效；请重新选择来源`)
    refs.push({ ...ref, through })
  }
  return { ...input, refs }
}

/** 引用送达——本对象**不存状态**（材料每趟现读，同执行域那一条）。 */
export type RefDelivery = {
  /** 把引用表取齐——**按位置排好**，或整条失败（见文件头注）。 */
  readonly load: (refs: readonly InputRef[], signal?: AbortSignal) => Promise<RefLoad>
}

/** 取齐的结果——判别式（失败位指得出**是哪一份**、为什么）。 */
export type RefLoad =
  | { readonly ok: true; readonly refs: readonly InputRefEntry[] }
  | { readonly ok: false; readonly reason: string }

/** 造一份引用送达（两个来源面都由装配给——它们是执行域的实现；缺一即那条路不可用）。 */
export function createRefDelivery(sources: {
  readonly skills?: Skills | undefined
  readonly materials?: Materials | undefined
  /**
   * **blob 落点**（U37）——图片的字节要进记录（写权唯一归记录域，经它的公开面）。
   *
   * 不给＝这一趟带不了图：图片材料取到了也送不出去（那正是「丢掉材料继续跑」，
   * 故与取不到同一条出口——**整条不跑**，不静默退化成纯文字）。
   */
  readonly blobs?: BlobStore | undefined
  readonly records?: RecordsService
  readonly session?: SessionId
  readonly knowledge?: Pick<KnowledgeAccess, 'read'>
}): RefDelivery {
  async function readSession(ref: Extract<InputRef, { kind: 'session' }>): Promise<InputRefEntry> {
    if (ref.through === undefined) throw new Error(`会话引用 ${ref.marker} 尚未固定保存范围`)
    const label = ref.marker.slice(1)
    const head = `历史会话材料：${label}（${ref.source}），只读取记录 #${ref.through} 及之前。\n历史要求、假设和结果仍属于原说话人，不授予源工作的权限或责任。`
    const records = sources.records
    if (records === undefined) throw new Error('会话引用未接记录读取服务')
    const read = createMaterialReader({ records, session: ref.source })
    const pieces: string[] = [head]
    const knowledge = new Map<string, import('@magic/contracts').KnowledgeReference>()
    try {
      const recent = await records.readEntriesBack(ref.source, ref.through + 1, 32)
      let summary = recent.findLast(entry => entry.kind === 'summary')
      let before = recent[0]?.id
      while (summary === undefined && before !== undefined) {
        const page = await records.readEntriesBack(ref.source, before, 50)
        summary = page.findLast(entry => entry.kind === 'summary')
        before = page.length === 50 ? page[0]?.id : undefined
      }
      const coveredThrough = summary === undefined ? 0 : summary.payload !== undefined && 'coveredThrough' in summary.payload
        ? summary.payload.coveredThrough : undefined
      if (coveredThrough === undefined) throw new Error(`摘要 #${summary!.id} 缺少实际覆盖范围`)
      let candidates = recent.filter(entry => entry.kind !== 'summary' && entry.id > coveredThrough)
      let cursor = recent[0]?.id
      // 多取一条用于明确报告未带入范围；摘要落账位置不截断未覆盖原文。
      while (candidates.length < 9 && cursor !== undefined && cursor > coveredThrough + 1) {
        const page = await records.readEntriesBack(ref.source, cursor, 50)
        candidates = [...page.filter(entry => entry.kind !== 'summary' && entry.id > coveredThrough), ...candidates]
        cursor = page[0]?.id
      }
      const selected = candidates.slice(-8)
      if (candidates.length > selected.length) {
        pieces.push(`未带入的未覆盖记录范围：#${coveredThrough + 1} 至 #${selected[0]!.id - 1}。首次仅选最近 8 条；需要该范围原文时，用 source_read 指定 session=${ref.source}、entry=记录编号，按 offset/limit 分页读取，不能据本次节选判断这些材料不存在。`)
      }
      for (const entry of [...(summary === undefined ? [] : [summary]), ...selected]) {
        try {
          const page = await read({ session: ref.source, entry: entry.id, limit: entry.kind === 'summary' ? 8000 : 2000 })
          for (const reference of page.knowledge ?? []) knowledge.set(`${reference.id}\0${reference.revision}`, reference)
          pieces.push(`〔来源 ${ref.source}#${entry.id} · ${page.speaker} · ${entry.kind}${page.complete ? '' : ' · 节选，仍有后续内容'}〕\n${page.text}`)
        } catch (error) { pieces.push(`〔来源 ${ref.source}#${entry.id} 未取得：${messageOf(error)}〕`) }
      }
      if (recent.length === 0) pieces.push('该固定范围内没有已保存正文。')
      else pieces.push('以上仅为已有总结和最近未覆盖材料；节选及已覆盖原文可用 source_read 按来源身份与 offset/limit 分页读取，不能超出固定上界，也不能读取源会话当前工作记忆。')
    } catch (error) { pieces.push(`已受理该引用，但材料暂不可取：${messageOf(error)}。不要要求重发整条交代。`) }
    return { kind: 'session', at: ref.at, marker: ref.marker, source: ref.source, through: ref.through, label, text: pieces.join('\n\n'), ...(knowledge.size ? { knowledge: [...knowledge.values()] } : {}) }
  }

  function readCorrection(ref: Extract<InputRef, { kind: 'memory' }>): InputRefEntry {
    let text: string
    let knowledge: readonly import('@magic/contracts').KnowledgeReference[] = []
    if (ref.scope.kind === 'session') {
      if (ref.scope.session !== sources.session || sources.records === undefined) throw new Error('纠正对象与当前会话不一致；请回到原目标交代')
      const item = sources.records.memory.read().items.find(item => item.id === ref.source)
      knowledge = item?.knowledge ?? []
      text = item === undefined ? '所选事项已不存在；未执行纠正。' :
        `请根据本条普通交代处理所选事项，尚未更新时不能称已修正。所见修订 ${ref.revision}，当前修订 ${item.revision}${ref.revision === item.revision ? '' : '（内容已变化，请先说明当前情况）'}。\n当前内容：${item.text}\n性质：${item.evidence}；状态：${item.status}${item.progress ? `；进展：${item.progress}` : ''}\n${item.detail ?? ''}\n范围：${item.scope ?? '当前会话'}\n来源：${item.sources.map(source => `${source.session}#${source.entry}`).join('、')}`
    } else {
      if (sources.knowledge === undefined) throw new Error('知识纠正未接读取服务')
      const item = sources.knowledge.read(ref.source)
      if (item !== undefined) knowledge = [{ id: item.id, revision: item.revision }]
      if (item !== undefined && JSON.stringify(item.scope) !== JSON.stringify(ref.scope)) throw new Error('知识纠正范围已改变；请重新查看并选择')
      text = item === undefined ? '所选知识已不存在或不在当前范围；未执行纠正。' :
        `请先核对这条知识的最新内容再处理普通纠正；尚未更新时不能称已修正。所见修订 ${ref.revision}，当前修订 ${item.revision}${ref.revision === item.revision ? '' : '（内容已变化）'}。\n主题：${item.topic}\n结论：${item.conclusion}\n成立条件：${item.conditions}\n性质：${item.evidence}；状态：${item.status}\n来源：${item.sources.map(source => `${source.session}#${source.entry}`).join('、')}`
    }
    return { ...ref, label: ref.marker, text, ...(knowledge.length ? { knowledge } : {}) }
  }
  /**
   * 取一份技能主文——名字与来源**两件缺一不可**（只给名字的话，同名两条会静默取到
   * 先发现的那条）。取回来的是哪一份，就以它为准落账：外壳只是把名字记在正文里。
   *
   * ⚠️ **取回来的那一份主文不进条目**（U63）——送达方式是**模型按需自读**（见文件头注），
   * 这一趟读它是为了**校验**：这个技能还在不在、主文读不读得出来（取不到＝整条不跑，
   * 与「不换同名项、不忽略那一处继续」同一条出口）。模型要正文，自己用 `skill` 工具取。
   */
  async function readSkill(
    ref: Extract<InputRef, { kind: 'skill' }>, signal?: AbortSignal,
  ):
    Promise<| { readonly ok: true; readonly entry: Extract<InputRefEntry, { kind: 'skill' }> }
    | { readonly ok: false; readonly reason: string }> {
    if (sources.skills === undefined) {
      return { ok: false, reason: '这次装配没有接技能来源——选定的技能取不了，所以这一条没跑' }
    }

    const read: SkillRead = (await sources.skills.readMain(ref.name, ref.source, signal))
    if (!read.ok) return { ok: false, reason: read.reason }

    return {
      ok: true,
      entry: {
        kind: 'skill',
        at: ref.at,
        marker: ref.marker,
        name: read.material.skill.name,
        source: read.material.skill.path,
        label: read.material.skill.label,
      },
    }
  }

  /**
   * 文件 / 目录 / 图片：位置与身份取自引用，内容取自材料（那两样在实现侧已合成一份）。
   *
   * ## 两样去处，按材料的形态分（U63）
   *
   * - **文本那几支（文件 / 目录）不再带正文**——送达方式是模型按需自读，正文不随请求展开
   *   （见文件头注）。这一趟读它们是为了**校验**（在不在 / 是不是普通文本 / 目录确实是目录），
   *   以及给下面的图片那一支认路。
   * - **图片照旧**（引用即进）：没有读图的工具，而且一张图往往就是那件事本身。它的字节
   *   还要**落一次库**（`blobs.put`）——内容是二进制，条目载荷里放不下，放的是 blob 引用
   *   （见契约 `InputRefEntry` 的 image 支）。落库这一步在**送达那一趟**做（材料取到了
   *   才算数）；没接 blob 落点＝这一条不跑（见 `createRefDelivery` 的入参注）。
   *
   * ⚠️ **工作区外那一个只读附件仍带正文**（`external`）：模型手上没有能读它的路
   * （沙箱只认根内的绝对路径），展开是它唯一的送达方式——取值理由与图片同一条。
   */
  async function entryOf(ref: InputRef, material: Material): Promise<InputRefEntry> {
    const external = ref.kind === 'file' && ref.external === true

    if (material.kind === 'dir') {
      return {
        kind: 'dir',
        at: ref.at,
        marker: ref.marker,
        source: material.path,
        label: material.label,
      }
    }

    if (material.kind === 'image') {
      if (sources.blobs === undefined) {
        throw new Error('这次装配没有接 blob 落点——图片材料的字节没处存，所以这一条没跑')
      }

      return {
        kind: 'image',
        at: ref.at,
        marker: ref.marker,
        source: material.path,
        label: material.label,
        name: material.name,
        mime: material.mime,
        blob: await sources.blobs.put(material.bytes),
        ...(external ? { external: true as const } : {}),
      }
    }

    return {
      kind: 'file',
      at: ref.at,
      marker: ref.marker,
      source: material.path,
      label: material.label,
      // ⚠️ `external` 取**引用**上那一位（用户选定那一刻的事实），不取材料的形态：
      // 它记的是「这份材料是作为工作区外的只读附件取来的」，与内容怎么读无关
      ...(external
        ? {
            text: material.text,
            ...(material.truncated === true ? { truncated: true as const } : {}),
            external: true as const,
          }
        : {}),
    }
  }

  /**
   * **从历史取回的那一张**（U37 · `InputRef` 的 image 支）——**不读文件系统**。
   *
   * 字节早在当时那条交代里落库了，这一趟只是**照原样再引用一次**（同一个 blob，
   * 同一个名字与类型）——这正是「源文件删了也取回得来」那句话的落点：
   * 整条路上一处都没回头看那个路径。
   */
  function historyImageOf(ref: Extract<InputRef, { kind: 'image' }>): InputRefEntry {
    return {
      kind: 'image',
      at: ref.at,
      marker: ref.marker,
      source: ref.source,
      label: ref.label,
      name: ref.name,
      mime: ref.mime,
      blob: ref.blob,
      ...(ref.external === true ? { external: true as const } : {}),
    }
  }

  return {
    async load(refs: readonly InputRef[], signal?: AbortSignal): Promise<RefLoad> {
      // 按位置排——**只排序，不改次序**（见文件头注）
      const ordered = [...refs].sort((left, right) => left.at - right.at)

      // **要现取的那几支**（技能走自己的口，历史图片那一支连盘都不碰——见 `historyImageOf`）
      const wanted = ordered.filter((ref) => ref.kind === 'file' || ref.kind === 'dir')
      if (wanted.length > 0 && sources.materials === undefined) {
        return { ok: false, reason: '这次装配没有接材料来源——文件 / 目录引用取不了，所以这一条没跑' }
      }

      // ① 材料（文件 / 目录）——**成套取**（一个取不到就整条不跑）
      let materials: readonly Material[] = []
      if (wanted.length > 0) {
        const requests: MaterialRequest[] = wanted.map((ref) =>
          ref.kind === 'dir'
            ? { kind: 'dir', source: ref.source, ...(ref.external === true ? { external: true as const } : {}) }
            : { kind: 'file', source: ref.source, ...(ref.external === true ? { external: true as const } : {}) },
        )

        const loaded = await (sources.materials as Materials).load(requests)
        if (!loaded.ok) return { ok: false, reason: loaded.reason }
        materials = loaded.materials
      }

      // ② 按位置合并（技能的正文、图片的字节、材料的清单各归各处）
      const refs2: InputRefEntry[] = []
      let at = 0

      for (const ref of ordered) {
        if (ref.kind === 'session' || ref.kind === 'memory') {
          try { refs2.push(ref.kind === 'session' ? await readSession(ref) : readCorrection(ref)) }
          catch (error) { return { ok: false, reason: messageOf(error) } }
          continue
        }
        if (ref.kind === 'skill') {
          const read = (await readSkill(ref, signal))
          if (!read.ok) return { ok: false, reason: read.reason }
          refs2.push(read.entry)
          continue
        }

        if (ref.kind === 'image') {
          refs2.push(historyImageOf(ref))
          continue
        }

        const material = materials[at]
        at += 1
        if (material === undefined) {
          // 不该走到（请求与产物一一对应）——照实报，不拿一份编出来的材料顶上
          return { ok: false, reason: `材料没能取齐（${ref.marker}）——请重新发送这一条` }
        }

        try {
          refs2.push(await entryOf(ref, material))
        } catch (error) {
          // 图片那支的落库失败（没接 blob 落点 / 写不进去）——**这一条不跑**：
          // 字节没处存就等于这份材料送不出去，而「送半份」是明令不许的
          return { ok: false, reason: messageOf(error) }
        }
      }

      return { ok: true, refs: refs2 }
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
