import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Pinned union of dsh.client.inject module ids across every workspace
 * package. Approved for the 0.2.0-rc.2 cohort: each name resolves to an
 * official package that publishes 0.2.0-rc.2 and is present in the rc.2
 * shell composition (dsh-web-app browser roster rows; dsh-client-ui-slots
 * is a frozen static module of the shell, so it has no ./client export).
 * A rename, removal, or new inject name must update this list together with
 * its runtime-module-table evidence.
 *
 * `@deepseek-ai/dsh-client-runtime` was removed from the roster: upstream
 * retired it in 0.2 (the running install ships no such package, its npm line
 * stops at 0.1.1-rc.2, and the served shell lists no `dsh-client-runtime/
 * client.js` in any plugin group), and the client-modules loader skips an
 * inject name with no graph row. Type imports moved to the owning packages
 * (cordis Context, dsh-api-session-controller/client, dsh-session/types,
 * dsh-workspace/types).
 */
const APPROVED_INJECT_MODULES = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-theme',
]

function collectInjects() {
  const files = []
  for (const base of [join(ROOT, 'packages')]) {
    for (const entry of readdirSync(base)) {
      const pkg = join(base, entry, 'package.json')
      if (existsSync(pkg)) files.push(pkg)
    }
  }
  const names = new Set()
  for (const file of files) {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    for (const name of json?.dsh?.client?.inject ?? []) names.add(name)
  }
  return [...names].sort()
}

test('every dsh.client.inject name is an approved 0.2.0-rc.2 client module', () => {
  for (const name of collectInjects()) {
    assert.ok(
      APPROVED_INJECT_MODULES.includes(name),
      `inject name outside the approved 0.2.0-rc.2 module set: ${name}`,
    )
  }
})

test('the approved inject module set matches actual usage exactly', () => {
  assert.deepEqual(collectInjects(), [...APPROVED_INJECT_MODULES].sort())
})
