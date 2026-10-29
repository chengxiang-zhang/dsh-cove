/**
 * Index boot scripts and wire constants of the remote-access domain.
 *
 * The deployment's canonical entry (browser -> reverse proxy -> loopback
 * `dsh web`) is a plain-HTTP origin. Two browser facts follow, and both are
 * fixed here for every entry, whether or not the optional server-mode gateway
 * is mounted:
 *
 * 1. `crypto.randomUUID` does not exist outside a secure context. The DSH
 *    client mints RPC ids with it, so the polyfill is injected into every
 *    served index document (issue #1024).
 * 2. `navigator.clipboard` does not exist either, because the Clipboard API is
 *    secure-context gated. Upstream DSH copy affordances call
 *    `navigator.clipboard.writeText` without a fallback, so a copy button
 *    throws on a remote page while working on the loopback page. The shim backs
 *    `writeText` with the legacy `document.execCommand('copy')` path and never
 *    replaces a real clipboard object.
 *
 * Host ownership is per request instead of a static row: the index document
 * points at {@link HOST_ACCESS_BOOT_PATH} with a parser-blocking
 * `<script src>`, whose handler decides from the request Host whether this page
 * may claim the Host (`__DSH_TRANSPORT__.ownsHost`). Without the claim the DSH
 * client keeps the whole settings plane in a process-local memory store and
 * renders Settings -> Models as "settings are unavailable in this browser",
 * while the provider directory, the account page and the config-file entry all
 * stay empty.
 * @module dsh-web-all/host/services/remote-access/boot-scripts
 */

/**
 * Parser-blocking boot script path; the handler decides per request.
 * Re-exported from `core/remote-access/paths.ts`, the single home the browser
 * half reads too.
 */
export {
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_MARKER_COOKIE,
  HOST_ACCESS_MARKER_MAX_AGE_SECONDS,
  HOST_ACCESS_MARKER_VALUE,
  HOST_ACCESS_SESSION_PATH,
} from '../../../core/remote-access/paths.ts'

/**
 * `crypto.randomUUID` polyfill for non-secure contexts. Kept byte-compatible
 * with the script the server-mode gateway used to inject, so the two renderers
 * cannot drift.
 */
export const UUID_POLYFILL_SCRIPT = [
  '(function(){',
  'var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:self;',
  'if(typeof g.crypto==="undefined"){g.crypto={};}',
  'if(typeof g.crypto.randomUUID!=="function"){',
  'g.crypto.randomUUID=function(){',
  'var a=new Uint8Array(16);',
  'if(g.crypto.getRandomValues){g.crypto.getRandomValues(a);}',
  'else{for(var j=0;j<16;j++){a[j]=Math.random()*256|0;}}',
  'a[6]=(a[6]&0x0f)|0x40;',
  'a[8]=(a[8]&0x3f)|0x80;',
  'var h="",x="0123456789abcdef";',
  'for(var i=0;i<16;i++){h+=x[a[i]>>4]+x[a[i]&0x0f];',
  'if(i===3||i===5||i===7||i===9)h+="-";}',
  'return h;',
  '};',
  '}',
  '})();',
].join('')

/**
 * `navigator.clipboard` shim for non-secure contexts. Only installed when the
 * platform exposes no clipboard at all, so a secure-context page keeps the real
 * API. `readText` cannot be polyfilled from a page (the paste event is the only
 * read path), so it rejects instead of throwing synchronously; callers that
 * already fall back on rejection keep working.
 */
export const CLIPBOARD_SHIM_SCRIPT = [
  '(function(){',
  'try{',
  'var n=typeof navigator!=="undefined"?navigator:undefined;',
  'if(n===undefined||n.clipboard!==undefined)return;',
  'var writeText=function(text){return new Promise(function(resolve,reject){',
  'try{',
  'var area=document.createElement("textarea");',
  'area.value=String(text);',
  'area.setAttribute("readonly","");',
  'area.style.position="fixed";',
  'area.style.top="-1000px";',
  'document.body.appendChild(area);',
  'area.select();',
  'var ok=document.execCommand("copy");',
  'document.body.removeChild(area);',
  'if(ok){resolve();}else{reject(new Error("clipboard write is unavailable on this origin"));}',
  '}catch(e){reject(e);}',
  '});};',
  'var readText=function(){return Promise.reject(new Error("clipboard read is unavailable on this origin"));};',
  'var shim={writeText:writeText,readText:readText};',
  'try{Object.defineProperty(Navigator.prototype,"clipboard",{get:function(){return shim;},configurable:true});}',
  'catch(e){try{Object.defineProperty(n,"clipboard",{value:shim,configurable:true});}catch(e2){}}',
  '}catch(e){}',
  '})();',
].join('')

/**
 * Boot script body served for one admission decision.
 * @param admitted - whether the requesting Host passed the host access fence.
 * @returns an inline script claiming Host ownership, or a no-op script.
 */
export function hostAccessBootScript(admitted: boolean): string {
  if (!admitted) return '/* web-all: this host is not a declared browser entry; the page keeps the memory settings plane */\n'
  return [
    '(function(){',
    'try{',
    'var t=globalThis.__DSH_TRANSPORT__||{};',
    't.ownsHost=true;',
    'globalThis.__DSH_TRANSPORT__=t;',
    '}catch(e){}',
    '})();',
  ].join('')
}