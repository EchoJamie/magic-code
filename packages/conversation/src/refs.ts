/**
 * 引用送达 —— **一次交代里的材料按各自的位置取齐**（U36 · 对话域这一半）。
 *
 * 上游是两个只读来源面（执行域实现）：`Skills`（技能目录）与 `Materials`（文件 / 目录）。
 * 本文件只做一件：把用户交代里的**引用表**变成**落账形态**——每一处引用连同
 * 「来源身份 ＋ 本次实际交付的内容」一起，**按它在正文里的位置排好**。
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
  SkillRead,
  Skills,
} from '@magic/contracts'

/** 引用送达——本对象**不存状态**（材料每趟现读，同执行域那一条）。 */
export type RefDelivery = {
  /** 把引用表取齐——**按位置排好**，或整条失败（见文件头注）。 */
  readonly load: (refs: readonly InputRef[]) => Promise<RefLoad>
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
}): RefDelivery {
  /**
   * 取一份技能主文——名字与来源**两件缺一不可**（只给名字的话，同名两条会静默取到
   * 先发现的那条）。取回来的是哪一份，就以它为准落账：外壳只是把名字记在正文里。
   */
  function readSkill(
    ref: Extract<InputRef, { kind: 'skill' }>,
  ):
    | { readonly ok: true; readonly entry: Extract<InputRefEntry, { kind: 'skill' }> }
    | { readonly ok: false; readonly reason: string } {
    if (sources.skills === undefined) {
      return { ok: false, reason: '这次装配没有接技能来源——选定的技能取不了，所以这一条没跑' }
    }

    const read: SkillRead = sources.skills.readMain(ref.name, ref.source)
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
        text: read.material.text,
      },
    }
  }

  /**
   * 文件 / 目录 / 图片：位置与身份取自引用，内容取自材料（那两样在实现侧已合成一份）。
   *
   * **图片那支要落一次库**（`blobs.put`）——它是唯一一处「内容不是文本」的材料：
   * 条目载荷里放不下字节，放的是 blob 引用（见契约 `InputRefEntry` 的 image 支）。
   * 落库这一步在**送达那一趟**做（材料取到了才算数）；没接 blob 落点＝这一条不跑
   * （见 `createRefDelivery` 的入参注）。
   */
  async function entryOf(ref: InputRef, material: Material): Promise<InputRefEntry> {
    if (material.kind === 'dir') {
      return {
        kind: 'dir',
        at: ref.at,
        marker: ref.marker,
        source: material.path,
        label: material.label,
        text: material.text,
        ...(material.omitted === undefined ? {} : { omitted: material.omitted }),
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
        ...(ref.kind === 'file' && ref.external === true ? { external: true as const } : {}),
      }
    }

    return {
      kind: 'file',
      at: ref.at,
      marker: ref.marker,
      source: material.path,
      label: material.label,
      text: material.text,
      ...(material.truncated === true ? { truncated: true as const } : {}),
      ...(ref.kind === 'file' && ref.external === true ? { external: true as const } : {}),
      // ⚠️ `external` 取**引用**上那一位（用户选定那一刻的事实），不取材料的形态：
      // 它记的是「这份材料是作为工作区外的只读附件取来的」，与内容怎么读无关
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
    async load(refs: readonly InputRef[]): Promise<RefLoad> {
      // 按位置排——**只排序，不改次序**（见文件头注）
      const ordered = [...refs].sort((left, right) => left.at - right.at)

      // **要现取的那几支**（技能走自己的口，历史图片那一支连盘都不碰——见 `historyImageOf`）
      const wanted = ordered.filter((ref) => ref.kind !== 'skill' && ref.kind !== 'image')
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
        if (ref.kind === 'skill') {
          const read = readSkill(ref)
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
