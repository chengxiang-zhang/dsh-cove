import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  AUTH_MODES,
  BODY_PROBE_BYTES,
  authModeOf,
  buildGateCommand,
  classifyAccessProbe,
  classifyAuthMode,
  classifyBodyProbe,
  classifyFenceProbe,
  classifyGateProbe,
  classifyProbe,
  classifyOffOverlay,
  classifyPickerProbe,
  judgeGate,
  parseAuditArgs,
  parseGateProbe,
} from './dsh-netbird-audit.mjs'

test('accepts the unauthenticated gateway login redirect', () => {
  assert.deepEqual(classifyProbe({ status: 302, location: '/login?next=%2F' }), {
    ok: true,
    state: 'login-required',
  })
})

test('accepts an absolute login redirect, the spelling an off-overlay answer uses', () => {
  assert.deepEqual(classifyProbe({ status: 302, location: 'http://192.168.200.2/login?next=%2F' }), {
    ok: true,
    state: 'login-required',
  })
  assert.deepEqual(classifyProbe({ status: 302, location: 'http://192.168.200.2/apk/' }), {
    ok: false,
    state: 'unexpected-http-302',
  })
})

test('accepts the authenticated DSH application document', () => {
  assert.deepEqual(classifyProbe({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><base href="./"><title>DeepSeek Harness</title></head></html>',
  }), {
    ok: true,
    state: 'authenticated-app',
  })
})

test('detects when integrated BrowserAuth is not mounted', () => {
  assert.deepEqual(classifyProbe({
    status: 401,
    body: 'dsh web authentication required; reopen the URL printed by dsh web.',
  }), {
    ok: false,
    state: 'integrated-auth-not-mounted',
  })
})

test('detects an unavailable DSH upstream', () => {
  assert.deepEqual(classifyProbe({ status: 502 }), {
    ok: false,
    state: 'upstream-unavailable',
  })
})

test('rejects unrelated HTTP success pages', () => {
  assert.deepEqual(classifyProbe({
    status: 200,
    contentType: 'text/html',
    body: '<title>Welcome to nginx!</title>',
  }), {
    ok: false,
    state: 'unexpected-http-200',
  })
})

const accessJson = (value) => ({
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(value),
})

test('accepts a declared canonical authority without requiring owners', () => {
  // owners additionally requires a browser session outside noBrowserAuth mode,
  // so a live deployment legitimately answers owners: false here.
  assert.deepEqual(classifyAccessProbe(accessJson({
    authority: { host: 'dsh.studio-mac', loopback: false, declared: true },
    session: false,
    owners: false,
  })), {
    ok: true,
    state: 'authority-trusted',
  })
})

test('accepts a loopback authority that is declared', () => {
  assert.deepEqual(classifyAccessProbe(accessJson({
    authority: { host: '127.0.0.1:3080', loopback: true, declared: true },
    session: false,
    owners: true,
  })), {
    ok: true,
    state: 'authority-trusted',
  })
})

test('flags a JSON authority that is explicitly undeclared', () => {
  assert.deepEqual(classifyAccessProbe(accessJson({
    authority: { host: 'dsh.studio-mac', loopback: false, declared: false },
    session: false,
    owners: false,
  })), {
    ok: false,
    state: 'authority-untrusted',
  })
})

test('flags a JSON 200 that carries no authority block', () => {
  assert.deepEqual(classifyAccessProbe(accessJson({ session: false, owners: false })), {
    ok: false,
    state: 'authority-untrusted',
  })
})

test('treats the loopback-only fence refusal as the missing-flag signature', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 403,
    contentType: 'application/json',
    body: '{"error":"forbidden: loopback-only"}',
  }), {
    ok: false,
    state: 'authority-untrusted',
  })
})

test('treats the bare forbidden fence refusal as untrusted', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 403,
    contentType: 'application/json',
    body: '{"error":"forbidden"}',
  }), {
    ok: false,
    state: 'authority-untrusted',
  })
})

test('rejects an unrelated JSON 403', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 403,
    contentType: 'application/json',
    body: '{"error":"csrf"}',
  }), {
    ok: false,
    state: 'unexpected-http-403',
  })
})

test('reports a missing posture route on 404', () => {
  assert.deepEqual(classifyAccessProbe({ status: 404, contentType: 'text/html', body: 'not found' }), {
    ok: false,
    state: 'access-probe-missing',
  })
})

test('reports a missing posture route on a non-JSON body', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body>DeepSeek Harness</body></html>',
  }), {
    ok: false,
    state: 'access-probe-missing',
  })
})

test('reports malformed JSON bodies distinctly', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 200,
    contentType: 'application/json',
    body: '{"authority": {"declared": tru',
  }), {
    ok: false,
    state: 'access-probe-malformed',
  })
})

test('reports an unexpected JSON status instead of guessing a posture', () => {
  assert.deepEqual(classifyAccessProbe({
    status: 500,
    contentType: 'application/json',
    body: '{"error":"boom"}',
  }), {
    ok: false,
    state: 'unexpected-http-500',
  })
})

test('keeps posture enabled by default and recognizes --skip-posture', () => {
  assert.deepEqual(parseAuditArgs([]), { timeoutMs: 5000, skipPosture: false, verifyGate: false })
  assert.deepEqual(parseAuditArgs(['--timeout=1200']), { timeoutMs: 1200, skipPosture: false, verifyGate: false })
  assert.deepEqual(parseAuditArgs(['--skip-posture']), { timeoutMs: 5000, skipPosture: true, verifyGate: false })
})

test('recognizes --verify-gate as the opt-in overlay gate verification', () => {
  assert.deepEqual(parseAuditArgs(['--verify-gate']), { timeoutMs: 5000, skipPosture: false, verifyGate: true })
})

test('the audit CLI documents the --skip-posture switch', async () => {
  const source = await readFile(new URL('./dsh-netbird-audit.mjs', import.meta.url), 'utf8')
  assert.match(source, /argv\.includes\('--skip-posture'\)/)
  assert.match(source, /\/api\/dsh-access\/session/)
})

/* ---------- declared authentication mode ---------- */

test('defaults an undeclared authentication mode to password', () => {
  assert.deepEqual(AUTH_MODES, ['password', 'network-gate'])
  assert.equal(authModeOf({}), 'password')
  assert.equal(authModeOf({ authMode: 'password' }), 'password')
  assert.equal(authModeOf({ authMode: 'network-gate' }), 'network-gate')
  assert.equal(authModeOf({ authMode: 'network_gate' }), 'invalid')
})

test('a password machine must redirect an unauthenticated browser to the login page', () => {
  assert.deepEqual(classifyAuthMode({ state: 'login-required', authMode: 'password' }), {
    ok: true,
    state: 'login-required',
  })
})

test('an unauthenticated application document on a password machine is the removed browser wall', () => {
  assert.deepEqual(classifyAuthMode({ state: 'authenticated-app', authMode: 'password' }), {
    ok: false,
    state: 'no-browser-auth-exposed',
  })
})

test('a network-gate machine serves the document because the overlay gate authenticates', () => {
  assert.deepEqual(classifyAuthMode({ state: 'authenticated-app', authMode: 'network-gate' }), {
    ok: true,
    state: 'network-gate-app',
  })
})

test('a network-gate machine that still redirects to login contradicts its declaration', () => {
  assert.deepEqual(classifyAuthMode({ state: 'login-required', authMode: 'network-gate' }), {
    ok: false,
    state: 'auth-mode-mismatch',
  })
})

test('an unknown authentication mode fails closed', () => {
  assert.deepEqual(classifyAuthMode({ state: 'authenticated-app', authMode: 'invalid' }), {
    ok: false,
    state: 'auth-mode-invalid',
  })
})

test('carries the document failure through in both modes', () => {
  assert.deepEqual(classifyAuthMode({ state: 'upstream-unavailable', authMode: 'password' }), {
    ok: false,
    state: 'upstream-unavailable',
  })
  assert.deepEqual(classifyAuthMode({ state: 'upstream-unavailable', authMode: 'network-gate' }), {
    ok: false,
    state: 'upstream-unavailable',
  })
})

/* ---------- shared host access fence ---------- */

test('an undeclared Host reading the worktree index is a leak on every machine', () => {
  for (const authMode of ['password', 'network-gate']) {
    assert.deepEqual(classifyFenceProbe({ status: 200, hostKind: 'undeclared', authMode }), {
      ok: false,
      state: 'undeclared-host-leak',
    })
  }
})

test('a refused undeclared Host satisfies the fence', () => {
  for (const status of [302, 401, 403, 404]) {
    assert.deepEqual(classifyFenceProbe({ status, hostKind: 'undeclared', authMode: 'password' }), {
      ok: true,
      state: 'undeclared-host-refused',
    })
  }
})

test('a sessionless read on a declared Host leaks on a password machine', () => {
  assert.deepEqual(classifyFenceProbe({ status: 200, hostKind: 'declared', authMode: 'password' }), {
    ok: false,
    state: 'session-fence-missing',
  })
})

test('a sessionless read on a declared Host is the documented network-gate admission', () => {
  assert.deepEqual(classifyFenceProbe({ status: 200, hostKind: 'declared', authMode: 'network-gate' }), {
    ok: true,
    state: 'sessionless-read-admitted',
  })
})

test('a refused sessionless read is right for a password machine and wrong for a network gate', () => {
  assert.deepEqual(classifyFenceProbe({ status: 403, hostKind: 'declared', authMode: 'password' }), {
    ok: true,
    state: 'session-fence-enforced',
  })
  assert.deepEqual(classifyFenceProbe({ status: 403, hostKind: 'declared', authMode: 'network-gate' }), {
    ok: false,
    state: 'gate-refused-sessionless-read',
  })
})

test('reports an unreachable fence probe instead of assuming it passed', () => {
  assert.deepEqual(classifyFenceProbe({ status: null, hostKind: 'declared', authMode: 'password' }), {
    ok: false,
    state: 'connection-failed',
  })
})

/* ---------- overlay gate ---------- */

test('parses the on-host gate probe rows and sentinels', () => {
  assert.deepEqual(parseGateProbe('192.168.200.2|302|http://192.168.200.2/login?next=%2F|\n10.2.0.14|404||text/html|not found\n'), [
    { address: '192.168.200.2', status: 302, location: 'http://192.168.200.2/login?next=%2F', contentType: '', body: '' },
    { address: '10.2.0.14', status: 404, location: '', contentType: 'text/html', body: 'not found' },
  ])
  assert.deepEqual(parseGateProbe('curl-missing\n'), [{ sentinel: 'curl-missing' }])
  assert.deepEqual(parseGateProbe('no-local-addresses\n'), [{ sentinel: 'no-local-addresses' }])
})

test('a non-overlay address serving the DSH entry is a gate leak', () => {
  const login = parseGateProbe('192.168.200.2|302|http://192.168.200.2/login?next=%2F||\n')
  assert.deepEqual(classifyGateProbe(login), {
    ok: false,
    state: 'gate-leak',
    detail: '192.168.200.2 (HTTP 302)',
  })
  const document = parseGateProbe('192.168.111.32|200||text/html; charset=utf-8|<!doctype html><base href="./">\n')
  assert.deepEqual(classifyGateProbe(document), {
    ok: false,
    state: 'gate-leak',
    detail: '192.168.111.32 (HTTP 200)',
  })
  const authPage = parseGateProbe('192.168.1.151|401||text/plain|dsh web authentication required\n')
  assert.deepEqual(classifyGateProbe(authPage), {
    ok: false,
    state: 'gate-leak',
    detail: '192.168.1.151 (HTTP 401)',
  })
})

test('accepts a gate where every non-overlay address refuses or answers something else', () => {
  assert.deepEqual(classifyGateProbe(parseGateProbe([
    '192.168.111.32|404||text/html|<html><title>404 Not Found</title>',
    '192.168.200.1|000|||',
    '172.17.0.1|401||text/plain|unauthorized',
  ].join('\n') + '\n')), {
    ok: true,
    state: 'gate-ok',
    detail: '3 non-overlay address(es) clean',
  })
})

test('a refused or unrelated page is never read as a leak', () => {
  assert.deepEqual(classifyOffOverlay({ status: 0 }), { ok: true, state: 'gate-clean' })
  assert.deepEqual(classifyOffOverlay({ status: 404, contentType: 'text/html', body: '<title>Welcome to nginx!</title>' }), {
    ok: true,
    state: 'gate-clean',
  })
  assert.deepEqual(classifyOffOverlay({ status: 502 }), { ok: true, state: 'gate-clean' })
})

test('accepts a machine with no non-overlay address and rejects an unverifiable probe', () => {
  assert.deepEqual(classifyGateProbe(parseGateProbe('no-local-addresses\n')), {
    ok: true,
    state: 'gate-ok',
    detail: 'no non-overlay local address',
  })
  assert.deepEqual(classifyGateProbe(parseGateProbe('curl-missing\n')), {
    ok: false,
    state: 'gate-probe-failed',
    detail: 'curl unavailable on the target',
  })
  assert.deepEqual(classifyGateProbe([]), { ok: false, state: 'gate-probe-failed', detail: 'no output' })
})

test('the gate command is read-only and probes the canonical Host off the overlay address', () => {
  const command = buildGateCommand({ domain: 'dsh.laptop-b', netbirdIp: '100.64.0.12' })
  assert.match(command, /-H "Host: \$d"/)
  assert.match(command, /d='dsh\.laptop-b'/)
  assert.match(command, /nb='100\.64\.0\.12'/)
  assert.match(command, /\[ "\$ip" = "\$nb" \] && continue/)
  assert.match(command, /"http:\/\/\$ip\/"/)
  assert.match(command, /%\{http_code\}\|\%\{redirect_url\}\|\%\{content_type\}/)
  assert.doesNotMatch(command, /\b(sudo|tee|rm|mv|chmod|systemctl|kill)\b/)
  assert.doesNotMatch(command, />>/)
})

test('the gate command consumes the address list with read, not an unquoted for loop', () => {
  // macOS remote shells are zsh, where `for ip in $ips` iterates once over the
  // whole newline-joined list and silently probes nothing.
  const command = buildGateCommand({ domain: 'dsh.studio-mac', netbirdIp: '100.64.0.11' })
  assert.match(command, /\| while read -r ip; do/)
  assert.doesNotMatch(command, /for ip in \$/)
})

test('a network-gate machine may not pass the audit without a verified gate', () => {
  assert.deepEqual(judgeGate({ authMode: 'network-gate', gate: null }), {
    ok: false,
    state: 'gate-unverified',
    detail: 'run --verify-gate over SSH',
  })
  assert.deepEqual(judgeGate({ authMode: 'password', gate: null }), {
    ok: true,
    state: 'gate-not-verified',
  })
  assert.deepEqual(judgeGate({
    authMode: 'network-gate',
    gate: { ok: false, state: 'gate-leak', detail: '192.168.1.151 (HTTP 200)' },
  }), {
    ok: false,
    state: 'gate-leak',
    detail: '192.168.1.151 (HTTP 200)',
  })
})

test('canonical nginx template streams large application bundles without temp-file buffering', async () => {
  const template = await readFile(new URL('../tools/dsh-netbird/nginx.conf.template', import.meta.url), 'utf8')
  assert.match(template, /proxy_buffering\s+off;/)
  assert.match(template, /proxy_pass\s+http:\/\/127\.0\.0\.1:(?:3080|3082);/)
})

test('canonical nginx template keeps worker temp paths out of user homes', async () => {
  // The worker runs as the compiled default user (nobody) while the master keeps
  // the privilege its ports need, so nginx must spool request bodies to a path
  // that user can reach once nginx has chowned it. A server block that pins
  // nothing falls back to the compiled prefix under the user home, so the check
  // is per block: adding an entry must not leave the default in force anywhere.
  const template = await readFile(new URL('../tools/dsh-netbird/nginx.conf.template', import.meta.url), 'utf8')
  const blocks = template.split(/^server \{/m).slice(1)
  assert.ok(blocks.length >= 2, 'the template declares the plaintext and the TLS entry')
  for (const block of blocks) {
    const declared = block.split('\n')
      .filter((line) => /^\s*(?:client_body|proxy|fastcgi|uwsgi|scgi)_temp_path\b/.test(line))
    assert.deepEqual(declared.map((line) => line.trim().split(/\s+/)[0]).sort(), [
      'client_body_temp_path',
      'fastcgi_temp_path',
      'proxy_temp_path',
      'scgi_temp_path',
      'uwsgi_temp_path',
    ])
    for (const line of declared) {
      assert.match(line, /^\s*\w+_temp_path\s+\/var\/tmp\/dsh-nginx\/[a-z_]+;\s*$/)
    }
  }
})

test('canonical nginx template serves the TLS entry on the overlay address with the machine leaf', async () => {
  const template = await readFile(new URL('../tools/dsh-netbird/nginx.conf.template', import.meta.url), 'utf8')
  assert.match(template, /^\s*listen\s+__NETBIRD_IP__:443\s+ssl;\s*$/m)
  // A wildcard listener would publish the TLS entry on every interface.
  assert.doesNotMatch(template, /^\s*listen\s+(?:443|\*:443|\[::\]:443|0\.0\.0\.0:443)\s+ssl;/m)
  assert.match(template, /^\s*ssl_certificate\s+__TLS_DIR__\/dsh\.__MACHINE__\.netbird\.crt;\s*$/m)
  assert.match(template, /^\s*ssl_certificate_key\s+__TLS_DIR__\/dsh\.__MACHINE__\.netbird\.key;\s*$/m)
  assert.match(template, /^\s*ssl_protocols\s+TLSv1\.2 TLSv1\.3;\s*$/m)
  // The plaintext entry keeps serving: the mobile client's GeckoView reads its own
  // root store, so a redirect here would take the phone's workspace away.
  assert.doesNotMatch(template, /return\s+30[12]\s+https:\/\//)
})

test('a 500 on an oversized request body fails the audit', () => {
  assert.deepEqual(classifyBodyProbe({ status: 500 }), {
    ok: false,
    state: 'request-body-temp-unusable',
    status: 500,
  })
  for (const status of [200, 302, 401, 403, 404]) {
    assert.equal(classifyBodyProbe({ status }).ok, true, `HTTP ${status} must pass`)
  }
  assert.equal(classifyBodyProbe({ error: new Error('connect ECONNREFUSED') }).state, 'connection-failed')
  assert.equal(classifyBodyProbe({ status: null }).state, 'connection-failed')
})

test('the request-body probe exceeds the largest buffer configured in the inventory', () => {
  // thinkpad-lab raises client_body_buffer_size to 512 KiB, so a smaller probe
  // would stay in memory there and never exercise the temp path.
  assert.ok(BODY_PROBE_BYTES > 512 * 1024, `probe body ${BODY_PROBE_BYTES} must exceed 512 KiB`)
})

/* ---------- composed directory picker ---------- */

/** The Typert Remote envelope the picker route answers with. */
const pickerEnvelope = (result) => JSON.stringify({ type: 'server-response', rpcId: 'netbird-audit-picker', result })

test('a listing proves the machine composes the browse interaction a peer can drive', () => {
  assert.deepEqual(classifyPickerProbe({
    status: 200,
    authMode: 'network-gate',
    body: pickerEnvelope({ ok: true, value: { path: '/Users/tester', entries: [] } }),
  }), { ok: true, state: 'picker-browse' })
})

test('the native OS chooser fails the audit: a peer browser cannot reach the host display', () => {
  assert.deepEqual(classifyPickerProbe({
    status: 200,
    authMode: 'network-gate',
    body: pickerEnvelope({
      ok: false,
      error: {
        code: 'directory-picker/unavailable',
        message: 'directoryPicker.list needs the browse capability; the composed picker serves "native"',
        details: { capability: 'native' },
      },
    }),
  }), {
    ok: false,
    state: 'picker-native-unreachable',
    detail: 'composed picker serves "native"; a peer browser has no OS chooser',
  })
})

test('a picker serving neither interaction is reported by the capability it does serve', () => {
  assert.deepEqual(classifyPickerProbe({
    status: 200,
    authMode: 'network-gate',
    body: pickerEnvelope({
      ok: false,
      error: { code: 'directory-picker/unavailable', details: { capability: 'something-else' } },
    }),
  }), {
    ok: false,
    state: 'picker-capability-missing',
    detail: 'composed picker serves "something-else"',
  })
})

test('a guarded entry reports the picker as unverifiable instead of guessing', () => {
  for (const status of [302, 401, 403]) {
    assert.deepEqual(classifyPickerProbe({ status, authMode: 'password' }), {
      ok: true,
      state: 'picker-not-verifiable',
      detail: `HTTP ${status} before the picker`,
    })
  }
  // The same refusal on a network-gate machine is a contradiction: that entry
  // admits the declared Host without a session, so the picker was never reached.
  assert.deepEqual(classifyPickerProbe({ status: 401, authMode: 'network-gate' }), {
    ok: false,
    state: 'unexpected-http-401',
  })
})

test('a picker probe that never reached the picker is never read as a pass', () => {
  assert.equal(classifyPickerProbe({ status: null, authMode: 'network-gate' }).state, 'picker-probe-failed')
  assert.equal(classifyPickerProbe({ status: 200, authMode: 'network-gate', body: '<html>oops</html>' }).state, 'picker-probe-malformed')
  assert.equal(classifyPickerProbe({ status: 200, authMode: 'network-gate', body: pickerEnvelope({ ok: false, error: { code: 'gateway/internal' } }) }).state, 'picker-probe-refused')
  assert.equal(classifyPickerProbe({ status: 404, authMode: 'network-gate', body: '' }).state, 'unexpected-http-404')
})

test('canonical nginx template serves the DSH entry on the overlay address only', async () => {
  const template = await readFile(new URL('../tools/dsh-netbird/nginx.conf.template', import.meta.url), 'utf8')
  assert.match(template, /^\s*listen\s+__NETBIRD_IP__:80;\s*$/m)
  // A wildcard listener would publish the entry on every interface of the host.
  assert.doesNotMatch(template, /^\s*listen\s+(?:80|\*:80|\[::\]:80|0\.0\.0\.0:80);/m)
})

test('every inventory entry declares a known authentication mode', async () => {
  const inventory = JSON.parse(await readFile(new URL('../tools/dsh-netbird/machines.json', import.meta.url), 'utf8'))
  assert.ok(inventory.machines.length > 0)
  for (const machine of inventory.machines) {
    assert.ok(AUTH_MODES.includes(machine.authMode),
      `${machine.domain} must declare authMode (${AUTH_MODES.join(' | ')})`)
  }
})

test('canonical profile tolerates overlay jitter before declaring the WebSocket dead', async () => {
  const patch = await readFile(new URL('../tools/dsh-netbird/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: typert-gateway\s+config:\s+websocketHeartbeatIntervalMs: 30000/m)
})

test('canonical profile pins the browse picker pair a peer browser can drive', async () => {
  // The adaptive chooser reads this topology as "the operator sits at the
  // display": the bind is loopback and the launch is not over SSH, so it
  // composes the OS chooser on every darwin machine and a peer's pick request
  // hangs until the proxy gives up. Both faces of the browse interaction must be
  // composed, and the chooser row disabled: `name` in a patch is a mismatch
  // guard, so composing the chooser and a backend together is a boot failure.
  const patch = await readFile(new URL('../tools/dsh-netbird/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: directory-picker\s+name: '@deepseek-ai\/dsh-host-directory-picker-auto'\s+disabled: true/m)
  assert.match(patch, /- id: directory-picker-browse\s+name: '@deepseek-ai\/dsh-host-directory-picker-browse'/m)
  assert.match(patch, /- id: directory-picker-browse-surface\s+name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/m)
})

test('canonical LLM preset carries no inline secrets and keeps credentials as refs', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(preset, /sk-[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(preset, /apiKey:\s*\S/)
  assert.match(preset, /apiKeyEnv: KAON_ROUTER_API_KEY/)
  assert.match(preset, /apiKeyEnv: DSH_API_PROXY_KEY/)
})

test('canonical LLM preset pins the fleet provider endpoints and compat facts', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  assert.match(preset, /baseURL: https:\/\/router\.example\.com\/v1/)
  assert.match(preset, /baseURL: http:\/\/127\.0\.0\.1:8317\/v1/)
  assert.match(preset, /supportsDeveloperRole: false/)
  assert.match(preset, /requestImageMaxBytes: 524288/)
})

test('canonical LLM preset keeps the kaon image budget below the upstream multimodal deadline', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  const kaonBlock = preset.slice(preset.indexOf('      router:'), preset.indexOf('      codex-local:'))
  // 整包上限同时是 image offload 的触发线：只有整包 base64 超限，DSH 才会把最旧的图换成文字
  // 占位后重试。上游（DashScope 侧）每次请求都要重新取一遍历史里的全部图片，2026-10-15 实测
  // 20 张图约 2.9MB base64 在途 63s 后返回 400 "Download multimodal file timed out"，
  // 所以整包必须停在 1MiB 档；放宽这个值会让会话重新落回同样的 400。
  assert.match(kaonBlock, /maxRequestImageBytes: 1048576/)
  assert.match(kaonBlock, /requestImageMaxBytes: 524288/)
})

test('canonical LLM preset ships the field-verified catalog with capped context windows', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  const kaonModels = preset.match(/^          - id: kaon\//gm) ?? []
  assert.equal(kaonModels.length, 50)
  const codexModels = preset.match(/^          - id: gpt-5\./gm) ?? []
  assert.equal(codexModels.length, 4)
  // 目录 = kaon 50 + codex-local 8 + hiopen 6；每个机型都必须同时带
  // contextWindow 与 maxTokens（数量不一致说明某条机型漏了封顶或上限）。
  const allModels = preset.match(/^          - id: /gm) ?? []
  assert.equal(allModels.length, 64)
  const windows = [...preset.matchAll(/contextWindow: (\d+)/g)].map((m) => Number(m[1]))
  const maxTokens = preset.match(/^            maxTokens: \d+/gm) ?? []
  assert.equal(windows.length, allModels.length)
  assert.equal(maxTokens.length, allModels.length)
  // 上限约束只针对 kaon 目录：hiopen 机型（如 1048576）与 codex-local 机型是
  // 实测平台容量，允许超过 1 MiB；router 自报窗口膨胀，目录必须封顶。
  const kaonBlock = preset.slice(preset.indexOf('      router:'), preset.indexOf('      codex-local:'))
  const kaonWindows = [...kaonBlock.matchAll(/contextWindow: (\d+)/g)].map((m) => Number(m[1]))
  assert.equal(kaonWindows.length, kaonModels.length)
  assert.ok(kaonWindows.every((n) => n <= 1000000), 'router self-reported windows are inflated; the catalog must cap them')
})

test('canonical LLM preset declares the default agent route inside the kaon catalog', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  assert.match(preset, /- id: agent-default-model/)
  assert.match(preset, /provider: router/)
  assert.match(preset, /model: kaon\/deepseek-v4\.1-flash/)
  assert.match(preset, /reasoningEffort: high/)
})

test('canonical LLM preset keeps the 2026-10-08 audited corrections', async () => {
  const preset = await readFile(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')
  const block = (id) => {
    const start = preset.indexOf(`          - id: ${id}\n`)
    assert.ok(start >= 0, `missing model block: ${id}`)
    const rest = preset.slice(start)
    const next = rest.slice(1).search(/\n          - id: |\n      codex-local:/)
    return next === -1 ? rest : rest.slice(0, next + 1)
  }
  for (const [id, ctx] of [
    ['kaon/claude-fable-5', 180000],
    ['kaon/claude-haiku-4-5-20251001', 200000],
    ['kaon/claude-sonnet-4-5', 100000],
    ['kaon/gpt-5.6-sol', 500000],
    ['kaon/gpt-5.6-terra', 500000],
    ['kaon/gpt-5.6-luna', 500000],
    ['kaon/glm-4.6', 180000],
  ]) {
    assert.match(block(id), new RegExp(`contextWindow: ${ctx}\\b`), `${id} window must stay at the field-probed value ${ctx}`)
  }
  for (const id of ['kaon/deepseek-v3.2', 'kaon/deepseek-v4-flash', 'kaon/deepseek-v4-pro', 'kaon/glm-5', 'kaon/glm-5.2', 'kaon/gpt-6-luna', 'kaon/exclusive-marking-dpsk']) {
    assert.doesNotMatch(block(id), /- image\b/, `${id} was demoted to text-only after blind-vision probes`)
  }
  assert.match(block('kaon/gpt-6.1-sol'), /- image\b/, 'gpt-6.1-sol vision was verified and must stay declared')
  for (const id of ['kaon/glm-5.3', 'kaon/glm-5.3-flash']) {
    const b = block(id)
    assert.doesNotMatch(b, /medium:/, `${id} rejects medium effort upstream`)
    assert.match(b, /max: "max"/, `${id} accepts max effort upstream`)
  }
})
