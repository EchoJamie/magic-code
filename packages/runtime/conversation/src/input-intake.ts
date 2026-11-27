/** 输入受理 —— 从 agent-loop.ts 按职责拆出（行为不变）。
 *
 * 这一份职责：一条交代**开轮之前**的全部闸门与落账——发不出去拦（U60）、引用取不到拦
 * （U36）、图片与模型不配拦（U37）、技能取不到拦（U33）、落账与回执（`message.user` /
 * `input.settled` / `input.pending`）。轮循环本体（`agent-loop.ts`）只在准备完成后接管。
 */
import type {
  InputRef,
  InputRefEntry,
  RecordId,
  UsedSkill,
  UserInput,
} from '@magic/contracts'
import { pendingViews } from '@magic/contracts'
import { appendUserEntry } from './entries.ts'
import type { LoopRuntime } from './loop-runtime.ts'
import { entryLogOf } from './loop-runtime.ts'

/**
 * 普通交代与协作补充共用材料读取、图片能力检查、落账与原稿回执。
 */
export async function prepareInput(
  runtime: LoopRuntime,
  input: UserInput | undefined,
  accepted?: (entry: RecordId) => void|Promise<void>,
  signal?: AbortSignal,
): Promise<{ refs: readonly InputRefEntry[]; skills: readonly UsedSkill[]; entry?: RecordId; latestInput?: string } | undefined> {
  signal?.throwIfAborted()
  const stored = input?.ref === undefined ? undefined : runtime.records.inputs.get(input.ref)
  // **executing 也进**（T1.1b/T2.1 dequeue 流）：本执行者刚出队的行在此落账消费
  // （inputs.consume 接 pending/executing 两源，executing→consumed 归执行者）。
  if (input?.ref !== undefined && stored?.state !== 'pending' && stored?.state !== 'executing') return undefined
  if (stored !== undefined) input = stored.input


  // **此刻发得出去吗**（U60）——拦在**头一件**上（见 `LoopRuntime.submitRefusal`：
  // 发不出去就不该先开一轮、也不该白读那几份材料）。
  const blocked = runtime.submitRefusal?.()
  if (blocked !== undefined) {
    refuse(runtime, input, blocked.reason, blocked.keepDraft)
    return undefined
  }

  // **按引用取材料**（U36）——正文里的每一处引用各取各的那一份，取不到就停在这一条上
  // （见函数头注）。旧形（`skills`，无位置）走另一条老路：材料统一前置、照旧落旧键。
  const refs = input?.refs ?? []
  const selected = input?.skills ?? []
  const delivery = await loadRefs(runtime, refs, signal)
  if (!delivery.ok) {
    // 材料取不到＝这一份输入**没进会话**：配对一次 false（说得出是哪一份、为什么）
    refuse(runtime, input, delivery.reason)
    return undefined
  }

  // **图片与当前模型对不对得上**（U37）——拦在**落账之前**（见 `LoopRuntime.acceptsImages`）。
  // 位置很要紧：这一条要落进会话的话，后面每一轮都会带着一张当前模型看不见的图发出去
  // ——那是「每次都坏一遍」，比当场回绝严重得多。
  const wrongModel = imageRefusal(runtime, delivery.refs)
  if (wrongModel !== undefined) {
    refuse(runtime, input, wrongModel)
    return undefined
  }

  const legacy =
    selected.length === 0
      ? { ok: true as const, used: [] }
      : runtime.skills === undefined
        ? // **没接技能来源**（这次装配压根没装）不是「当作没有技能照跑」——
          // 那正是「丢掉技能后继续这条显式调用」，故与取不到同一条出口
          { ok: false as const, reason: '这次装配没有接技能来源——选定的技能取不了，所以这一条没跑' }
        : (await runtime.skills.load(selected, signal))

  if (!legacy.ok) {
    refuse(runtime, input, legacy.reason)
    return undefined
  }

  signal?.throwIfAborted()
  let acceptedEntry: RecordId | undefined
  try {
    // 用户输入落账——**轮外**（信封 `turn` 为 `null`：输入先于轮）
    //
    // ⚠️ **内核自己投的那一条走的是同一条路**（U70：后台命令跑完了那一句）——它也是
    // 「一条要进上下文的话」，只是载荷记着说话人（`notice`）。它**不进** `refs` / `skills`
    // 那两格（那两格记的是材料），故只多带一个标记位。
    if (input !== undefined) {
      const refusal = runtime.collaboration?.admit()
      if (refusal !== undefined) { refuse(runtime, input, refusal); return undefined }
      // 输入先落记录时就把所属轮定下来；事件仍按「输入先于轮」铸（`message.user` 的 turn 为 null）。
      runtime.turn ??= runtime.nextTurnId()
      const entryId = await appendUserEntry(entryLogOf(runtime), input.text, {
        ...(input.ref === undefined ? {} : {ref:input.ref, revision:stored!.revision}),
        admit: () => runtime.collaboration?.admit(),
        refs: delivery.refs,
        skills: legacy.used,
        ...(input.notice === true ? { notice: true as const } : {}),
        ...(input.background === undefined ? {} : { background: input.background }),
      })
      if (entryId === undefined) {
        const latest = input.ref === undefined ? undefined : runtime.records.inputs.get(input.ref)
        return latest?.state === 'pending' && latest.revision !== stored?.revision
          ? prepareInput(runtime, latest.input, accepted, signal) : undefined
      }
      acceptedEntry = entryId
      runtime.sink.emit(runtime.stamper.stamp('message.user', { entry: entryId }))
      if(input.ref!==undefined)runtime.sink.emit(runtime.stamper.stamp('input.pending',{inputs:pendingViews(runtime.records.inputs.list())}))
      try { await accepted?.(entryId) }
      catch (error) {
        refuse(runtime, input, `输入已保存，但共同补充未能发布（${messageOf(error)}）；未继续执行，原稿保留`)
        reportError(runtime, error)
        return undefined
      }
    }
  } catch (error) {
    // 落账失败＝同样**没进会话**——配对一次 false（不给的话，给了 ref 的那一份草稿
    // 就永远等不到终态）
    refuse(runtime, input, `这一条没能记下来（${messageOf(error)}）——请重新发送`)
    reportError(runtime, error)
    return undefined
  }

  // **收下了**（U33）——完整输入（正文 ＋ 技能正文）已经落进会话，**落账那一刻就成立**。
  //
  // ⚠️ 它与 `skill.used` **不是同一件事**（2026-09-21 规划裁）：这一条说的是「会话收下了」，
  // 那一条说的是「送进了模型」。故此后模型那边再怎么失败（SDK 参数错 / 网络断 / 被停止），
  // **照模型失败报**（`model.error` · `turn.end{reason:'error'}`），**不撤销这一条**、
  // 也不暗示用户重发——已经进了会话的话，重发就是把同一件事说两遍。


  // **回执的兑现点**（收下 ＋ **真读到的**技能）——**按「这一次交代」记一份账，跨轮不重来**
  // （见 `createAnnouncer`：首轮报过一次就不再报，工具轮再多也只有那一次）。
  //
  // ⚠️ **只有旧形（无位置的 `skills`）预支在这里**（U63 改）：那些材料**随请求展开**
  // （照旧统一摆在正文之前），故「送进了模型」当场成立。**正文里的技能引用（U36）不预支**——
  // 它的送达方式改成了「模型按需自读」：引用了**不等于**看过了，只有模型真用 `skill` 工具
  // 取回来、那一份进了下一趟请求，才谈得上「本次使用技能」（与「没读也要有痕迹」那一半
  // 同源，见 `createMaterialWatch`）。
  return { refs: delivery.refs, skills: legacy.used, ...(acceptedEntry === undefined ? {} : { entry: acceptedEntry }),
    ...(input === undefined || input.notice ? {} : { latestInput: input.text }) }
}

/**
 * **带图的那一条，当前模型吃不吃得下**（U37）——`undefined` ＝放行。
 *
 * 只在**明确不支持**时回一句拒绝的缘由（设计：那种情形要「保留输入，提示换模型或移除图片」）。
 * 三种情形各有各的话，用户看完就知道下一步动哪儿：
 * - 「不知道」⇒ 放行（见 `LoopRuntime.acceptsImages`——未知不是「不支持」）；
 * - 「支持」⇒ 放行；
 * - 「不支持」⇒ 拒绝，并**指出两条出路**（换模型 / 把图去掉）。
 *
 * 本域不持有实际型号；拒绝原因通过统一能力读数给出，设置入口可查看实际选择。
 */
function imageRefusal(
  runtime: LoopRuntime,
  refs: readonly InputRefEntry[],
): string | undefined {
  const images = refs.filter((ref) => ref.kind === 'image')
  if (images.length === 0) return undefined
  if (runtime.acceptsImages?.() !== false) return undefined

  const which = images.map((ref) => ref.name).join(' · ')

  return (
    `这一条带${images.length === 1 ? '了一张图片' : `了 ${images.length} 张图片`}（${which}），` +
    `而当前模型明确不支持图片输入——换一个支持看图的模型（用 /model 看此刻是谁），` +
    `或把这几处图片引用去掉再发（这一条没跑，原稿还在）。`
  )
}

/**
 * 取齐这一条交代里的引用（U36）——**没接引用送达＝没有引用可取**。
 *
 * 三态收在一处：给了引用但这次装配没接送达（`rejected`，与「取不到」同一条出口——
 * 那正是「丢掉材料继续跑」）· 取不到（`rejected`）· 取齐了。
 */
async function loadRefs(
  runtime: LoopRuntime,
  refs: readonly InputRef[],
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly refs: readonly InputRefEntry[] } | { readonly ok: false; readonly reason: string }> {
  if (refs.length === 0) return { ok: true, refs: [] }
  if (runtime.refs === undefined) {
    return { ok: false, reason: '这次装配没有接材料来源——交代里的引用取不了，所以这一条没跑' }
  }

  return (await runtime.refs.load(refs, signal))
}

/**
 * 一份输入**没进会话**——配对一次 `ok:false`（给了 `ref` 才发；失败不静默）。
 *
 * `keepDraft`（U60）：**这一份草稿要不要还回输入行**。缺省还（U33 起的老规矩：没送出
 * 就不丢稿——用户要改的多半就是稿子里那一处引用）。给 `false` 只有一种情形：
 * **下一步要敲的是一条命令**（见 `SubmitRefusal.keepDraft`：还回去反而挡路）。
 * 稿子不丢，它在 `↑` 历史里。
 */
export function refuse(
  runtime: LoopRuntime,
  input: UserInput | undefined,
  reason: string,
  keepDraft?: boolean,
): void {
  if (input === undefined) return
  if(input.ref!==undefined)runtime.records.inputs.fail(input.ref,reason)
  runtime.sink.emit(
    runtime.stamper.stamp('input.settled', {
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ok: false,
      reason,
      ...(keepDraft === undefined ? {} : { keepDraft }),
    }),
  )
}

/** 兜底（轮外）——内核自身异常：发 `error` 事件并交回结束方式。 */
export function reportError(runtime: LoopRuntime, error: unknown): 'error' {
  runtime.sink.emit(
    runtime.stamper.stamp('error', { message: `对话域异常：${describeError(error)}` }),
  )
  return 'error'
}

export function messageOf(error: unknown): string {
  return describeError(error)
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
