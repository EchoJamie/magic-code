import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, type Capture, REPO_ROOT } from './ui/driver.ts'
// 夹具专用独立预期：ASCII/组合 é 占 1 列，中文、全角括号及 🙂 占 2 列。
// 不读取产品折行实现，避免实现与判据一起错而仍通过。
function expectedRows(text: string, width: number): string[] {
 const rows: string[] = [], glyphs = [...new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(text)].map(x=>x.segment)
 let row='', columns=0
 for(const glyph of glyphs) {
  assert(/^[\x20-\x7e]$/.test(glyph) || glyph==='é' || glyph==='🙂' || /^[\u3000-\u9fff\uff01-\uff60]$/.test(glyph), '夹具出现未定义列宽的字素')
  const size=/^[\x20-\x7e]$/.test(glyph) || glyph==='é'?1:2
  if(columns+size>width){rows.push(row);row='';columns=0}
  row+=glyph;columns+=size
 }
 return [...rows,row]
}
const description = Array.from({length:55}, (_,i) => `完整用途中文🙂é〔${String(i).padStart(3,'0')}〕`).join(' ')
const paging: unknown[] = []
const probe = 'WIDTH_PROBE_' + 'a'.repeat(110)
const mixed = '中文🙂é\t' + 'LONG_TOKEN_'.repeat(27)
const content = `相同原始正文\n${mixed}\n\n\`\`\`ts\n\tconst value = '${mixed}'\n\`\`\`\n\n\`\`\`diff\n- old ${mixed}\n+ new ${mixed}\n\`\`\``
const ui = await createUiSession({ columns: 200, rows: 40, label: 'U114-最终宽度与矮菜单', artifacts: REPO_ROOT + '/.ui-runs/u114', turns: [
 { kind: 'text', reasoning: probe, text: content, chunks: 1, chunkDelayMs: 1500 },
 { kind: 'tool', name: 'exec', args: { cmd: `printf '${probe}'` } },
 { kind: 'tool', name: 'exec', args: { cmd: `printf '${probe}' >&2; exit 1` } },
 { kind: 'tool', name: 'exec', args: { cmd: 'chmod 700 approved.sh' } },
 { kind: 'text', text: 'WIDTH_ALL_DONE', chunks: 1, chunkDelayMs: 10 },
] })
const frame = async (label: string) => { await Bun.sleep(120); return ui.capture({ label }) }
const resize = async (columns: number, rows = 40) => { if(ui.columns===columns && ui.rows===rows) return; await ui.resize(columns, rows); await ui.wait({ writtenFrame: columns }); await Bun.sleep(120) }
try {
 writeFileSync(join(ui.facts().workspace, 'approved.sh'), '#!/bin/sh\n')
 for (let i = 0; i < 12; i++) {
  const dir = join(ui.facts().workspace, '.magic', 'skills', `width-skill-${String(i).padStart(2, '0')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: width-skill-${String(i).padStart(2, '0')}\ndescription: 用途${i} ${description} 说明结尾${i}\n---\nU114_SKILL_BODY_${i}\n`)
 }
 await ui.send('实际宽度验收'); await ui.key('enter'); await ui.wait({ text: probe }); await frame('200-122列思考无省略')
 await resize(200); const thinking = await frame('200-122列思考无省略'); assert(thinking.text.includes(probe))
 await ui.wait({ text: '○ 空闲' }); await resize(200); await frame('200-混合正文代码与diff')
 await resize(100); await frame('100-相同正文代码与diff'); await resize(200); await frame('200-相同正文代码与diff')
 await ui.send('运行成功失败与拒绝'); await ui.key('enter'); await ui.wait({ text: 'Ctrl+G 审阅' })
 // 前两项为真实 printf/exit 执行；第三项 chmod 等待用户主动拒绝。
 await resize(200); const tools160 = await frame('200-122列成功失败与真实待答')
 assert(tools160.text.includes(probe)); await resize(200); const tools220 = await frame('200-122列成功失败与真实待答'); assert(tools220.text.includes(probe))
 await ui.send('/skills '); await ui.key('enter'); await ui.wait({ text: 'width-skill-00' })
 const data = (f: Capture) => JSON.parse(readFileSync(join(ui.runDir, f.files.data), 'utf8'))
 const selected = '›  width-skill-00'
 // 页号和正文均从真实输出读；原始说明只用于逐行核对，不给产品构造位置。
 const details = (f: Capture) => {
  const match = /详情 (\d+)–(\d+)\/(\d+)/.exec(f.text)
  const [from,to,total] = match === null ? [1,0,0] : match.slice(1).map(Number)
  assert(f.text.includes(selected), '翻页及回翻必须保留同一焦点')
  assert(f.text.includes('Esc'))
  const first = f.lines.findIndex(line => line.includes(selected))
  const last = f.lines.findIndex((line,i) => i>first && (line.includes('PgUp/PgDn 详情') || line.includes('… 上面') || line.includes('直接打字可筛选') || line.includes('width-skill-01')))
  assert(first>=0 && last>first)
  const body=f.lines.slice(first+1,last).map(line=>line.trimStart())
  return {from:from!,to:match===null?body.length:to!,total:match===null?body.length:total!,body}
 }
 const traverse = async (columns:number, rows:number) => {
  const label = `${columns}x${rows}`
  let current = await frame(`${label}-技能来源用途首屏`), start = details(current)
  const expected = ['来源：'+realpathSync(join(ui.facts().workspace,'.magic/skills/width-skill-00')),`用途：用途0 ${description} 说明结尾0`].flatMap(text=>expectedRows(text,columns-5))
  assert.equal(start.from,1);assert.equal(start.total,expected.length)
  if(rows===14) assert(current.text.includes('PgUp/PgDn'),'矮菜单长详情必须可翻页')
  const seen = new Map<number,string>()
  const check = (f:Capture) => {
   const page=details(f);assert.deepEqual(page.body,expected.slice(page.from-1,page.to),'真实详情正文须与完整来源/用途的相应位置一致')
   page.body.forEach((line,i)=>seen.set(page.from-1+i,line))
   paging.push({label:f.label,n:f.n,bytes:data(f).bytes,...page})
   return page
  }
  let page=check(current)
  while(page.to<page.total) {
   const before=current,old=page
   await ui.key('pageDown');current=await frame(`${label}-详情向下-${old.to}`);page=check(current)
   assert(page.from>old.from,'真实PgDn必须推进位置')
   assert.notDeepEqual(page.body,old.body,'真实PgDn必须改变正文')
   assert(data(current).bytes>data(before).bytes && data(current).written>data(before).written,'真实PgDn必须产生新输出')
  }
  assert.deepEqual([...seen.entries()].sort((a,b)=>a[0]-b[0]).map(([,line])=>line),expected,'必须遍历完整来源和用途，包含末尾')
  await ui.key('pageDown');const end=await frame(`${label}-末页再次PgDn保持焦点`);assert.deepEqual(details(end),page)
  while(page.from>1) {
   const before=current,old=page
   await ui.key('pageUp');current=await frame(`${label}-详情回翻-${old.from}`);page=check(current)
   assert(page.from<old.from,'真实PgUp必须回退位置');assert.notDeepEqual(page.body,old.body)
   assert(data(current).bytes>data(before).bytes && data(current).written>data(before).written)
  }
  assert.deepEqual(page,start,'完整回翻必须恢复首屏正文及焦点')
  await ui.key('pageUp');const first=await frame(`${label}-首页再次PgUp保持焦点`);assert.deepEqual(details(first),start)
 }
 // 先标准尺寸，再同一说明的两档宽度，再返回主规格。
 await resize(200);await traverse(200,40)
 await resize(100);await traverse(100,40)
 await resize(200);await traverse(200,40)
 // 上下候选切换归零，再按真实PgDn验证另一条详情，不继承上一条的位置。
 await ui.key('down');await ui.wait({text:'›  width-skill-01'});const other=await frame('200x40-另一技能首屏')
 assert(other.text.includes('详情 1–'));await ui.key('pageDown');const otherPage=await frame('200x40-另一技能真实PgDn')
 assert(!otherPage.text.includes('详情 1–'));assert(otherPage.text.includes('›  width-skill-01'));assert(data(otherPage).bytes>data(other).bytes)
 await ui.key('esc');await ui.wait({text:'Ctrl+G 审阅'});assert.equal(ui.requests().length,4,'本地浏览不能产生模型请求')
 await resize(200);
 await ui.key('ctrl+g'); await ui.wait({ text: '本工作区总是允许' }); await ui.send('n'); await ui.wait({ text: 'WIDTH_ALL_DONE' }); await ui.wait({ text: '○ 空闲' })
 await frame('200-真实拒绝后静止'); await resize(200); await frame('200-真实拒绝后静止')
 writeFileSync(join(ui.runDir, 'u114-width-facts.json'), JSON.stringify({ probe, content, facts: ui.facts(), calls: ui.requests(), paging }, null, 2))
 console.log(ui.runDir)
} finally { await ui.close({ keepSandbox: true }) }
