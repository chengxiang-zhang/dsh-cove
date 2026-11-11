import{it,expect,vi}from'vitest'
import{deliverTechnicalReply}from'../src/host/services/superagent/executors/native/technical-reply.ts'
it('returns a truthful failure to the waiting worker when consultation fails before any response write',async()=>{
 const failure=Error('write EPIPE'),respond=vi.fn(async(_reply:{success:boolean;text:string})=>{}),record=vi.fn();await deliverTechnicalReply(async()=>{throw failure},respond,record);expect(record).toHaveBeenCalledWith(failure);expect(respond).toHaveBeenCalledOnce();expect(respond.mock.calls[0]?.[0]).toMatchObject({success:false,text:expect.stringContaining('TECHNICAL_CONSULTATION_FAILED')})
})
it('never retries an attempted worker response whose write has unknown outcome',async()=>{
 const respond=vi.fn(async()=>{throw Error('partial write')}),record=vi.fn();await expect(deliverTechnicalReply(async()=>({success:true,text:'answer'}),respond,record)).rejects.toThrow('partial write');expect(respond).toHaveBeenCalledOnce();expect(record).not.toHaveBeenCalled()
})
it('still attempts exactly one failure response when private failure logging is unavailable',async()=>{
 const respond=vi.fn(async(_reply:{success:boolean;text:string})=>{});await deliverTechnicalReply(async()=>{throw Error('consultation unavailable')},respond,()=>{throw Error('database is locked')});expect(respond).toHaveBeenCalledOnce();expect(respond.mock.calls[0]?.[0].success).toBe(false)
})
