import { describe, expect, test } from 'bun:test'
import type { EventSink, EventStamper, KernelEvent, PermissionContext, ToolCall } from '@magic/contracts'
import { analyze, createPermissionGate } from '../src/index.ts'

const ctx: PermissionContext = {
  roots: ['/work/proj'],
  declaredRoots: ['/work/proj'],
  defaultRoot: '/work/proj',
}

const call = (command: string): ToolCall => ({ id: 'c1', name: 'exec', args: { command } })

function harness() {
  const events: KernelEvent[] = []
  const sink: EventSink = { emit: (event) => { events.push(event) } }
  let id = 0
  const stamper: EventStamper = { stamp: (kind, data) => ({ id: ++id, turn: null, at: id, session: 's', kind, data }) as KernelEvent, beginTurn: () => {} }
  const gate = createPermissionGate({ sink, stamper, now: () => 10 })
  return { gate, events }
}

describe('默认放行', () => {
  test.each([
    ['ls -la', '只读命令'],
    ['mv src old-src', '移动'],
    ['chmod 755 x', '改权限'],
    ['chown me x', '改属主'],
    ['git reset --hard HEAD~1', '破坏性 git'],
    ['curl -X POST https://example.com', '外发'],
    ['cd /tmp && rm-not-really x', '判不出的命令'],
    ['/bin/echo hi', '绝对路径的普通程序'],
    ['echo sudo', '把 sudo 当正文'],
    ["grep 'rm -rf' notes.txt", '把删除写法当正文'],
  ])('%s（%s）不问、直接放行', async (cmd) => {
    const { gate } = harness()
    expect(await gate.decide(call(cmd), ctx, 7)).toBe('approve')
    expect(gate.refusalOf?.(call(cmd), ctx)).toBeUndefined()
  })

  test('非 exec 工具（读 / 写 / 外部工具 / 表外工具）一律放行', async () => {
    const { gate } = harness()
    for (const name of ['read', 'write', 'edit', 'grep', 'web_fetch', 'mcp__server__tool', 'agent_list']) {
      expect(await gate.decide({ id: name, name, args: { path: '/etc/hosts' } }, ctx, 1)).toBe('approve')
    }
  })

  test('放行也落一条 auto 裁决（审计事实）', async () => {
    const { gate, events } = harness()
    await gate.decide(call('ls'), ctx, 7)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'tool.decision', data: { call: 7, decision: 'approve', decider: 'auto', elapsedMs: 0 } })
  })
})

describe('禁止清单', () => {
  test.each([
    ['rm -rf build', 'rm'],
    ['rmdir empty', 'rmdir'],
    ['unlink link', 'unlink'],
    ['shred -u secret', 'shred'],
    ['srm secret', 'srm'],
    ['find . -delete', 'find -delete'],
    ['cd /tmp && rm -rf x', '复合命令里的一段'],
    ['/bin/rm x', '绝对路径'],
    ['sudo rm -rf /tmp/x', '隔着 sudo'],
  ])('%s（%s）被拒，理由是不可逆', (cmd) => {
    const { gate } = harness()
    expect(gate.refusalOf?.(call(cmd), ctx)).toBe('irreversible')
  })

  test.each([['su', 'su'], ['su - root', '带用户'], ['sudo su', '隔着 sudo']])('%s（%s）被拒', (cmd) => {
    const { gate } = harness()
    expect(gate.refusalOf?.(call(cmd), ctx)).toBe('su')
  })

  test('拒的那一笔落 kernel 裁决，且不执行', async () => {
    const { gate, events } = harness()
    expect(await gate.decide(call('rm -rf x'), ctx, 9)).toBe('reject')
    expect(events[0]).toMatchObject({ kind: 'tool.decision', data: { call: 9, decision: 'reject', decider: 'kernel' } })
  })
})

describe('sudo 专用认证', () => {
  test.each([
    ['sudo ls', 'ls'],
    ['sudo -u root ls /root', 'ls'],
    ['sudo  -nope  apt update', 'apt'],
    ['sudo -- apt update', 'apt'],
    // shell 重定向由当前用户的 shell 执行，不改变 sudo 目标，也不碰密码通道。
    ['sudo ls > out.txt', 'ls'],
    ['sudo ls >> out.txt', 'ls'],
    ['sudo tee file < src', 'tee'],
    ['sudo < src tee file', 'tee'],
    ['sudo ls 2>&1', 'ls'],
    ['sudo sh-not-a-shell > out.txt', 'sh-not-a-shell'],
  ])('%s 是合格的短命令', (cmd, program) => {
    const { gate } = harness()
    expect(gate.refusalOf?.(call(cmd), ctx)).toBeUndefined()
    expect(gate.sudoPlan?.(call(cmd), ctx)).toEqual({
      command: cmd.trim(),
      run: cmd.trim().replace(/^sudo/, 'sudo -n'),
      program,
    })
  })

  test('重定向原样保留到 sudo -n 执行行', () => {
    const { gate } = harness()
    expect(gate.sudoPlan?.(call('sudo ls > out.txt'), ctx)?.run).toBe('sudo -n ls > out.txt')
    expect(gate.sudoPlan?.(call('sudo tee file < src'), ctx)?.run).toBe('sudo -n tee file < src')
    expect(gate.sudoPlan?.(call('sudo ls 2>&1'), ctx)?.run).toBe('sudo -n ls 2>&1')
  })

  test.each([
    ['sudo ls\nrm -rf x', '换行'],
    ['sudo ls && sudo whoami', '复合命令'],
    ['sudo sh -c "ls"', 'sh -c'],
    ['sudo bash -c "ls"', 'bash -c'],
    ['sudo < script.sh sh', '重定向后的 shell 仍然拒绝'],
    ["sudo sh <<'EOF'\nls\nEOF", 'here-doc'],
    ['sudo python3 deploy.py', '解释器'],
    ['sudo node x.mjs', '解释器'],
    ['sudo ./deploy.sh', '脚本'],
    ['sudo /tmp/deploy.py', '脚本'],
    ['sudo $(whoami)', '命令替换'],
    ['nice sudo ls', 'sudo 不是第一个词'],
    ['sudo -S ls', '自己写认证旗标'],
    ['sudo', '没有目标命令'],
  ])('%s（%s）直接拒，并给出具体缘由', (cmd, why) => {
    const { gate } = harness()
    expect(gate.refusalOf?.(call(cmd), ctx)).toBe('sudo-unsupported')
    expect(gate.refusalDetail?.(call(cmd), ctx)).toBeTruthy()
    void why
  })

  test('sudo rm / sudo su 仍按禁止清单拒，不弹密码组件', () => {
    const { gate } = harness()
    expect(gate.refusalOf?.(call('sudo rm -rf x'), ctx)).toBe('irreversible')
    expect(gate.refusalOf?.(call('sudo su'), ctx)).toBe('su')
    expect(gate.sudoPlan?.(call('sudo rm -rf x'), ctx)).toBeUndefined()
  })
})

describe('机械分析面', () => {
  test('analyze 对禁止项给 refusal / detail，对合格 sudo 给 plan', () => {
    expect(analyze(call('rm x'), ctx)).toMatchObject({ refusal: 'irreversible' })
    expect(analyze(call('sudo sh -c ls'), ctx)).toMatchObject({ refusal: 'sudo-unsupported' })
    expect(analyze(call('sudo ls'), ctx)).toMatchObject({ sudo: { program: 'ls', run: 'sudo -n ls' } })
    expect(analyze({ id: 'r', name: 'read', args: { path: '/etc/hosts' } }, ctx)).not.toHaveProperty('refusal')
  })
})
