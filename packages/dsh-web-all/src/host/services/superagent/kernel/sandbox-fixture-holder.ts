/** Static trusted worker program. workerData contains only a bounded capacity. */
export const fixtureHolderSource = String.raw`
'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {TCP,constants}=process.binding('tcp_wrap');
const capacity=workerData.capacity;
if(!Number.isSafeInteger(capacity)||capacity<1||capacity>256)throw Error('FIXTURE_POOL_LIMIT');
const handles=[],slots=[];
function bind(family,port){const h=new TCP(constants.SERVER);handles.push(h);const code=family===4?h.bind('127.0.0.1',port):h.bind6('::1',port,1);if(code!==0||h.listen(128)!==0)throw Error('FIXTURE_HOLDER_BIND');return h;}
try{
 for(let i=0;i<capacity;i++){const v4=bind(4,0),address={};if(v4.getsockname(address)!==0)throw Error('FIXTURE_HOLDER_ADDRESS');const v6=bind(6,address.port);slots.push({port:address.port,ipv4:v4.fd,ipv6:v6.fd});}
 parentPort.postMessage({slots});
 // No accept callback can run: the trusted holder never pumps its event loop.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
}catch(e){for(const h of handles)h.close();throw e;}
`
