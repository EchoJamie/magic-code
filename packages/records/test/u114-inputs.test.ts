import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {createRecordsStore} from '../src/index.ts'
const root=resolve(import.meta.dir,'../../../.ui-runs/u114-records')
mkdirSync(root,{recursive:true})
test('U114 持久受理去重，重开可查；编辑撤回与消费单一胜者',()=>{
 const dataDir=mkdtempSync(`${root}/records-`)
 let store=createRecordsStore({dataDir,workspace:['/isolated']})
 let inputs=store.serviceFor('u114').inputs
 expect(inputs.accept({text:'original',ref:'same',purpose:'next'},1)).toMatchObject({state:'pending',revision:0})
 expect(inputs.accept({text:'duplicate',ref:'same'},2).input.text).toBe('original')
 store.close();store=createRecordsStore({dataDir,workspace:['/isolated']});inputs=store.serviceFor('u114').inputs
 expect(inputs.list()).toHaveLength(1)
 expect(inputs.edit('same',0,{text:'edited',purpose:'next'})).toBe(true)
 expect(inputs.consume('same',0,{kind:'user',content:{text:'original'},at:3})).toBeUndefined()
 const entry=inputs.consume('same',1,{kind:'user',content:{text:'edited'},at:3})
 expect(entry).toBeNumber()
 expect(inputs.withdraw('same',1)).toBe(false)
 expect(inputs.consume('same',1,{kind:'user',content:{text:'edited'},at:4})).toBeUndefined()
 expect(inputs.included([])).toEqual([])
 expect(inputs.get('same')?.state).toBe('consumed')
 expect(inputs.included([entry!])).toHaveLength(1)
 expect(inputs.included([entry!])).toHaveLength(0)
 inputs.accept({text:'withdrawn',ref:'withdraw'},5)
 expect(inputs.withdraw('withdraw',0)).toBe(true)
 expect(inputs.consume('withdraw',0,{kind:'user',content:{text:'withdrawn'},at:6})).toBeUndefined()
 store.close()
})
