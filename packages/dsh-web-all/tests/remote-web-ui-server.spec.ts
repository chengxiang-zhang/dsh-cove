import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountConflictError, AccountStore, hashPassword, verifyPassword } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { Config } from '../src/host/services/remote-web-ui/server.ts'
import { SessionStore } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { isControlPath, userRoleAllows } from '../src/host/services/remote-web-ui/server-mode/roles.ts'
import { SERVER_BOOT_SCRIPT } from '../src/host/services/remote-web-ui/server-mode/server-boot.ts'
import { isLoopbackAdmin } from '../src/host/services/remote-web-ui/server-mode/fence.ts'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
async function root(){const path=await mkdtemp(join(tmpdir(),'remote-full-'));roots.push(path);return path}

describe('full remote server persistence and access',()=>{
 it('stores only scrypt verifiers and keeps account file 0600',async()=>{const dir=await root();const file=join(dir,'accounts.json');const store=new AccountStore(file,{now:()=>10,randomSalt:()=>Buffer.alloc(16,7)});expect(store.create('admin','long-password','admin')).toBeTruthy();const raw=await readFile(file,'utf8');expect(raw).not.toContain('long-password');expect(raw).toContain('scrypt$');expect((await stat(file)).mode&0o777).toBe(0o600);expect(store.verify('admin','long-password')).toBe(true);expect(store.roleOf('admin')).toBe('admin');expect(verifyPassword('long-password',hashPassword('long-password',Buffer.alloc(16,7)))).toBe(true)})
 it('persists sessions across restarts and expires idle credentials',async()=>{const dir=await root();const file=join(dir,'sessions.json');let now=100;const first=new SessionStore(file,{now:()=>now,randomId:()=> 'a'.repeat(64)},{idleExpireMs:20,maxAgeMs:100});first.issue('admin','admin');const second=new SessionStore(file,{now:()=>now,randomId:()=> 'b'.repeat(64)},{idleExpireMs:20,maxAgeMs:100});expect(second.touch('a'.repeat(64))?.username).toBe('admin');now=121;expect(second.touch('a'.repeat(64))).toBeUndefined();expect((await stat(file)).mode&0o777).toBe(0o600)})
 it('leaves the Host ownership claim to the fenced per-request row',()=>{
   // 这一行会被注入到每一次首页响应（与请求 Host 无关），所以它不能声明 ownsHost：
   // 特权声明只能来自逐请求过围栏的那一行（remote-access 的 boot.js）。
   // 回归：无条件声明让未声明 authority 的页面也拿到设置面，并且静默压掉了那一行的
   // no-op 决定（客户端只看 __DSH_TRANSPORT__.ownsHost 这一个字段）。
   expect(SERVER_BOOT_SCRIPT).not.toContain('ownsHost');
   expect(SERVER_BOOT_SCRIPT).not.toContain('__DSH_TRANSPORT__');
   // 非回环页面的登录重定向仍然保留。
   const guard = SERVER_BOOT_SCRIPT.indexOf('if (isLoopback) return;');
   expect(guard).toBeGreaterThan(0);
   expect(SERVER_BOOT_SCRIPT.indexOf('/api/gateway/session')).toBeGreaterThan(guard);
   expect(SERVER_BOOT_SCRIPT).toContain('/login?next=');
 })
 it('lets user roles reach the native surface but never the family control plane',()=>{expect(userRoleAllows('/api/session/list')).toBe(true);expect(userRoleAllows('/api/settings/describe')).toBe(true);expect(userRoleAllows('/api/settings/mutate')).toBe(true);expect(userRoleAllows('/api/pluginManager/setPluginEnabled')).toBe(true);expect(userRoleAllows('/api/llm/discoverModels')).toBe(true);expect(userRoleAllows('/api/pair')).toBe(false);expect(userRoleAllows('/api/pair/status')).toBe(false);// The self-update surface is gone, so its prefix is no longer a control path.
expect(isControlPath('/api/update/run')).toBe(false);expect(isControlPath('/api/pluginManager/listPlugins')).toBe(false)})
 it('forces the first account to admin and preserves an enabled administrator',async()=>{const dir=await root();const store=new AccountStore(join(dir,'accounts.json'),{now:()=>10,randomSalt:()=>Buffer.alloc(16,5)});expect(store.create('first','long-password','user').role).toBe('admin');expect(()=>store.setRole('first','user')).toThrow(AccountConflictError);expect(()=>store.setEnabled('first',false)).toThrow(AccountConflictError);expect(()=>store.remove('first')).toThrow(AccountConflictError);store.create('second','long-password','admin');expect(store.setRole('first','user')).toBe(true);expect(()=>store.setEnabled('second',false)).toThrow(AccountConflictError)})
 it('marks only bootstrap password secret and keeps TLS key path readable',()=>{expect(Config.dict.bootstrapAdminPassword.meta.role).toBe('secret');expect(Config.dict.serverTlsKey.meta.role).toBeUndefined()})
})

/**
 * The loopback admin gate (account management) must carry the same-origin
 * markers the deployment contract requires on every privileged surface.
 *
 * Regression: it used to test only the socket and the Host header, and a web
 * page satisfies both by itself. A cross-site simple request (no preflight) to
 * http://127.0.0.1:<port> arrives on a loopback socket with a loopback Host, so
 * any page a browser can be made to fetch could have created an admin account or
 * taken over one whose username was known.
 */
describe('loopback admin gate',()=>{
 const req=(headers:Record<string,string>,remoteAddress='127.0.0.1')=>({headers,socket:{remoteAddress}}) as unknown as IncomingMessage
 it('refuses a loopback request carrying cross-site browser markers',()=>{
   expect(isLoopbackAdmin(req({host:'127.0.0.1:3080','sec-fetch-site':'cross-site',origin:'https://evil.test'}))).toBe(false)
   expect(isLoopbackAdmin(req({host:'127.0.0.1:3080',origin:'https://evil.test'}))).toBe(false)
 })
 it('still admits the local browser page and marker-less local tooling',()=>{
   expect(isLoopbackAdmin(req({host:'127.0.0.1:3080','sec-fetch-site':'same-origin',origin:'http://127.0.0.1:3080'}))).toBe(true)
   // curl and other native local clients send no markers; absence is not hostility.
   expect(isLoopbackAdmin(req({host:'127.0.0.1:3080'}))).toBe(true)
 })
 it('refuses a non-loopback socket whatever the Host header claims',()=>{
   expect(isLoopbackAdmin(req({host:'127.0.0.1:3080'},'10.0.0.5'))).toBe(false)
 })
})
