"""U115 反向验收。仅在隔离、无人并行测试的工作树使用；finally 逐字恢复源码。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
out = root / (sys.argv[1] if len(sys.argv) > 1 else '.ui-runs/u115-reverse')
out.mkdir(parents=True, exist_ok=True)
actions = root / 'packages/actions/src/collaboration.ts'
assembly = root / 'packages/app/src/assembly.ts'
boundary = root / 'packages/app/src/collaboration-boundary.ts'
originals = {p: p.read_bytes() for p in (actions, assembly, boundary)}
results = []
def run(label, pattern=None):
    args = ['bun', 'test', 'packages/app/test/consultation-reverse.test.ts']
    if pattern: args += ['-t', pattern]
    result = subprocess.run(args, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    (out / f'{label}.txt').write_text(result.stdout)
    results.append({'label': label, 'exit': result.returncode, 'output': f'{label}.txt'})
    return result
try:
    assert run('01-green').returncode == 0
    source = actions.read_text()
    needle = '              deps.wake(spawned.agent.agentId)'
    assert source.count(needle) == 1
    actions.write_text(source.replace(needle, needle + """
              // 临时反向突变：把受理错误退成等待顾问终态；标记只给验收装置。
              if (consulting) {
                await Bun.write(process.env['U115_REVERSE_MARKER']!, 'waiting-for-terminal')
                await new Promise<void>(resolve => { const timer = setInterval(() => {
                  const d = records.getDelegation(spawned.delegation.delegationId)!
                  if (d.deliveryMessageId !== undefined || d.state === 'cancelled') { clearInterval(timer); resolve() }
                }, 5) })
              }
"""))
    red = run('02-red-serial', '顾问终态前')
    assert red.returncode != 0 and '"independentLanded":false' in red.stdout and '"terminalWaitObserved":true' in red.stdout
    assert '等不到' not in red.stdout
    actions.write_bytes(originals[actions])
    source = assembly.read_text()
    needle = '      if (consulting) return CONSULTATION_TOOL_NAMES.includes(name) && (originRole?.tools === undefined || originRole.tools.includes(name))'
    assert source.count(needle) == 1
    assembly.write_text(source.replace(needle, '      if (consulting) return true // 临时反向突变：解除工具限制'))
    source = boundary.read_text()
    needle = '      if (call !== undefined && state.self.purpose === \'consultation\' && (!CONSULTATION_TOOL_NAMES.includes(call.name) || call.external !== undefined)) return `咨询只允许受限只读工具：${call.name}`\n'
    assert source.count(needle) == 1
    boundary.write_text(source.replace(needle, ''))
    red = run('03-red-side-effect', '实际副作用')
    assert red.returncode != 0 and '"legalRead":true' in red.stdout and '"actual":"实际越权写入-643"' in red.stdout
    assert '等不到' not in red.stdout
finally:
    for path, original in originals.items(): path.write_bytes(original)
assert run('04-restored-green').returncode == 0
(out / 'result.json').write_text(json.dumps({'results': results, 'restored': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in originals}}, ensure_ascii=False, indent=2))
print(json.dumps({'out': str(out), 'redDetectedConcreteBehavior': True, 'restoredGreen': True}))
