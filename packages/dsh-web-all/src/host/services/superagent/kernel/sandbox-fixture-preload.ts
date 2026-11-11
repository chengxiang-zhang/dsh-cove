/** Fixed compatibility code executed only inside the candidate domain; never an authority. */
export const fixturePreloadVersion = 'node-high-fd-fixtures-v1'
export const fixturePreloadSource = String.raw`
'use strict';
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),mod=require('node:module');
const fds=JSON.parse(process.env.DSH_FIXTURE_FDS||'null'),socketPath=process.env.DSH_FIXTURE_SOCKET;
if(!Array.isArray(fds)||fds.length<1||fds.length>256||!fds.every((fd,i)=>fd===64+i)||typeof socketPath!=='string')throw Error('FIXTURE_PRELOAD_CONFIG');
const toolRoot=require('node:path').dirname(process.execPath);
const tool=file=>['/usr/bin/git','/usr/bin/python3'].includes(file)?require('node:path').join(toolRoot,require('node:path').basename(file)):file;
const gitEnv=(file,env)=>{
 let value=(file==='/usr/bin/git'||file===require('node:path').join(toolRoot,'git'))?{...(env??process.env),PATH:toolRoot+':/usr/bin:/bin',GIT_EXEC_PATH:toolRoot}:{...(env??process.env)};
 for(const key of ['HOME','TMPDIR'])if(value[key]===undefined&&process.env[key]!==undefined)value[key]=process.env[key];
 for(const key of ['DSH_FIXTURE_FDS','DSH_FIXTURE_SOCKET','NODE_OPTIONS','OPENSSL_CONF','CURL_SSL_BACKEND'])if(process.env[key]!==undefined)value[key]=process.env[key];
 return value;
};
const available=new Set(fds.filter(fd=>{try{return fs.fstatSync(fd).isSocket()}catch{return false}}));
function stdio(value){let s=value??'pipe';if(typeof s==='string')s=s==='inherit'?[0,1,2]:[s,s,s];else if(Array.isArray(s))s=[...s];else throw Error('FIXTURE_STDIO_SHAPE');
 for(const fd of fds){if(!available.has(fd))continue;if(s[fd]!==undefined&&s[fd]!=='ignore'&&s[fd]!==fd)throw Error('FIXTURE_FD_COLLISION');while(s.length<=fd)s.push('ignore');s[fd]=fd;}return s;}
const spawn=cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn=function(o){const env=gitEnv(o.file,o.envPairs?Object.fromEntries(o.envPairs.map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)]})):undefined);return spawn.call(this,{...o,...(env?{envPairs:Object.entries(env).map(([k,v])=>k+'='+v)}:{}),file:tool(o.file),args:o.args?.map((a,i)=>i===0?tool(a):a),stdio:stdio(o.stdio)});};
const spawnSync=cp.spawnSync,execFileSync=cp.execFileSync,execSync=cp.execSync;
cp.spawnSync=function(file,args,options){if(!Array.isArray(args)){options=args;args=[];}return spawnSync.call(this,tool(file),args,{...options,env:gitEnv(file,options?.env),stdio:stdio(options?.stdio)});};
cp.execFileSync=function(file,args,options){if(!Array.isArray(args)){options=args;args=[];}return execFileSync.call(this,tool(file),args,{...options,env:gitEnv(file,options?.env),stdio:stdio(options?.stdio)});};
cp.execSync=function(command,options){return execSync.call(this,command,{...options,env:gitEnv('/bin/sh',options?.env),stdio:stdio(options?.stdio)});};
mod.syncBuiltinESMExports();
const listen=net.Server.prototype.listen,close=net.Server.prototype.close,pending=new WeakMap();
net.Server.prototype.listen=function(...args){
 if(args[0]!==0||args[1]!=='127.0.0.1')return listen.apply(this,args);
 if(this.listening||pending.has(this))throw Error('ERR_SERVER_ALREADY_LISTEN');
 const server=this,channel=net.connect(socketPath),state={channel,cancelled:false,index:undefined};pending.set(server,state);
 let buffer=Buffer.alloc(0),allocated=false;
 const fail=e=>{if(state.cancelled)return;state.cancelled=true;pending.delete(server);channel.destroy();server.emit('error',e);};
 const timeout=setTimeout(()=>fail(Error('FIXTURE_ALLOCATOR_TIMEOUT')),1000);timeout.unref();
 channel.once('connect',()=>channel.write('{"version":1,"type":"allocate"}\n'));
 channel.on('error',fail);
 channel.on('data',b=>{try{buffer=Buffer.concat([buffer,b]);if(buffer.length>1024)throw Error('FIXTURE_ALLOCATOR_FRAME');const n=buffer.indexOf(10);if(n<0)return;const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,n)));buffer=buffer.subarray(n+1);
  if(allocated){if(m.type!=='released'||m.index!==state.index)throw Error('FIXTURE_ALLOCATOR_REPLY');channel.end();return;}
  if(m.type==='refused')throw Error(m.reason);if(m.version!==1||m.type!=='allocated'||!Number.isSafeInteger(m.index)||m.index<0||m.index>=fds.length)throw Error('FIXTURE_ALLOCATOR_REPLY');
  if(!available.has(fds[m.index]))throw Error('FIXTURE_FD_UNAVAILABLE');available.delete(fds[m.index]);allocated=true;state.index=m.index;clearTimeout(timeout);if(state.cancelled){channel.destroy();return;}
  server.once('close',()=>{pending.delete(server);channel.ref();channel.write(JSON.stringify({version:1,type:'release',index:m.index})+'\n');});
  listen.call(server,{fd:fds[m.index]},()=>{channel.unref();if(typeof args.at(-1)==='function')args.at(-1).call(server);});
 }catch(e){fail(e);}});
 channel.once('close',()=>{clearTimeout(timeout);if(!allocated&&!state.cancelled)fail(Error('FIXTURE_ALLOCATOR_DISCONNECTED'));});
 return this;
};
net.Server.prototype.close=function(...args){const state=pending.get(this);if(state&&!this.listening){state.cancelled=true;state.channel.destroy();pending.delete(this);}return close.apply(this,args);};
`
