import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { inspectProjectKeeper } from './project-keeper.ts'
const {input,keeper,first,cap,socketPath}=workerData
  let paused=false,closed=false,queue=Promise.resolve()
  const sockets=new Set<import('node:net').Socket>()
  const sameProcess=()=>{const start=execFileSync('/bin/ps',['-p',String(keeper.pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:1000}).trim();if(start!==first.status.startIdentity)throw Error('P7_FIXTURE_IDENTITY_LOST')}
  const identity=async()=>{const current=await inspectProjectKeeper(keeper);if(!current.current||current.status.startIdentity!==first.status.startIdentity)throw Error('P7_FIXTURE_IDENTITY_LOST');return current}
  const server=createServer(socket=>{if(closed||sockets.size>=4){socket.destroy();return}sockets.add(socket);let bytes=Buffer.alloc(0),used=false;const timer=setTimeout(()=>socket.destroy(),3500);socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);sockets.delete(socket)});socket.on('data',data=>{bytes=Buffer.concat([bytes,data]);if(bytes.length>4096||used){socket.destroy();return}const end=bytes.indexOf(10);if(end<0)return;used=true;queue=queue.then(async()=>{try{if(end!==bytes.length-1||Date.now()>=input.expiresAt||closed)throw Error('P7_FIXTURE_EXPIRED');const m=JSON.parse(bytes.subarray(0,end).toString());if(Object.keys(m).sort().join(',')!=='assetSha,epoch,operation,ref,runId,token,version'||m.version!==1||m.runId!==cap.runId||m.epoch!==cap.epoch||m.assetSha!==cap.assetSha||m.token!==cap.token||JSON.stringify(m.ref)!==JSON.stringify(cap.ref)||!['current','pause','resume'].includes(m.operation))throw Error('P7_FIXTURE_SCOPE');if(m.operation==='pause'){await identity();sameProcess();process.kill(keeper.pid,'SIGSTOP');paused=true}else if(m.operation==='resume'){if(!paused)throw Error('P7_FIXTURE_NOT_PAUSED');sameProcess();process.kill(keeper.pid,'SIGCONT');paused=false;await new Promise(resolve=>setTimeout(resolve,100))}const observed=await inspectProjectKeeper(keeper);if(observed.current&&observed.status.startIdentity!==first.status.startIdentity)throw Error('P7_FIXTURE_IDENTITY_LOST');socket.end(JSON.stringify({runId:cap.runId,epoch:cap.epoch,assetSha:cap.assetSha,...observed})+'\n')}catch(error){socket.end(JSON.stringify({error:String(error)})+'\n')}})})})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});chmodSync(socketPath,0o600)
  const close=async()=>{if(closed)return;closed=true;clearTimeout(expiry);await queue;if(paused){sameProcess();process.kill(keeper.pid,'SIGCONT');paused=false;await new Promise(resolve=>setTimeout(resolve,100))}try{await identity();sameProcess();process.kill(keeper.pid,'SIGTERM')}finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
  const expiry=setTimeout(()=>{void close().finally(()=>parentPort!.close())},Math.max(1,input.expiresAt-Date.now()));expiry.unref()

parentPort!.postMessage({ready:true})
parentPort!.once('message',()=>{void close().then(()=>{parentPort!.postMessage({closed:true});parentPort!.close()}).catch(error=>{parentPort!.postMessage({error:String(error)});parentPort!.close()})})
