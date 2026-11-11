/** Fixed API replay adapter. Assertions are selected explicitly by independent QA;
 * the collector also retains the complete native API result on stderr. */
export const CODEX_REPLAY = String.raw`
import {createCodexAdapter} from './packages/dsh-web-all/src/host/services/external-session/providers/codex.ts';
export async function inspect(input) {
 const fields=['status','result','providerSessionId','errorTag'];
 if(!Array.isArray(input.steps)||!input.steps.length||!Array.isArray(input.fields)||!input.fields.length||input.fields.some(f=>!fields.includes(f)))throw Error('REPLAY_ASSERTION_FIELDS_REQUIRED');
 let previous; const projected=[];
 for(const step of input.steps){
  const stream=text=>({readFrom:()=>({text,nextOffset:Buffer.byteLength(text),lossy:false})});
  const adapter=createCodexAdapter({process:{resolveExecutable:async()=>'/captured-cli-not-launched',spawn:()=>({done:Promise.resolve({exitCode:step.exitCode,signal:null}),collected:{stdout:stream(step.stdout),stderr:stream(step.stderr)},terminate(){throw Error('unexpected cancellation')},waitForExit:async()=>true})},readTextFile:async()=>null,homeDir:process.cwd(),now:Date.now,cancelGraceMs:1000},{bin:'codex'});
  const providerSessionId=step.continuePrevious?previous:step.providerSessionId;
  if(step.continuePrevious&&!previous)throw Error('PREVIOUS_SESSION_REQUIRED');
  const outcome=await adapter.runTurn({prompt:'independent captured API replay',cwd:process.cwd(),...(providerSessionId?{providerSessionId}:{})});
  process.stderr.write(JSON.stringify({kind:'actual-runTurn-result',outcome})+'\n');
  previous=outcome.providerSessionId;
  const normalized={status:outcome.status,result:outcome.result??null,providerSessionId:outcome.providerSessionId??null,errorTag:outcome.error?.code??null};
  projected.push(input.fields.map(field=>normalized[field]));
 }
 return projected;
}
`
