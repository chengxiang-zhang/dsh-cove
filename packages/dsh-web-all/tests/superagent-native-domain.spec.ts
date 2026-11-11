import { expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn() }))
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectNativeDomainAbsence } from '../src/host/services/superagent/kernel/native-domain.ts'
import { isolatedCodexArgs } from '../src/host/services/superagent/executors/engines/codex.ts'
import type { ActionSpec } from '../src/host/services/superagent/kernel/actions.ts'

it.each(['absent','present-env','present-cwd','unobservable','truncated','changed','children'])('attests only a fully observed current no-fork native domain: %s', scenario => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'native-domain-'))),executable=realpathSync(process.execPath),uid=process.getuid!()
 let lists=0
 const spy=vi.mocked(childProcess.execFileSync).mockImplementation(((file:string,args:string[])=>{
  if(file==='/usr/sbin/lsof')return 'p123\nn'+(scenario==='present-cwd'?root:'/another/workspace')+'\n'
  if(args[0]==='-axo'){lists++;return `123 ${uid} ${executable}\n`+(scenario==='changed'&&lists>1?`124 ${uid} ${executable}\n`:'')}
  if(file==='/usr/bin/python3'){if(scenario==='unobservable')throw Error('UNOBSERVABLE');if(scenario==='truncated')throw Error('TRUNCATED');return JSON.stringify({environmentCount:3,argc:2,sameDomain:scenario==='present-env'})}
  return 'Wed Nov 11 23:00:00 2026\n'
 }) as any)
 try {
  const spec={executable,args:isolatedCodexArgs(),processPolicy:scenario==='children'?'children':'single'} as ActionSpec
  const call=()=>inspectNativeDomainAbsence(spec,{root,stateDirectoryVariable:'CODEX_HOME'},root)
  if(scenario==='absent')expect(call()).toMatchObject({uid,runtimeRoot:root,inspected:[{pid:123,startIdentity:'Wed Nov 11 23:00:00 2026'}]})
  else expect(call).toThrow()
  expect(spy.mock.calls.every(([file])=>file==='/bin/ps'||file==='/usr/sbin/lsof'||file==='/usr/bin/python3')).toBe(true)
 }finally{spy.mockReset();rmSync(root,{recursive:true,force:true})}
})
