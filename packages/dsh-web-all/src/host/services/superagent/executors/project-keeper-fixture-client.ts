import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import type { ProjectKeeperRef, ProjectKeeperStatus } from './project-keeper.ts'
export interface KeeperFixtureCapability { version: 1; runId: string; epoch: number; assetSha: string; socketPath: string; token: string; ref: Omit<ProjectKeeperRef, 'managementToken'> }
export function readKeeperFixtureCapability(path: string): KeeperFixtureCapability {
  const stat=lstatSync(path)
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || realpathSync(path)!==path) throw Error('P7_FIXTURE_CAPABILITY_INVALID')
  const value=JSON.parse(readFileSync(path,'utf8')) as KeeperFixtureCapability
  if(value.version!==1 || !value.runId || !Number.isSafeInteger(value.epoch) || value.assetSha!==value.ref.artifactDigest || !value.token || !value.socketPath)throw Error('P7_FIXTURE_CAPABILITY_INVALID')
  return value
}
export async function keeperFixtureRequest(capabilityPath: string, operation: 'current'|'pause'|'resume', expected: Pick<ProjectKeeperRef,'instance'|'root'|'pid'|'artifactDigest'>) {
  const cap=readKeeperFixtureCapability(capabilityPath)
  if(['instance','root','pid','artifactDigest'].some(key=>cap.ref[key as keyof typeof cap.ref]!==expected[key as keyof typeof expected]))throw Error('P7_FIXTURE_REF_MISMATCH')
  return new Promise<{current: boolean; status?: ProjectKeeperStatus; reason?: string}>((resolve,reject)=>{
    const socket=connect(cap.socketPath);let bytes=Buffer.alloc(0),done=false
    const finish=(error?:Error,value?:any)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value)}
    const timer=setTimeout(()=>finish(Error('P7_FIXTURE_TIMEOUT')),3000)
    socket.on('error',error=>finish(error));socket.on('close',()=>{if(!done)finish(Error('P7_FIXTURE_CLOSED'))})
    socket.once('connect',()=>socket.write(JSON.stringify({version:1,runId:cap.runId,epoch:cap.epoch,assetSha:cap.assetSha,token:cap.token,ref:cap.ref,operation})+'\n'))
    socket.on('data',data=>{try{bytes=Buffer.concat([bytes,data]);if(bytes.length>65536)throw Error('P7_FIXTURE_FRAME_LIMIT');const end=bytes.indexOf(10);if(end<0)return;if(end!==bytes.length-1)throw Error('P7_FIXTURE_FRAME_INVALID');const result=JSON.parse(bytes.subarray(0,end).toString());if(result.error)throw Error(result.error);if(result.runId!==cap.runId||result.epoch!==cap.epoch||result.assetSha!==cap.assetSha)throw Error('P7_FIXTURE_IDENTITY');if(result.current && (!result.status || result.status.instance!==cap.ref.instance || result.status.keeperPid!==cap.ref.pid || result.status.artifactDigest!==cap.assetSha || !result.status.startIdentity || Date.now()-result.status.lastHeldAt>2500 || result.status.recordFailed))throw Error('P7_FIXTURE_HOLDER_INVALID');finish(undefined,result)}catch(error){finish(error as Error)}})
  })
}
