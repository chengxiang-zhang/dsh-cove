import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  splitPreset,
  mergeProfileText,
  parseRefs,
  upsertRef,
  mergeCredentialRefs,
  findEntrySpan,
  providerSpan,
  servicePlan,
} from './dsh-netbird-llm-apply.mjs'

const presetText = readFileSync(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url), 'utf8')

// Fixture shapes mirror the real fleet profiles (sanitized, no secrets).
const profileWithLlm = `# NetBird DSH WebSocket stability: allow overlay and host scheduling jitter.
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000

- id: web-all
  config:
    noBrowserAuth: true
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      hiopen:
        apiKeyEnv: HIOPEN_API_KEY
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: some-model
            name: some-model
            contextWindow: 1000000
            maxTokens: 32000
      router:
        apiKeyEnv: ANTHROPIC_AUTH_TOKEN
        api: openai-completions
        baseURL: https://router.example.com/v1
        models:
          - id: kaon/stale-model
            name: kaon/stale-model
            contextWindow: 2048000
            maxTokens: 16384
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: hiopen
    model: some-model
    reasoningEffort: high
- id: session-query-sqlite
  config:
    openAt: first-search
`

const profileWithoutLlm = `# minimal fleet profile
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000

- id: web-all
  config:
    noBrowserAuth: false
    remote-web-ui:
      enabled: true
      integratedAuthEnabled: true
`

const credFixture = `version: 1
refs:
  DEEPSEEK_API_KEY: sk-old
  CODEX_LOCAL_API_KEY: proxkey
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: opaque
`

test('splitPreset extracts one canonical block per artifact', () => {
  const preset = splitPreset(presetText)
  assert.match(preset.llmEntry, /^- id: llm-pi-ai\n  name: "@deepseek-ai\/dsh-llm-pi-ai"/)
  assert.match(preset.krBlock, /^      router:/)
  assert.match(preset.clBlock, /^      codex-local:/)
  assert.match(preset.hiopenBlock, /^      hiopen:/)
  assert.match(preset.dmEntry, /^- id: agent-default-model/)
  assert.equal(providerSpan(preset.llmEntry, 'router') !== null, true)
  assert.equal(providerSpan(preset.llmEntry, 'hiopen') !== null, true)
})

test('merge replaces same-named providers wholesale and keeps unrelated rows', () => {
  const preset = splitPreset(presetText)
  const { text, actions } = mergeProfileText(profileWithLlm, preset)
  assert.deepEqual(actions, ['replaced provider router', 'inserted provider codex-local', 'replaced provider hiopen', 'replaced agent-default-model'])
  // hiopen survives (replaced with the canonical curated block), stale router model list is gone
  assert.match(text, /      hiopen:/)
  assert.doesNotMatch(text, /kaon\/stale-model/)
  assert.equal((text.match(/      router:/g) || []).length, 1)
  assert.equal((text.match(/      codex-local:/g) || []).length, 1)
  assert.equal((text.match(/      hiopen:/g) || []).length, 1)
  // unrelated rows survive
  assert.match(text, /- id: session-query-sqlite/)
  assert.match(text, /openAt: first-search/)
  // audited corrections land
  assert.match(text, /contextWindow: 180000/)
  assert.match(text, /contextWindow: 500000/)
  assert.match(text, /max: "max"/)
})

test('merge inserts a full llm entry into a minimal profile', () => {
  const preset = splitPreset(presetText)
  const { text, actions } = mergeProfileText(profileWithoutLlm, preset)
  assert.deepEqual(actions, ['inserted llm-pi-ai entry (router + codex-local + hiopen)', 'inserted agent-default-model'])
  assert.match(text, /- id: web-all/)
  assert.match(text, /- id: llm-pi-ai/)
  assert.match(text, /- id: agent-default-model/)
  assert.match(text, /integratedAuthEnabled: true/)
})

test('merge is idempotent: a second pass is byte-identical and reports replaces', () => {
  const preset = splitPreset(presetText)
  const first = mergeProfileText(profileWithLlm, preset)
  const second = mergeProfileText(first.text, preset)
  assert.equal(second.text, first.text)
  const firstMinimal = mergeProfileText(profileWithoutLlm, preset)
  const secondMinimal = mergeProfileText(firstMinimal.text, preset)
  assert.equal(secondMinimal.text, firstMinimal.text)
})

test('merge never emits secrets and keeps the catalog size', () => {
  const preset = splitPreset(presetText)
  const { text } = mergeProfileText(profileWithLlm, preset)
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{16,}/)
  assert.equal((text.match(/          - id: kaon\//g) || []).length, 50)
  assert.equal((text.match(/          - id: gpt-5\./g) || []).length, 4)
})

test('credential ref merge parses sections, upserts, and copies machine-local values', () => {
  const refs = parseRefs(credFixture)
  assert.deepEqual(refs, { DEEPSEEK_API_KEY: 'sk-old', CODEX_LOCAL_API_KEY: 'proxkey' })

  const added = upsertRef(credFixture, 'KAON_ROUTER_API_KEY', 'sk-new')
  assert.match(added.text, /  KAON_ROUTER_API_KEY: sk-new/)
  assert.match(added.text, /  DEEPSEEK_API_KEY: sk-old/)
  assert.equal(added.how, 'added')

  const updated = upsertRef(added.text, 'KAON_ROUTER_API_KEY', 'sk-other')
  assert.equal(updated.how, 'updated')
  assert.match(updated.text, /  KAON_ROUTER_API_KEY: sk-other/)

  const copied = mergeCredentialRefs(credFixture, { copies: [['CODEX_LOCAL_API_KEY', 'DSH_API_PROXY_KEY']] })
  assert.match(copied.text, /  DSH_API_PROXY_KEY: proxkey/)
  assert.deepEqual(copied.applied, ['added DSH_API_PROXY_KEY (from CODEX_LOCAL_API_KEY)'])

  assert.throws(() => mergeCredentialRefs(credFixture, { copies: [['MISSING_SRC', 'DST']] }), /copy-ref source missing/)
})

test('service plan refuses the operator host and knows every fleet alias', () => {
  assert.match(servicePlan('ssh-studio-mac').refused, /running DSH host/)
  for (const alias of ['ssh-laptop-b', 'ssh-imac-office']) {
    const plan = servicePlan(alias)
    assert.match(plan.stop, /launchctl bootout/)
    assert.match(plan.start, /launchctl bootstrap/)
  }
  for (const alias of ['ssh-thinkpad-lab', 'ssh-tower-lab', 'nb-tx']) {
    assert.equal(servicePlan(alias).restart.length, 1)
  }
  assert.equal(servicePlan('nb-unknown-alias').unknown, true)
})

test('entry spans anchor on top-level rows only', () => {
  const [s, e] = findEntrySpan(profileWithLlm, 'llm-pi-ai')
  const entry = profileWithLlm.slice(s, e)
  assert.match(entry, /^- id: llm-pi-ai/)
  assert.doesNotMatch(entry, /^- id: session-query-sqlite/)
  const kr = providerSpan(entry, 'router')
  assert.doesNotMatch(entry.slice(kr[0], kr[1]), /      hiopen:/)
  assert.equal(findEntrySpan(profileWithLlm, 'not-present'), null)
})
