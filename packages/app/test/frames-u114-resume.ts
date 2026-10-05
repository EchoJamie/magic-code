import { startResidentHost } from './resident-host-fixture.ts'
import { strict as assert } from 'node:assert'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'

for (const empty of [true, false]) {
  const fixture = startFixture({ turns: [] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const store = createRecordsStore({ dataDir: sandbox.dataDir, workspace: [realpathSync(sandbox.workspace)] })
  if (!empty) {
    const foreign = join(sandbox.root, 'foreign')
    mkdirSync(foreign)
    const foreignStore = createRecordsStore({dataDir: sandbox.dataDir, workspace:[realpathSync(foreign)]})
    foreignStore.serviceFor('u114-foreign').appendEntry({
      kind: 'user', at: Date.now(), content: { text: '另一工作区的真实记录' },
    })
    foreignStore.close()
  }
  const host=await startResidentHost(sandbox,REPO_ROOT + '/.ui-runs/u114/resume-host-'+Date.now())
  const ui = await createUiSession({ fixture, sandbox, columns: 160, rows: 40,
    label: `U114-接回${empty ? '目录空态' : '范围与筛词空态'}`,
    artifacts: REPO_ROOT + '/.ui-runs/u114' })
  try {
    await ui.send('/resume ')
    await ui.key('enter')
    await ui.wait({ text: empty ? '工作目录为空' : '另一工作区的真实记录' })
    await ui.capture({ label: '160-目录或全范围' })
    if (!empty) {
      await ui.key('tab')
      await ui.wait({ text: '本范围没有工作' })
      await ui.capture({ label: '160-本工作区范围为空仍可返回' })
      await ui.key('tab')
      await ui.wait({ text: '另一工作区的真实记录' })
      await ui.send('NO_MATCH_U114')
      await ui.wait({ text: '没有名称匹配' })
      await ui.capture({ label: '160-名称无匹配与范围独立' })
    }
    await ui.key('esc')
    await ui.wait({ absent: '找工作并接回' })
    assert.equal(ui.requests().filter(r => r.path.endsWith('/chat/completions')).length, 0)
    const sessions = await store.listSessions()
    assert.equal(sessions.length, empty ? 0 : 1, '浏览与记录本地命令不能创建会话')
    writeFileSync(join(ui.runDir, 'u114-resume-facts.json'), JSON.stringify({ empty, sessions, requests: ui.requests(), facts: ui.facts() }, null, 2))
    console.log(ui.runDir)
  } finally {
    await ui.close({ keepSandbox: true })
    await host.close()
    await fixture.stop()
    store.close()
  }
}
