import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
import { startResidentHost } from './resident-host-fixture.ts'

for (const kind of ['stop', 'lost', 'no-color'] as const) {
  const fixture = startFixture({turns:[{kind:'tool',name:'exec',args:{cmd:'sleep 10; printf BOUNDARY_TOOL_DONE'},reasoning:'BOUNDARY_THINKING',text:'执行受控边界',chunks:3,chunkDelayMs:800}]})
  const sandbox = createSandbox({baseURL:fixture.baseURL, ...(kind==='no-color'?{forceColor:'0'}:{})})
  const host = await startResidentHost(sandbox, REPO_ROOT + '/.ui-runs/u114/boundary-host-'+Date.now())
  const ui = await createUiSession({fixture,sandbox,columns:160,rows:40,label:`U114-motion-${kind}`,artifacts:REPO_ROOT + '/.ui-runs/u114'})
  try {
    await ui.send('边界静止核验');await ui.key('enter');await ui.wait({text:'sleep 10'})
    await Bun.sleep(4400);await ui.capture({label:'160-真实进行至少两轮'})
    if(kind==='lost') {
      await host.close();await ui.wait({text:'连接已断开，暂时无法确认任务状态。'})
    } else {
      await ui.key('ctrl+c');await ui.wait({text:'停止任务'});await ui.key('enter');await ui.wait({text:'○ 空闲'});await ui.wait({text:'「边界静止核验」停了'})
    }
    const first=await ui.capture({label:`160-${kind}-进入静止`})
    await Bun.sleep(1400);const last=await ui.capture({label:`160-${kind}-静止持续`})
    assert.equal(first.text,last.text,'完成停止或失联后正文与计时均应静止')
    if(kind==='no-color') {
      await ui.key('ctrl+o');await ui.wait({text:'PgUp/PgDn'});await ui.capture({label:'160-历史记录静止'})
      await Bun.sleep(1400);await ui.capture({label:'160-历史记录不重播动画'})
    }
    writeFileSync(join(ui.runDir,'u114-motion-boundary-facts.json'),JSON.stringify({kind,facts:ui.facts(),requests:ui.requests()},null,2))
    console.log(ui.runDir)
  } finally {await ui.close({keepSandbox:true});await host.close();await fixture.stop()}
}
