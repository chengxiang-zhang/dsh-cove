import { expect, it } from 'vitest'
import { CodexNativeExecutor } from '../src/host/services/superagent/executors/engines/codex.ts'

it('collects complete material-heavy history without requesting an oversized multi-turn frame', async () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index}`, status: 'completed', startedAt: index + 1,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: `${index}:` + 'x'.repeat(100000) }] }],
  }))
  const observations: any[] = [], pages: number[] = []
  const io = {
    launch: { epoch: 1, actionRef: { id: 'launch', revision: 1 } }, generation: 'generation', stream: 'stream',
    kernel: { host: { nativeFacts: () => [], nativeRecoveryFacts: () => [] } }, onMessage: () => {},
    observe(value: any) { observations.push(value); return `fact:${observations.length}` },
    async call(method: string, params: any) {
      expect(method).toBe('thread/turns/list')
      expect(params.itemsView).toBe('full')
      const start = Number(params.cursor ?? 0), end = Math.min(history.length, start + params.limit)
      const result = { data: history.slice(start, end), nextCursor: end < history.length ? String(end) : null }
      const bytes = Buffer.byteLength(JSON.stringify({ id: 1, result }))
      if (bytes > 1048576) throw Error('JSONL_FRAME_TOO_LARGE')
      pages.push(bytes)
      return result
    },
  }
  const engine = new (CodexNativeExecutor as any)(io, { hostRef: 'host', engineRef: 'codex', runtimeNamespace: 'private' }, 'original-thread')
  await expect(engine.refreshTurns()).resolves.toBe(true)
  expect(engine.turns()).toEqual(history)
  expect(pages.length).toBeGreaterThan(1)
  expect(Math.max(...pages)).toBeLessThanOrEqual(1048576)
  const recorded = observations.length
  await expect(engine.refreshTurns()).resolves.toBe(true)
  expect(observations).toHaveLength(recorded)
  expect(engine.identity.native_session_id).toBe('original-thread')
})

it('resumes the same thread without embedding aggregate history in its attach frame', async () => {
  const io = {
    launch: { epoch: 1, actionRef: { id: 'launch', revision: 1 } }, generation: 'generation', stream: 'stream',
    kernel: { host: { nativeFacts: () => [], nativeRecoveryFacts: () => [] } }, onMessage: () => {}, observe: () => 'fact', notify: async () => {},
    async call(method: string, params: any) {
      if (method === 'config/read') return { config: { features: Object.fromEntries(['shell_tool','code_mode_host','apps','plugins','remote_plugin','multi_agent'].map(key => [key, false])) } }
      if (method === 'mcpServerStatus/list') return { data: [] }
      if (method === 'thread/resume') {
        if (params.excludeTurns !== true) throw Error('JSONL_FRAME_TOO_LARGE')
        expect(params.threadId).toBe('original-thread')
        return { thread: { id: 'original-thread' } }
      }
      return {}
    },
  }
  const engine = await CodexNativeExecutor.connect(io as any, { hostRef: 'host', engineRef: 'codex', runtimeNamespace: 'private', cwd: '/public', instructions: 'same work', nativeSessionId: 'original-thread' })
  expect(engine.identity.native_session_id).toBe('original-thread')
})

it('collects only events after an exact same-stream cursor and keeps empty-page cursors', async () => {
 const { vi }=await import('vitest')
 const facts=[{ref:'native-event:1',observation:{kind:'request'}},{ref:'native-event:3',observation:{kind:'binding'}}]
 const read=vi.fn((_stream:string,_kind?:string,after?:number)=>{if(after===undefined)throw Error('FULL_STREAM_MATERIALIZED');return facts.filter(f=>Number(f.ref.split(':')[1])>after)})
 const io={launch:{epoch:1,actionRef:{id:'launch',revision:1}},generation:'g',stream:'s',kernel:{host:{fenceDispatch:()=>({kind:'envelope'}),nativeRecoveryFacts:()=>[],nativeFactRefs:()=>facts.map(f=>f.ref),nativeFacts:read}},onMessage:()=>{},observe:()=> 'native-event:4'}
 const engine=new (CodexNativeExecutor as any)(io,{hostRef:'h',engineRef:'codex',runtimeNamespace:'r'},'thread')
 vi.spyOn(engine,'refreshTurns').mockResolvedValue(true)
 expect((await engine.collectNativeEvents(engine.binding.ref,'native-event:1')).events.map((e:any)=>e.ref)).toEqual(['native-event:3'])
 expect(await engine.collectNativeEvents(engine.binding.ref,'native-event:3')).toMatchObject({events:[],cursor:'native-event:3',completeness:'complete'})
 expect(await engine.collectNativeEvents(engine.binding.ref,'native-event:2')).toMatchObject({events:[],completeness:'gap'})
 expect(read).toHaveBeenCalledTimes(2)
})

it.each(['local-before-write','remote-same-message','history-after-ack'])('only propagates a trustworthy local zero-write rejection: %s', async scenario => {
 const {vi}=await import('vitest'),{NativeInputRejected}=await import('../src/host/services/superagent/executors/native/jsonl.ts'),{createHash}=await import('node:crypto')
 const facts:any[]=[],call=vi.fn(async()=>{if(scenario==='local-before-write')throw new NativeInputRejected(1100000);if(scenario==='remote-same-message')throw Error('NATIVE_INPUT_FRAME_TOO_LARGE');return {turn:{id:'accepted-turn'}}})
 const io={launch:{epoch:1,actionRef:{id:'launch',revision:1}},generation:'g',stream:'s',kernel:{host:{fenceDispatch:()=>({kind:'envelope'}),nativeRecoveryFacts:()=>facts}},onMessage:()=>{},observe:(observation:any)=>{facts.push({ref:'native-event:'+facts.length,observation});return 'native-event:'+facts.length},call}
 const options={hostRef:'h',engineRef:'codex',runtimeNamespace:'r'},engine=new (CodexNativeExecutor as any)(io,options,'same-thread'),input={request_id:'request',assignment_revision:1,text:'input',payload_ref:'context',payload_digest:createHash('sha256').update('input').digest('hex')}
 if(scenario==='history-after-ack')vi.spyOn(engine,'receiptFor').mockRejectedValue(new NativeInputRejected(1100000))
 if(scenario==='local-before-write'){
  await expect(engine.sendNativeInput(engine.binding.ref,input)).rejects.toBeInstanceOf(NativeInputRejected)
  expect(facts.some(f=>f.observation.kind==='input-rejected')).toBe(true)
  const restored=new (CodexNativeExecutor as any)(io,options,'same-thread')
  await expect(restored.sendNativeInput(restored.binding.ref,input)).rejects.toBeInstanceOf(NativeInputRejected)
  expect(call).toHaveBeenCalledTimes(1)
 }else{
  expect(await engine.sendNativeInput(engine.binding.ref,input)).toMatchObject({status:'unknown'})
  expect(facts.some(f=>f.observation.kind==='input-rejected')).toBe(false)
  expect(facts.some(f=>f.observation.kind==='input-accepted')).toBe(scenario==='history-after-ack')
 }
})
