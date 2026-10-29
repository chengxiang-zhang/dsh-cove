/**
 * Unit tests for the pure helpers in verify-docs.mjs.
 *
 * Importing verify-docs.mjs must not run the gate (guarded by import.meta.main),
 * so these tests only exercise the exported helpers against inline fixtures.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signature, sigEqual, slugify, isExternal, pairSets } from './verify-docs.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('pairSets declares the root entry documents before package READMEs', () => {
  const labels = pairSets(repoRoot).map((set) => set.label)
  assert.deepEqual(labels.slice(0, 2), ['root', 'CONTRIBUTING'])
  assert.ok(labels.includes('packages/dsh-web-all'))
  assert.ok(labels.includes('packages/dsh-community-plugins'))
})

test('every declared pair names two distinct Markdown sides and one record', () => {
  for (const set of pairSets(repoRoot)) {
    assert.match(set.en, /\.md$/, set.label + ' English side')
    assert.match(set.zh, /\.md$/, set.label + ' Chinese side')
    assert.notEqual(set.en, set.zh, set.label + ' must not pair a file with itself')
    assert.match(set.record, /\.i18n\.yaml$/, set.label + ' pairing record')
  }
})

test('signature collects heading levels in order', () => {
  const sig = signature('# H1\n\n## H2\n\n### H3')
  assert.deepEqual(sig.headings, [1, 2, 3])
})

test('signature ignores headings inside fenced code', () => {
  const sig = signature('# H1\n```sh\n# not a heading\n```\n## H2')
  assert.deepEqual(sig.headings, [1, 2])
})

test('signature records fence language markers, not bodies', () => {
  const sig = signature('# H1\n```sh\necho hi\n```')
  assert.deepEqual(sig.fences, ['open:sh', 'close:sh'])
})

test('sigEqual accepts translated code-block comments', () => {
  const en = signature('# H1\n```sh\n# run the build\npnpm build\n```')
  const zh = signature('# H1\n```sh\n# 运行构建\npnpm build\n```')
  assert.equal(sigEqual(en, zh), true)
})

test('signature records table widths and list kinds', () => {
  const sig = signature('| a | b |\n| --- | --- |\n- item\n- item2\n1. ordered')
  assert.deepEqual(sig.tables, [2, 2])
  assert.deepEqual(sig.lists, ['u', 'u', 'o'])
})

test('sigEqual mirrors identical structure with translated headings', () => {
  const en = signature('# Title\n\n## Install\n- item')
  const zh = signature('# 标题\n\n## 安装\n- item')
  assert.equal(sigEqual(en, zh), true)
})

test('sigEqual rejects differing list kinds', () => {
  const en = signature('- item')
  const zh = signature('1. item')
  assert.equal(sigEqual(en, zh), false)
})

test('slugify produces github-style anchors', () => {
  assert.equal(slugify('Known limitations'), 'known-limitations')
  assert.equal(slugify('安装说明'), '安装说明')
  assert.equal(slugify('安全模型 (v2)!'), '安全模型-v2')
})

test('isExternal excludes urls, protocol-relative and root-absolute', () => {
  assert.equal(isExternal('https://example.com'), true)
  assert.equal(isExternal('//example.com'), true)
  assert.equal(isExternal('/docs/plugins.md'), true)
  assert.equal(isExternal('docs/plugins.md'), false)
  assert.equal(isExternal('README.md#install'), false)
  assert.equal(isExternal('mailto:hi@example.com'), true)
})