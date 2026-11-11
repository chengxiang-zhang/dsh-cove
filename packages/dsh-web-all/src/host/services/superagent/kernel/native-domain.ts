import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { ActionSpec } from './actions.ts'

const ps = (args: string[]) => execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
const environmentProbe = String.raw`import ctypes,struct,sys,os,json
pid=int(sys.argv[1]);root=sys.argv[2];workspace=sys.argv[3];exe=sys.argv[4]
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
mib=(ctypes.c_int*3)(1,49,pid);size=ctypes.c_size_t(0)
if lib.sysctl(mib,3,None,ctypes.byref(size),None,0) or not 8<=size.value<=2097152: raise RuntimeError('UNOBSERVABLE')
buf=ctypes.create_string_buffer(size.value);allocated=size.value
if lib.sysctl(mib,3,buf,ctypes.byref(size),None,0) or not 8<=size.value<=allocated: raise RuntimeError('UNOBSERVABLE')
raw=buf.raw[:size.value]
if raw[-1]!=0: raise RuntimeError('TRUNCATED')
argc=struct.unpack('i',raw[:4])[0]
if not 1<=argc<=4096: raise RuntimeError('INVALID_ARGC')
end=raw.index(b'\0',4);path=raw[4:end].decode();pos=end+1
if os.path.realpath(path)!=exe: raise RuntimeError('EXECUTABLE_CHANGED')
while pos<len(raw) and raw[pos]==0: pos+=1
for _ in range(argc): pos=raw.index(b'\0',pos)+1
env=[x for x in raw[pos:].split(b'\0') if x]
if not env or any(b'=' not in x or not x.split(b'=',1)[0] for x in env): raise RuntimeError('ENVIRONMENT_UNOBSERVABLE')
values={x.split(b'=',1)[0]:x.split(b'=',1)[1] for x in env}
if b'HOME' not in values or b'PATH' not in values: raise RuntimeError('ENVIRONMENT_INCOMPLETE')
match=any(values.get(k) in [root.encode(),workspace.encode()] for k in [b'CODEX_HOME',b'HOME',b'TMPDIR'])
print(json.dumps({'environmentCount':len(env),'argc':argc,'sameDomain':match}))`
/** Host-only observation of a previously isolated, no-fork Codex domain. No signal is sent. */
export function inspectNativeDomainAbsence(spec: ActionSpec, runtime: { root: string; stateDirectoryVariable: string }, workspaceRoot: string) {
 if (process.platform !== 'darwin' || spec.processPolicy !== 'single' || runtime.stateDirectoryVariable !== 'CODEX_HOME' || realpathSync(runtime.root) !== runtime.root || realpathSync(workspaceRoot) !== workspaceRoot) throw Error('NATIVE_DOMAIN_SCOPE_REQUIRED')
 // This recovery is restricted to the same fixed no-builtin native engine launch.
 const disabled = ['shell_tool','code_mode_host','apps','plugins','remote_plugin','multi_agent','browser_use','computer_use','in_app_browser']
 if (!disabled.every(name => spec.args.some((value,index) => value === '--disable' && spec.args[index+1] === name)) || spec.args.at(-2) !== 'app-server' || spec.args.at(-1) !== '--stdio') throw Error('NATIVE_DOMAIN_RESTRICTED_LAUNCH_REQUIRED')
 const executable = realpathSync(spec.executable), uid = process.getuid!()
 const census = () => ps(['-axo','pid=,uid=,comm=']).trim().split('\n').map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
  if (!match) throw Error('NATIVE_DOMAIN_CENSUS_INCOMPLETE')
  return { pid: Number(match[1]), uid: Number(match[2]), executable: match[3]!.trim() }
 }).filter(row => row.uid === uid)
 const matching = (rows: ReturnType<typeof census>) => rows.filter(row => { try { return realpathSync(row.executable) === executable } catch { if (row.executable === executable) throw Error('NATIVE_DOMAIN_CENSUS_INCOMPLETE'); return false } })
 const before = census(), candidates = matching(before), observed: { pid: number; startIdentity: string }[] = []
 for (const candidate of candidates) {
  const startIdentity = ps(['-p',String(candidate.pid),'-o','lstart=']).trim()
  const environment = JSON.parse(execFileSync('/usr/bin/python3',['-c',environmentProbe,String(candidate.pid),runtime.root,workspaceRoot,executable],{encoding:'utf8',timeout:5000,maxBuffer:4096})) as {environmentCount:number;argc:number;sameDomain:boolean}
  const cwd = execFileSync('/usr/sbin/lsof',['-a','-p',String(candidate.pid),'-d','cwd','-Fn'],{encoding:'utf8',timeout:5000,maxBuffer:65536}).split('\n').find(line=>line.startsWith('n'))?.slice(1)
  if (!startIdentity || !Number.isSafeInteger(environment.environmentCount) || environment.environmentCount < 1 || !Number.isSafeInteger(environment.argc) || typeof environment.sameDomain !== 'boolean' || !cwd) throw Error('NATIVE_DOMAIN_CENSUS_INCOMPLETE')
  if (environment.sameDomain || cwd === workspaceRoot || cwd === runtime.root) throw Error('NATIVE_DOMAIN_STILL_PRESENT')
  if (ps(['-p',String(candidate.pid),'-o','lstart=']).trim() !== startIdentity) throw Error('NATIVE_DOMAIN_CENSUS_CHANGED')
  observed.push({pid:candidate.pid,startIdentity})
 }
 const after = matching(census())
 if (JSON.stringify(candidates.map(x=>x.pid).sort()) !== JSON.stringify(after.map(x=>x.pid).sort())) throw Error('NATIVE_DOMAIN_CENSUS_CHANGED')
 return { observedAt: Date.now(), uid, executable, runtimeRoot: runtime.root, workspaceRoot, processPolicy: 'single', inspected: observed, sameUidProcessCount: before.length, basis: 'Complete same-UID census; every matching executable inspected for the exact isolated environment and cwd; no matching domain present; no signal; historical process outcome remains unknown' }
}
