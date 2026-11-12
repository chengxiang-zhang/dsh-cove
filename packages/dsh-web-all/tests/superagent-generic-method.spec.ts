import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { managedVerificationMethod, parseModuleVerificationCases } from '../src/host/services/superagent/executors/managed-verification-method.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'generic-method-')); roots.push(root)
  const method = managedVerificationMethod('javascript-module@1', { entryPath: 'public/business.mjs' })
  mkdirSync(join(root, 'public')); writeFileSync(join(root, 'public/business.mjs'), source)
  for (const [path, bytes] of Object.entries(method.assets)) writeFileSync(join(root, path), bytes)
  return (input: unknown) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {inspect} from './candidate.mjs'; console.log(JSON.stringify(await inspect(JSON.parse(process.argv[1]))));`, JSON.stringify(input)], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }))
}
describe('host-configured JavaScript module business acceptance', () => {
  it('executes independent exact JSON cases against synchronous and async exports', () => {
    const inspect = fixture('export function add(a,b){return a+b}; export async function receipt(id){return {id, accepted:true, details:null}}')
    expect(inspect({ exportName: 'add', args: [2, 3] })).toEqual(5)
    expect(inspect({ exportName: 'receipt', args: ['a'] })).toEqual({ id: 'a', accepted: true, details: null })
    // A wrong business implementation is observable by the same requirement-derived case.
    const broken = fixture('export function add(a,b){return a-b}')
    expect(broken({ exportName: 'add', args: [2, 3] })).not.toEqual(5)
  })
  it('rejects unknown exports, executable input fields, malformed cases and non-JSON results', () => {
    const inspect = fixture('export function invalid(){return undefined}; export function infinite(){return Infinity}; export function ok(){return true}')
    for (const input of [{ exportName: 'toString', args: [] }, { exportName: 'missing', args: [] }, { exportName: 'ok', args: [], code: 'process.exit(0)' }, { exportName: 'ok', args: {} }, { exportName: 'invalid', args: [] }, { exportName: 'infinite', args: [] }]) expect(() => inspect(input)).toThrow()
  })
  it('requires a configured normalized public module path', () => {
    expect(() => managedVerificationMethod('javascript-module@1')).toThrow('VERIFICATION_MODULE_ENTRY_REQUIRED')
    for (const entryPath of ['/tmp/module.mjs', '../module.mjs', 'a/../module.mjs', './module.mjs', 'a//module.mjs', 'a\\module.mjs', '.private/module.mjs', 'private/module.mjs', 'secrets/module.mjs', 'node_modules/a.mjs', 'candidate.mjs', 'module.ts', 'module.mjs?x', 'module%2fmjs']) expect(() => managedVerificationMethod('javascript-module@1', { entryPath })).toThrow('VERIFICATION_MODULE_ENTRY_INVALID')
  })
  it('exposes intake and requirement-derived verification cases without executable test code', () => {
    const method = managedVerificationMethod('javascript-module@1', { entryPath: 'index.js' })
    const schema = method.qualitySchema([{ id: 'requirement:sum', revision: 1 }]) as any
    expect(schema.properties.purpose.enum).toEqual(['intake', 'verification_design'])
    expect(schema.properties.cases.items.properties.criterion.enum).toEqual(['requirement:sum'])
    expect(schema.properties.cases.items.properties.inputJson).toEqual({ type: 'string' })
    expect(schema.properties.cases.items.properties.expectedJson).toEqual({ type: 'string' })
    expect(schema.properties.cases.items.additionalProperties).toBe(false)
    expect(schema.additionalProperties).toBe(false)
    expect(method.entry).toBe('candidate.mjs'); expect(method.exportName).toBe('inspect')
    expect(managedVerificationMethod('codex-runTurn-replay@1').id).toBe('codex-runTurn-replay@1')
  })
})

it('parses exact JSON wire cases and refuses malformed or executable case content', () => {
  const wire = { criterion: 'requirement:sum', inputJson: '{"exportName":"sum","args":[2,{"a":null}]}', expectedJson: '{"answer":2}' }
  expect(parseModuleVerificationCases([wire])).toEqual([{ criterion: 'requirement:sum', input: { exportName: 'sum', args: [2, { a: null }] }, expected: { answer: 2 } }])
  for (const bad of [null, {}, [{ ...wire, code: 'return true' }], [{ ...wire, inputJson: '{' }], [{ ...wire, expectedJson: 'NaN' }], [{ ...wire, expectedJson: '1e999' }], [{ ...wire, inputJson: '{"exportName":"sum","args":[],"path":"other.mjs"}' }], [{ ...wire, inputJson: '{"exportName":"sum","args":{}}' }], [{ ...wire, criterion: '' }]]) expect(() => parseModuleVerificationCases(bad)).toThrow()
})
