import { Worker } from 'node:worker_threads'
import { hostProgramAsset } from './host-program-assets.ts'
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { inspectProjectKeeper, startProjectKeeper, retireProjectKeeper } from './project-keeper.ts'
import type { KeeperFixtureCapability } from './project-keeper-fixture-client.ts'
/** One host-owned mechanism fixture, never the actual project collector. No client-selected target or program. */
export async function createProjectKeeperFixture(input: {runId:string;epoch:number;expiresAt:number}) {
  const root=realpathSync(mkdtempSync('/private/tmp/sa-p7-'))
  const keeper=await startProjectKeeper({collectorRoot:root,runId:input.runId+':p7-holder',epoch:input.epoch,capacity:1,expiresAt:input.expiresAt,commands:[{id:'unused',executable:'/usr/bin/true',args:[],cwd:root}],domain:{readRoots:[root],writeRoots:[root],executableRoots:['/usr/bin'],metadataPaths:[],fixturePorts:[],unixSockets:[]}})
  await retireProjectKeeper(keeper)
  const first=await inspectProjectKeeper(keeper);if(!first.current)throw Error('P7_FIXTURE_NOT_CURRENT')
  const {managementToken:_private,...ref}=keeper,socketPath=join(root,'fixture.sock'),capabilityPath=join(root,'capability.json')
  const cap:KeeperFixtureCapability={version:1,runId:input.runId,epoch:input.epoch,assetSha:keeper.artifactDigest,socketPath,token:randomBytes(32).toString('hex'),ref}
  writeFileSync(capabilityPath,JSON.stringify(cap),{flag:'wx',mode:0o400})
  const worker=new Worker(hostProgramAsset('keeperFixture'),{workerData:{input,keeper,first,cap,socketPath},execArgv:['--experimental-strip-types','--disable-warning=ExperimentalWarning']})
  await new Promise<void>((resolve,reject)=>{worker.once('error',reject);worker.once('message',value=>value.ready?resolve():reject(Error('P7_FIXTURE_START')));worker.once('exit',code=>{if(code!==0)reject(Error('P7_FIXTURE_START'))})})
  let closing:Promise<void>|undefined
  const close=()=>closing??=(new Promise<void>((resolve,reject)=>{worker.once('error',reject);worker.on('message',value=>{if(value.error)reject(Error(value.error));else if(value.closed)resolve()});worker.once('exit',()=>resolve());worker.postMessage({close:true})}))
  return {root,capabilityPath,socketPath,ref,close}
}
