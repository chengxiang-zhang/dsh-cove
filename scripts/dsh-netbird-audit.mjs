#!/usr/bin/env node
/**
 * NetBird DSH fleet audit: every inventory entry is probed over the overlay and
 * fails when the machine is not safely reachable.
 *
 *   1. DNS: `dsh.<machine>.netbird` resolves to the inventory NetBird IPv4.
 *   2. Entry: the unauthenticated document matches the machine's declared
 *      `authMode`. `password` must redirect to `/login`; `network-gate` must
 *      answer the DSH document, because the overlay gate is its authenticator.
 *   3. Host-access posture: `GET /api/dsh-access/session` answers
 *      `authority.declared === true`, the evidence for a correct
 *      `--trusted-host` on the running process.
 *   4. Fence: `GET /worktree/tree` without a session must not leak. An
 *      undeclared Host must never read it, and on a `password` machine a
 *      declared Host must not read it either; `network-gate` admits the
 *      declared Host by design, which is exactly why it needs probe 5.
 *   5. Gate (`--verify-gate`, read-only over SSH): no non-overlay local address
 *      may serve the DSH posture route, so the HTTP entry is an overlay-only
 *      surface. A `network-gate` machine fails while the gate is unverified: no
 *      password may be dropped before the gate is proven.
 *   6. Request body: a POST whose body exceeds the proxy's in-memory request
 *      buffer must not answer 500. The proxy spools such a body to a worker temp
 *      path, so a machine whose temp paths are unreachable for its worker user (a
 *      path under a user home that the worker cannot traverse) fails every large
 *      send at the edge while small requests keep working.
 *   7. Directory picker: the composed picker interaction must be the one a
 *      remote browser can drive. `directoryPicker/list` is the browse
 *      capability's verb, so a listing proves the in-app browser, while the
 *      seam's refusal names the interaction the machine composed instead — the
 *      native OS chooser opens on the unattended host display and hangs the
 *      peer's request until the proxy gives up (HTTP 504).
 *
 * A machine without `--verify-gate` still audits probes 1-4, 6 and 7; the gate
 * result is reported as not-verified. Probe 7 reports `picker-not-verifiable` on
 * a `password` machine, whose entry answers before the picker is reached.
 */
import { readFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { request } from 'node:http'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const INVENTORY = new URL('../tools/dsh-netbird/machines.json', import.meta.url)
const DEFAULT_TIMEOUT_MS = 5_000
const POSTURE_PATH = '/api/dsh-access/session'
const POSTURE_TIMEOUT_MS = 3_000
const FENCE_PATH = '/worktree/tree'
const FENCE_TIMEOUT_MS = 3_000
/**
 * The browse capability's listing verb. A machine composing the native
 * interaction answers it with the seam's own `directory-picker/unavailable`
 * refusal instead of a listing, which is the deployment defect this probe
 * exists for. Reaching the verb needs no session on a `network-gate` machine.
 */
const PICKER_PATH = '/api/directoryPicker/list'
const PICKER_TIMEOUT_MS = 3_000
/**
 * Endpoint no deployment serves, used only to make nginx read a complete
 * request body. Its answer is irrelevant; only a 500 at the edge is not.
 */
const BODY_PROBE_PATH = '/api/dsh-access/request-body-probe'
/**
 * Body size for the request-body probe. A proxy buffers a request body in
 * memory up to its own limit (nginx: `client_body_buffer_size`, a small multiple
 * of the page size, 512 KiB where the BT-panel nginx overrides it) and spools
 * anything larger to a worker temp path, which is the deployment property this
 * probe decides. This body exceeds every buffer configured in the inventory.
 */
export const BODY_PROBE_BYTES = 1024 * 1024
/** Human label for the probe size, used in the report and in the JSDoc above. */
export const BODY_PROBE_LABEL = BODY_PROBE_BYTES % (1024 * 1024) === 0
  ? `${BODY_PROBE_BYTES / (1024 * 1024)} MiB`
  : `${Math.round(BODY_PROBE_BYTES / 1024)} KiB`
const SSH_TIMEOUT_MS = 20_000
/** Host no deployment can declare; the fence must refuse it. */
const UNDECLARED_HOST = 'dsh-audit.invalid'

/** Authentication modes an inventory entry may declare. */
export const AUTH_MODES = ['password', 'network-gate']
const DEFAULT_AUTH_MODE = 'password'

/**
 * Read one machine's declared authentication mode. An unknown value is invalid
 * rather than silently treated as the default, so a typo cannot pass the audit.
 */
export function authModeOf(machine) {
  const mode = machine?.authMode
  if (mode === undefined || mode === null) return DEFAULT_AUTH_MODE
  return AUTH_MODES.includes(mode) ? mode : 'invalid'
}

/** Whether a redirect target is the DSH login page, relative or absolute. */
function isLoginLocation(location) {
  if (location.startsWith('/login')) return true
  try {
    return new URL(location).pathname.startsWith('/login')
  } catch {
    return false
  }
}

export function classifyProbe({ status, location = '', body = '', contentType = '' }) {
  if (status === 302 && isLoginLocation(location)) return { ok: true, state: 'login-required' }
  if (status === 200 && contentType.includes('text/html') && /DeepSeek Harness|<title>[^<]*DSH|<base href=/i.test(body)) {
    return { ok: true, state: 'authenticated-app' }
  }
  if (/dsh web authentication required/i.test(body)) return { ok: false, state: 'integrated-auth-not-mounted' }
  if (status === 502) return { ok: false, state: 'upstream-unavailable' }
  return { ok: false, state: `unexpected-http-${status}` }
}

/**
 * Judge the unauthenticated entry against the declared authentication mode.
 *
 *   - `password`: the entry must be the `/login` redirect. An unauthenticated
 *     DSH document means the browser wall is off on a machine that did not
 *     declare the overlay gate.
 *   - `network-gate`: the entry must be the DSH document. A `/login` redirect
 *     means the machine still authenticates per request, i.e. the declaration
 *     and the deployment disagree.
 */
export function classifyAuthMode({ state, authMode }) {
  if (authMode === 'invalid') return { ok: false, state: 'auth-mode-invalid' }
  if (authMode === 'network-gate') {
    if (state === 'authenticated-app') return { ok: true, state: 'network-gate-app' }
    if (state === 'login-required') return { ok: false, state: 'auth-mode-mismatch' }
    return { ok: false, state }
  }
  if (state === 'login-required') return { ok: true, state: 'login-required' }
  if (state === 'authenticated-app') return { ok: false, state: 'no-browser-auth-exposed' }
  return { ok: false, state }
}

/**
 * Classify `GET /api/dsh-access/session`, the credential-free host-access
 * posture probe. The route reports the deployment's own admission decision:
 *
 *   { authority: { host, loopback, declared }, session, owners }
 *
 * `authority.declared` is true when the request Host is loopback or matches a
 * `--trusted-host` authority; it needs no browser session, so the audit can
 * read it unauthenticated. `owners` additionally requires a session on a
 * deployment that is not in noBrowserAuth mode, so it must never decide the
 * posture: a `declared: true` authority with `owners: false` is still trusted.
 *
 * Mapping (order is deliberate):
 *   - 404 (any body)                            -> access-probe-missing
 *   - non-JSON content type (HTML error page)   -> access-probe-missing
 *   - JSON content type, unparsable body        -> access-probe-malformed
 *   - 403 with fence error `forbidden: loopback-only` or `forbidden`
 *                                               -> authority-untrusted
 *     (a fence refusal for the canonical Host is exactly the missing-flag
 *      signature: an undeclared authority is refused before any session check)
 *   - 200 with `authority.declared === true`    -> authority-trusted
 *   - 200 without `authority.declared === true` -> authority-untrusted
 *   - any other status                          -> unexpected-http-<status>
 */
export function classifyAccessProbe({ status, contentType = '', body = '' }) {
  if (status === 404) return { ok: false, state: 'access-probe-missing' }
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, state: 'access-probe-missing' }
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, state: 'access-probe-malformed' }
  }
  if (status === 403) {
    if (parsed?.error === 'forbidden: loopback-only' || parsed?.error === 'forbidden') {
      return { ok: false, state: 'authority-untrusted' }
    }
    return { ok: false, state: 'unexpected-http-403' }
  }
  if (status === 200) {
    return parsed?.authority?.declared === true
      ? { ok: true, state: 'authority-trusted' }
      : { ok: false, state: 'authority-untrusted' }
  }
  return { ok: false, state: `unexpected-http-${status}` }
}

/**
 * Classify one `GET /worktree/tree` probe of the shared host access fence.
 *
 * `hostKind` is `declared` for the canonical authority and `undeclared` for a
 * Host the deployment never declared. A 200 on an undeclared Host is a leak on
 * every machine; a 200 on the declared Host is a leak on a `password` machine
 * and the documented admission on a `network-gate` machine. Any refusal
 * (403 fence, 401 auth, 302 login, 404 nginx) satisfies the invariant.
 */
export function classifyFenceProbe({ status, hostKind, authMode }) {
  if (status === null || status === undefined) return { ok: false, state: 'connection-failed' }
  if (hostKind === 'undeclared') {
    if (status === 200) return { ok: false, state: 'undeclared-host-leak' }
    if ([302, 401, 403, 404].includes(status)) return { ok: true, state: 'undeclared-host-refused' }
    return { ok: false, state: `unexpected-http-${status}` }
  }
  if (status === 200) {
    return authMode === 'network-gate'
      ? { ok: true, state: 'sessionless-read-admitted' }
      : { ok: false, state: 'session-fence-missing' }
  }
  if ([302, 401, 403, 404].includes(status)) {
    return authMode === 'network-gate'
      ? { ok: false, state: 'gate-refused-sessionless-read' }
      : { ok: true, state: 'session-fence-enforced' }
  }
  return { ok: false, state: `unexpected-http-${status}` }
}

/**
 * Judge one large-request-body probe of the edge.
 *
 * A 500 is the signature of an unusable worker temp path: nginx answers with its
 * own error page, never reaching DSH, because it cannot spool the body. Every
 * other answer proves the body was accepted at the edge: 404 for this
 * non-existent route, 302 to `/login` or 403 from the fence on a guarded
 * machine, or any application-level reply.
 */
export function classifyBodyProbe({ status, error }) {
  if (error !== undefined) {
    return { ok: false, state: 'connection-failed', status: null, detail: String(error?.message ?? error) }
  }
  if (status === null || status === undefined) {
    return { ok: false, state: 'connection-failed', status: null, detail: 'no response' }
  }
  if (status === 500) return { ok: false, state: 'request-body-temp-unusable', status }
  return { ok: true, state: `request-body-accepted-${status}`, status }
}

/**
 * Judge one `POST /api/directoryPicker/list` probe of the composed picker.
 *
 * The route answers with the Typert Remote envelope, so the picker's own verdict
 * rides in `result`: `ok: true` is a directory listing, the interaction a remote
 * browser drives; `directory-picker/unavailable` names the capability the
 * machine composed instead. `native` is the failure this probe exists for — its
 * OS chooser opens on the unattended host display and the peer's request hangs
 * until the proxy gives up (HTTP 504).
 *
 * A `password` machine answers before the picker is reached (401, 302 login or a
 * 403 fence refusal), so its interaction cannot be read from outside without a
 * session and the probe reports `picker-not-verifiable` rather than guessing.
 */
export function classifyPickerProbe({ status, body = '', authMode }) {
  if (status === null || status === undefined) {
    return { ok: false, state: 'picker-probe-failed', detail: 'no response' }
  }
  if (status !== 200) {
    if (authMode === 'password' && [302, 401, 403].includes(status)) {
      return { ok: true, state: 'picker-not-verifiable', detail: `HTTP ${status} before the picker` }
    }
    return { ok: false, state: `unexpected-http-${status}` }
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, state: 'picker-probe-malformed', detail: 'response is not the picker envelope' }
  }
  const result = parsed?.result
  if (result?.ok === true) return { ok: true, state: 'picker-browse' }
  const code = result?.error?.code
  const capability = result?.error?.details?.capability
  if (code === 'directory-picker/unavailable') {
    if (capability === 'native') {
      return {
        ok: false,
        state: 'picker-native-unreachable',
        detail: 'composed picker serves "native"; a peer browser has no OS chooser',
      }
    }
    return {
      ok: false,
      state: 'picker-capability-missing',
      detail: `composed picker serves ${capability === undefined ? 'no known capability' : `"${capability}"`}`,
    }
  }
  return { ok: false, state: 'picker-probe-refused', detail: code === undefined ? 'no picker result' : String(code) }
}

/**
 * Parse the on-host gate probe. Each line is
 * `address|status|location|content-type|body-head`, the document probe taken on
 * one non-overlay local address. Two sentinel lines are possible:
 * `curl-missing` and `no-local-addresses`.
 */
export function parseGateProbe(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === 'curl-missing' || trimmed === 'no-local-addresses') {
      rows.push({ sentinel: trimmed })
      continue
    }
    const [address, status = '', location = '', contentType = '', ...rest] = trimmed.split('|')
    rows.push({ address, status: Number(status), location, contentType, body: rest.join('|') })
  }
  return rows
}

/**
 * Judge one document probe taken on a non-overlay local address. The address
 * leaks when it serves this machine's DSH entry: the login redirect, the
 * authenticated document, or the integrated-auth page. A refused connection, a
 * placeholder page or another vhost's answer is not a leak. The login path is
 * accepted in both spellings because an off-overlay answer is redirected to the
 * address that was actually connected to.
 */
export function classifyOffOverlay({ status, location = '', contentType = '', body = '' }) {
  const code = Number(status)
  if (!Number.isFinite(code) || code === 0) return { ok: true, state: 'gate-clean' }
  const probe = classifyProbe({ status: code, location, contentType, body })
  if (probe.state === 'login-required' || probe.state === 'authenticated-app' || probe.state === 'integrated-auth-not-mounted') {
    return { ok: false, state: 'gate-leak' }
  }
  return { ok: true, state: 'gate-clean' }
}

/**
 * Classify the on-host gate probe: the deployment is overlay-only when no
 * non-overlay local address serves the DSH entry. A refused or unanswered
 * connection is the expected result there, so only a DSH answer (or a probe
 * that could not run) fails.
 */
export function classifyGateProbe(rows) {
  if (rows.length === 0) return { ok: false, state: 'gate-probe-failed', detail: 'no output' }
  if (rows.some((row) => row.sentinel === 'curl-missing')) {
    return { ok: false, state: 'gate-probe-failed', detail: 'curl unavailable on the target' }
  }
  const serving = rows.filter((row) => row.address !== undefined && !classifyOffOverlay(row).ok)
  if (serving.length > 0) {
    const detail = serving.map((row) => `${row.address} (HTTP ${row.status})`).join(', ')
    return { ok: false, state: 'gate-leak', detail }
  }
  if (rows.some((row) => row.sentinel === 'no-local-addresses')) {
    return { ok: true, state: 'gate-ok', detail: 'no non-overlay local address' }
  }
  return { ok: true, state: 'gate-ok', detail: `${rows.length} non-overlay address(es) clean` }
}

/**
 * Build the read-only command the audit runs on one machine. It walks every
 * local IPv4 that is not loopback and not the NetBird address, requests the
 * document with the canonical Host, and reports the answer. Only that answer
 * decides the gate: an address that answers with the DSH entry is a leak, a
 * refused connection is the deployment being overlay-only.
 *
 * The address list is consumed with `while read` rather than `for ip in $ips`:
 * macOS login shells are zsh, which does not word-split an unquoted expansion,
 * so a bare `for` sees the whole multi-line list as one word and probes nothing.
 */
export function buildGateCommand({ domain, netbirdIp }) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  return [
    'command -v curl >/dev/null 2>&1 || { printf "curl-missing\\n"; exit 0; }',
    `d=${quote(domain)}`,
    `nb=${quote(netbirdIp)}`,
    'rows=$(',
    '  { ifconfig 2>/dev/null | awk \'/inet /{print $2}\'; ip -4 -o addr show scope global 2>/dev/null | awk \'{print $4}\' | cut -d/ -f1; } \\',
    '    | grep -E \'^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$\' | sort -u \\',
    '    | while read -r ip; do',
    '        [ "$ip" = "$nb" ] && continue',
    '        [ "$ip" = "127.0.0.1" ] && continue',
    '        out=$(curl -s -m 3 -w \'\\n%{http_code}|%{redirect_url}|%{content_type}\' -H "Host: $d" "http://$ip/" 2>/dev/null || true)',
    '        meta=$(printf \'%s\' "$out" | tail -n 1)',
    '        body=$(printf \'%s\' "$out" | sed \'$d\' | tr \'\\n\' \' \' | tr \'|\' \'/\' | cut -c1-300)',
    '        printf \'%s|%s|%s\\n\' "$ip" "$meta" "$body"',
    '      done',
    ')',
    '[ -n "$rows" ] || { printf "no-local-addresses\\n"; exit 0; }',
    'printf "%s\\n" "$rows"',
    'exit 0',
  ].join('\n')
}

/** Parse the audit CLI flags. */
export function parseAuditArgs(argv) {
  const timeoutArg = argv.find((arg) => arg.startsWith('--timeout='))
  return {
    timeoutMs: timeoutArg === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutArg.slice('--timeout='.length)),
    skipPosture: argv.includes('--skip-posture'),
    verifyGate: argv.includes('--verify-gate'),
  }
}

/** One-shot HTTP GET that may override the Host header (fetch forbids it). */
function httpGet(url, { host, timeoutMs, accept = '*/*' } = {}) {
  return new Promise((resolve) => {
    const target = new URL(url)
    const headers = host === undefined ? { accept } : { accept, host }
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        location: String(res.headers.location ?? ''),
        contentType: String(res.headers['content-type'] ?? ''),
        body,
      }))
      res.on('error', (error) => resolve({ error }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (error) => resolve({ error }))
    req.end()
  })
}

async function probeDocument(machine, timeoutMs) {
  try {
    const response = await fetch(`http://${machine.domain}/`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.text()
    return {
      status: response.status,
      ...classifyProbe({
        status: response.status,
        location: response.headers.get('location') ?? '',
        contentType: response.headers.get('content-type') ?? '',
        body,
      }),
    }
  } catch (error) {
    return { status: null, ok: false, state: 'connection-failed', detail: error.message }
  }
}

async function probePosture(machine, timeoutMs) {
  try {
    const response = await fetch(`http://${machine.domain}${POSTURE_PATH}`, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, POSTURE_TIMEOUT_MS)),
    })
    const body = await response.text()
    return {
      status: response.status,
      ...classifyAccessProbe({
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
      }),
    }
  } catch (error) {
    return { status: null, ok: false, state: 'connection-failed', detail: error.message }
  }
}

async function probeFence(machine, authMode, timeoutMs) {
  const limit = Math.min(timeoutMs, FENCE_TIMEOUT_MS)
  const [declared, undeclared] = await Promise.all([
    httpGet(`http://${machine.domain}${FENCE_PATH}`, { timeoutMs: limit }),
    httpGet(`http://${machine.domain}${FENCE_PATH}`, { host: UNDECLARED_HOST, timeoutMs: limit }),
  ])
  const declaredResult = classifyFenceProbe({
    status: declared.error === undefined ? declared.status : null,
    hostKind: 'declared',
    authMode,
  })
  const undeclaredResult = classifyFenceProbe({
    status: undeclared.error === undefined ? undeclared.status : null,
    hostKind: 'undeclared',
    authMode,
  })
  return {
    ok: declaredResult.ok && undeclaredResult.ok,
    state: declaredResult.ok ? undeclaredResult.state : declaredResult.state,
    status: declared.error === undefined ? declared.status : null,
    detail: `declared: ${declaredResult.state}, undeclared: ${undeclaredResult.state}`,
    undeclaredState: undeclaredResult.state,
    undeclaredStatus: undeclared.error === undefined ? undeclared.status : null,
  }
}

/**
 * POST one oversized body through the canonical entry and let the edge's own
 * answer decide. The request is deliberately unauthenticated and targets a path
 * no deployment serves, so it changes nothing on the target.
 */
function probeBody(machine, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(`http://${machine.domain}${BODY_PROBE_PATH}`)
    const payload = JSON.stringify({ probe: 'netbird-audit', pad: 'x'.repeat(BODY_PROBE_BYTES) })
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(classifyBodyProbe({ status: res.statusCode ?? 0 })))
      res.on('error', (error) => resolve(classifyBodyProbe({ error })))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (error) => resolve(classifyBodyProbe({ error })))
    req.end(payload)
  })
}

/**
 * POST the browse listing verb through the canonical entry and let the picker's
 * own answer decide. The request is deliberately unauthenticated and read-only:
 * listing the host home changes nothing on the target and never opens a chooser,
 * so a `native` deployment is reported without a dialog ever appearing on the
 * machine's display.
 */
function probePicker(machine, authMode, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(`http://${machine.domain}${PICKER_PATH}`)
    const payload = JSON.stringify({
      type: 'client-request',
      rpcId: 'netbird-audit-picker',
      method: 'directoryPicker/list',
      payload: { args: {} },
    })
    const limit = Math.min(timeoutMs, PICKER_TIMEOUT_MS)
    const req = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: limit,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        resolve({ status, ...classifyPickerProbe({ status, body, authMode }) })
      })
      res.on('error', (error) => resolve({ status: null, ok: false, state: 'picker-probe-failed', detail: String(error?.message ?? error) }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (error) => resolve({ status: null, ok: false, state: 'picker-probe-failed', detail: String(error?.message ?? error) }))
    req.end(payload)
  })
}

async function probeGate(machine, timeoutMs) {
  if (typeof machine.sshAlias !== 'string' || machine.sshAlias === '') {
    return { status: null, ok: false, state: 'gate-probe-unavailable', detail: 'no sshAlias' }
  }
  try {
    const { stdout } = await run('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      machine.sshAlias,
      buildGateCommand({ domain: machine.domain, netbirdIp: machine.netbirdIp }),
    ], { timeout: Math.max(timeoutMs, SSH_TIMEOUT_MS), maxBuffer: 1 << 20 })
    return { status: null, ...classifyGateProbe(parseGateProbe(stdout)) }
  } catch (error) {
    const raw = String(error?.stderr ?? '').trim() || String(error?.message ?? 'ssh failed')
    const last = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? 'ssh failed'
    return { status: null, ok: false, state: 'gate-probe-failed', detail: last.slice(0, 160) }
  }
}

async function probe(machine, timeoutMs = DEFAULT_TIMEOUT_MS, { posture = true, gate = false } = {}) {
  const authMode = authModeOf(machine)
  let resolved
  try {
    const answer = await lookup(machine.domain, { family: 4 })
    resolved = answer.address
  } catch (error) {
    return {
      ...machine, authMode, resolved: null, status: null, ok: false, state: 'dns-unresolved',
      detail: error.message, posture: null, fence: null, gate: null, body: null, picker: null,
    }
  }
  if (resolved !== machine.netbirdIp) {
    return {
      ...machine, authMode, resolved, status: null, ok: false, state: 'dns-mismatch',
      detail: `expected ${machine.netbirdIp}`, posture: null, fence: null, gate: null, body: null, picker: null,
    }
  }

  const [document, postureResult, fenceResult, gateResult, bodyResult, pickerResult] = await Promise.all([
    probeDocument(machine, timeoutMs),
    posture ? probePosture(machine, timeoutMs) : Promise.resolve(null),
    posture ? probeFence(machine, authMode, timeoutMs) : Promise.resolve(null),
    gate ? probeGate(machine, timeoutMs) : Promise.resolve(null),
    probeBody(machine, timeoutMs),
    probePicker(machine, authMode, timeoutMs),
  ])
  const entry = { ...document, ...classifyAuthMode({ state: document.state, authMode }) }
  return {
    ...machine, authMode, resolved, ...entry,
    posture: postureResult, fence: fenceResult, gate: gateResult, body: bodyResult, picker: pickerResult,
  }
}

/** The gate verdict for one machine, including the network-gate policy rule. */
export function judgeGate({ authMode, gate }) {
  if (authMode === 'network-gate' && gate === null) {
    return { ok: false, state: 'gate-unverified', detail: 'run --verify-gate over SSH' }
  }
  if (gate === null) return { ok: true, state: 'gate-not-verified' }
  return { ok: gate.ok, state: gate.state, detail: gate.detail }
}

function printSection(title, results, width, pick) {
  console.log(`${title}:`)
  for (const item of results) {
    const entry = pick(item)
    if (entry === null) {
      console.log(`${'SKIP'.padEnd(4)} ${item.domain.padEnd(width)} not-probed`)
      continue
    }
    const mark = entry.ok ? 'OK' : 'FAIL'
    const http = entry.status === null || entry.status === undefined ? '-' : String(entry.status)
    const detail = entry.detail === undefined ? '' : ` (${entry.detail})`
    console.log(`${mark.padEnd(4)} ${item.domain.padEnd(width)} HTTP ${http.padEnd(3)} ${entry.state}${detail}`)
  }
}

async function main() {
  const json = JSON.parse(await readFile(INVENTORY, 'utf8'))
  const { timeoutMs, skipPosture, verifyGate } = parseAuditArgs(process.argv.slice(2))
  const results = await Promise.all(json.machines.map((machine) => probe(machine, timeoutMs, {
    posture: !skipPosture,
    gate: verifyGate,
  })))
  const width = Math.max(...results.map((item) => item.domain.length))
  for (const item of results) {
    const mark = item.ok ? 'OK' : 'FAIL'
    const http = item.status === null ? '-' : String(item.status)
    const detail = item.detail === undefined ? '' : ` (${item.detail})`
    console.log(`${mark.padEnd(4)} ${item.domain.padEnd(width)} ${String(item.resolved ?? '-').padEnd(15)} HTTP ${http.padEnd(3)} ${item.state}${detail}`)
  }

  console.log('')
  if (skipPosture) {
    console.log(`host-access posture (${POSTURE_PATH}): skipped (--skip-posture)`)
    console.log(`host-access fence (${FENCE_PATH}): skipped (--skip-posture)`)
  } else {
    printSection(`host-access posture (${POSTURE_PATH})`, results, width, (item) => item.posture)
    console.log('')
    printSection(`host-access fence (${FENCE_PATH}, undeclared and sessionless reads)`, results, width, (item) => item.fence)
  }

  console.log('')
  printSection(`request body (${BODY_PROBE_PATH}, ${BODY_PROBE_LABEL} POST)`, results, width,
    (item) => item.body)

  console.log('')
  printSection(`directory picker (${PICKER_PATH}, browse listing verb)`, results, width,
    (item) => item.picker)

  console.log('')
  const gateVerdicts = new Map(results.map((item) => [item.domain, judgeGate({ authMode: item.authMode, gate: item.gate })]))
  if (verifyGate) {
    printSection('overlay gate (non-overlay local addresses, read-only over SSH)', results, width,
      (item) => item.gate)
  } else {
    console.log(`overlay gate (--verify-gate): ${verifyGate ? '' : 'skipped'}`)
    for (const item of results) {
      const verdict = gateVerdicts.get(item.domain)
      const mark = verdict.ok ? 'OK' : 'FAIL'
      console.log(`${mark.padEnd(4)} ${item.domain.padEnd(width)} ${verdict.state}${verdict.detail === undefined ? '' : ` (${verdict.detail})`}`)
    }
  }

  const failed = results.some((item) => !item.ok
    || (item.posture !== null && !item.posture.ok)
    || (item.fence !== null && !item.fence.ok)
    || (item.body !== null && !item.body.ok)
    || (item.picker !== null && !item.picker.ok)
    || !gateVerdicts.get(item.domain).ok)
  if (failed) process.exitCode = 1
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) await main()