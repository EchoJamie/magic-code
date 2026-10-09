import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../src/settings.ts'
import { attachShell } from '../src/shell.ts'
import { makeStage } from './support.ts'
import { magicAt } from './tmp.ts'

const stdioFile = join(import.meta.dir, '../../mcp/test/support/fake-server.ts')
const httpFile = join(import.meta.dir, '../../mcp/test/support/fake-http-server.ts')
test('原生设置动作保存 stdio/HTTP，下次真装配采用，旧工作不热换；浏览零MCP请求', async () => {
  const stage = makeStage(), httpLog = join(stage.root, 'http.jsonl'), stdioLog = join(stage.root, 'stdio.jsonl')
  const child = Bun.spawn([process.execPath,httpFile],{env:{...process.env,FAKE_MCP_HTTP_PORT:'0',FAKE_MCP_HTTP_LOG:httpLog},stdin:'ignore',stdout:'pipe',stderr:'ignore'})
  const reader=child.stdout.getReader();const first=await reader.read();const port=JSON.parse(new TextDecoder().decode(first.value)).port as number;reader.releaseLock()
  const old=stage.assemble({turns:[{toolCalls:[{name:'mcp__local__echo',args:{text:'旧工作仍能使用原stdio'}}]},{text:'旧工作完成'}]})
  const settings=createSettings({magic:magicAt(stage.root),cwd:stage.workspace,store:old.records,mcp:[],canChangeData:()=>false,mcpWorks:async()=>[],preferencesChanged:async()=>{},grantsChanged:async()=>{},reconnect:async()=>{throw new Error('无目标')}})
  let next:ReturnType<typeof stage.assemble>|undefined, configured:ReturnType<typeof stage.assemble>|undefined
  try {
    const save=async(action:Parameters<typeof settings.apply>[0])=>settings.apply(action,(await settings.read()).stamp)
    await save({type:'mcp.save',name:'local',server:{command:process.execPath,args:[stdioFile]},secrets:{FAKE_MCP_LOG:stdioLog,FAKE_MCP_NAME:'u116-local',PRIVATE:'U116_DUMMY_STDIO'}})
    await save({type:'mcp.save',name:'remote',server:{url:`http://127.0.0.1:${port}/mcp`},secrets:{Authorization:'U116_DUMMY_HTTP'}})
    const read=await settings.read();expect(read.mcp).toEqual([]);expect(existsSync(httpLog)).toBe(false);expect(existsSync(stdioLog)).toBe(false)
    // old是在保存前装配，不能因随后保存热装新配置。
    await old.ready();expect(old.mcpServers()).toEqual([])
    configured=stage.assemble({turns:[{toolCalls:[{name:'mcp__local__echo',args:{text:'stdio真实调用'}}]},{text:'stdio已回填'}]})
    await configured.ready();expect(configured.mcpServers().map(s=>[s.server,s.state.status])).toEqual([['local','available'],['remote','available']])
    const shell=attachShell(configured.shell);await shell.submit('调用已配置的stdio服务器');shell.dispose()
    expect(readFileSync(stdioLog,'utf8')).toContain('stdio真实调用')
    await save({type:'mcp.remove',name:'local'});expect(configured.mcpServers().map(s=>s.server)).toEqual(['local','remote'])
    next=stage.assemble({turns:[{toolCalls:[{name:'mcp__remote__echo',args:{text:'http真实调用'}}]},{text:'HTTP已回填'}]});await next.ready()
    expect(next.mcpServers().map(s=>s.server)).toEqual(['remote'])
    const nextShell=attachShell(next.shell);await nextShell.submit('调用保留的HTTP服务器');nextShell.dispose()
    expect(readFileSync(httpLog,'utf8')).toContain('http真实调用')
    const evidence=process.env['MAGIC_MCP_SETTINGS_EVIDENCE']
    if(evidence)writeFileSync(evidence,JSON.stringify({entry:'settings.apply → existing config parser → actual assembly → official SDK fixture',browserRequests:0,oldBeforeSave:old.mcpServers(),configuredBeforeNextAssembly:configured.mcpServers(),nextAssembly:next.mcpServers(),stdioCalls:readFileSync(stdioLog,'utf8').split('\n').filter(Boolean).map(v=>JSON.parse(v)).filter(v=>v.tool==='echo'),httpCalls:readFileSync(httpLog,'utf8').split('\n').filter(Boolean).map(v=>JSON.parse(v)).filter(v=>v.tool==='echo')},null,2))
    await configured.close()
  } finally {await old.close();await configured?.close();await next?.close();child.kill();await child.exited;stage.dispose()}
},20000)
