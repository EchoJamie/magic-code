/**
 * 第 15 轮 · 阶段 2 波次 1 —— **端到端接线**的判据（装配根 × 权限域）。
 *
 * 两件都是「光看域内测试看不出来」的事：
 * - **`permissions.rules` 真的接进闸门了**吗——配置 → `parseRules` → `createPermissionGate`；
 *   接没接上，只有从装配跑一遍才看得见（权限域自己的测试注入的是现成规则数组）。
 * - **「总是允许」整条链通了吗**——外壳答复带 `remember` → 控制域原样转手 →
 *   装配递给闸门 → 工作区级账本生效（同类第二次不再问）。任何一跳断了，下面那两条就红。
 *
 * 走**真配置加载器**（`makeStage` 里的 `loadConfig`）与**真闸门**——只有模型是替身。
 *
 * ## ⚠️ U76 之后：只剩「带域名的那一类」还动得了（2026-09-25）
 *
 * 闸门换了底（`gate.ts` 头注那条链）：**默认通**——判轻的**不必先配规则**也不再弹卡；
 * 而**名单收缩到两条**（删除 · 改权限/属主/属性/ACL），那两类**任何规则与授权都放不出**
 * （名单即禁区）。两件事一起改变了本文件的**锚**：
 *
 * - 「不配规则就一律问」**不再是真的**（原第二例）——现在的真话是：判轻的照过、
 *   **名单那两条照问**；
 * - 规则／授权**唯一还够得着**的地方是**取网页**那一件（判重 · 外发 · **带域名**，
 *   `byHost` 是放行判据里仅存的规则口子）。故凡要「规则／授权真的改变了结果」的用例，
 *   夹的都是一发 `web_fetch`：`webSource` 注入替身、提炼那一跳走**环回夹具**
 *   （形制照 `web-fetch.test.ts`）——不这样的话，工具跑不出 `ok: true` 的结果。
 * - 只验「默认通」与「名单照问」的两件**不需要夹具**：一发只读命令 ＋ 一发 `rm` 就说得清。
 */

import { describe, expect, test } from 'bun:test'

import { makeStage } from './support.ts'

describe('权限规则 —— 配置真的接进闸门', () => {

  test('被拒的规则条目**交回装配**（不静默丢弃——读不懂就不生效）', () => {
    const stage = makeStage({
      config: { permissions: { rules: [{ tool: 'exec', op: 'read' }, { tool: 'exec', pth: '/w' }] } },
    })

    try {
      const assembly = stage.assemble()

      expect(assembly.permissionRules).toEqual([{ tool: 'exec', op: 'read' }])
      expect(assembly.rejectedRules).toHaveLength(1)
      expect(assembly.rejectedRules[0]?.index).toBe(1) // 第 2 条（0 起）
      expect(assembly.rejectedRules[0]?.reason).toContain('pth')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
