import {REPO_ROOT} from './driver.ts'
import {readdirSync} from 'node:fs'
import {resolve} from 'node:path'
const root=resolve(REPO_ROOT,'.ui-runs/u114')
const vendor='/Users/jamie/Library/Mobile Documents/iCloud~md~obsidian/Documents/Magic/Magic Code/研发/工具/终端流查看/vendor'
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url),path=decodeURIComponent(url.pathname)
 if(path==='/')return new Response(Bun.file(resolve(import.meta.dir,'u114-replay.html')))
 if(path==='/manifest')return Response.json(readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name.startsWith('2026')).map(entry=>entry.name))
 if(path.startsWith('/vendor/')){const file=resolve(vendor,path.slice(8));if(!file.startsWith(vendor+'/'))return new Response('拒绝',{status:403});return new Response(Bun.file(file))}
 if(path.startsWith('/run/')){const file=resolve(root,path.slice(5));if(!file.startsWith(root+'/'))return new Response('拒绝',{status:403});if(path.endsWith('/frames'))return Response.json(readdirSync(file).filter(name=>name.endsWith('.json')));return new Response(Bun.file(file))}
 return new Response('不存在',{status:404})
}});console.log(`http://127.0.0.1:${server.port}`)
