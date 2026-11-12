import { afterEach, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  cpSync,
  unlinkSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { createVerificationService } from '../src/host/services/superagent/verification/index.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'

import {
  verificationFixture as setup,
  verificationCleanup as clean
} from './fixtures/superagent/verification.ts'
afterEach(() => {
  for (const fn of clean.splice(0)) fn()
})

it('resolves the platform alias of its own scratch without reading data outside the candidate domain', async () => {
  const f = setup(`import {realpathSync,readFileSync} from 'node:fs';
    export function inspect(outside) {
      const cwd=realpathSync(process.cwd()), alias=cwd.replace(/^\\/private\\/var/, '/var').replace(/^\\/private\\/tmp/, '/tmp');
      let denied=false;try{readFileSync(outside)}catch{denied=true}
      return {sameScratch:realpathSync(alias)===cwd,outsideDenied:denied};
    }`)
  const outside = join(f.root, 'outside.txt'); writeFileSync(outside, 'synthetic outside data')
  const context = await f.service.sealVerificationContext({ candidate: f.candidate, qualification: f.qualification, cases: [{ criterion: 'requirement', input: outside, expected: { sameScratch: true, outsideDenied: true } }] })
  const evidence = await f.run(context)
  expect(f.ledger.get(evidence.id)?.data.complete, JSON.stringify(f.ledger.get(evidence.id)?.data)).toBe(true)
  const evaluation = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence])
  expect(f.ledger.get(evaluation.id)?.data.verdict).toBe('pass')
})

it('calibrates good, bad and missing evidence with an external collector', async () => {
  for (const [code, wanted] of [
    ['export function inspect(v) { return v }', 'pass'],
    ['export function inspect(v) { return "wrong" }', 'fail'],
    ['export function inspect(v) { process.exit(0) }', 'inconclusive']
  ] as const) {
    const f = setup(code),
      context = await f.seal()
    const evidence = await f.run(context)
    const evaluation = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [
      evidence
    ])
    expect(
      f.ledger.get(evaluation.id)?.data.verdict,
      JSON.stringify(f.ledger.get(evidence.id)?.data)
    ).toBe(wanted)
    expect(f.ledger.get(evidence.id)?.data.collector_pid).not.toBe(process.pid)
    expect(f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, []).id).not.toBe(
      evaluation.id
    )
  }
})

it('keeps assertions, fixture data and collected results outside candidate writes and rejects forged pass', async () => {
  const f = setup('export function inspect(v) { return v }')
  const targets = [join(f.root, 'assertion'), join(f.root, 'fixture'), join(f.root, 'results')]
  for (const path of targets) writeFileSync(path, 'sealed')
  writeFileSync(
    join(f.source, 'candidate.mjs'),
    `import {writeFileSync,chmodSync} from 'node:fs';
    export function inspect(v) {
      const observed = ${JSON.stringify(targets)}.map(p => { try { chmodSync(p,0o600); writeFileSync(p, 'forged-pass'); return 'changed' } catch { return 'denied' } });
      process.stderr.write(JSON.stringify({verdict:'pass',collector:true})); return observed;
    }`
  )
  const candidate = f.service.collectCandidate(f.assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const context = await f.service.sealVerificationContext({
    candidate,
    qualification: f.qualification,
    cases: [{ criterion: 'requirement', input: null, expected: 'expected' }]
  })
  const actualAssets = join(String(f.ledger.get(context.id)!.data.asset_root), 'cases.json')
  for (const alias of targets.slice(0, 2)) {
    unlinkSync(alias)
    symlinkSync(actualAssets, alias)
  }
  const before = targets.map((path) => readFileSync(path, 'utf8'))
  const evidence = await f.run(context)
  const evaluation = f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [
    evidence
  ])
  expect(f.ledger.get(evaluation.id)?.data.verdict).toBe('fail')
  expect(String(f.ledger.get(evidence.id)?.data.stdout)).toContain('denied')
  for (const [index, path] of targets.entries())
    expect(readFileSync(path, 'utf8')).toBe(before[index])
  expect(() =>
    f.ledger.transact(
      [],
      [{ kind: 'create', object: { ...f.ledger.get(evidence.id)!, id: 'forged-evidence' } }]
    )
  ).toThrow('VERIFICATION_HOST_REQUIRED')
})

it('executes the unchanged historical parser only in the candidate child', async () => {
  const f = setup()
  const historical = resolve('tests/fixtures/superagent/verification-parser-history')
  const provenance = JSON.parse(readFileSync(join(historical, 'provenance.json'), 'utf8'))
  for (const rel of [
    'host/services/external-session/providers/codex.ts',
    'core/external-session/errors.ts',
    'core/external-session/types.ts',
    'core/external-session/adapters.ts'
  ]) {
    const to = join(f.source, 'src', rel)
    mkdirSync(resolve(to, '..'), { recursive: true })
    const original = join(historical, 'src', rel)
    expect(createHash('sha256').update(readFileSync(original)).digest('hex')).toBe(
      provenance.sourceFiles.find((f: { path: string }) => f.path === 'src/' + rel).sha256
    )
    cpSync(original, to)
  }
  writeFileSync(
    join(f.source, 'candidate.mjs'),
    `import {createCodexAdapter} from './src/host/services/external-session/providers/codex.ts';
    export async function inspect(input) {
      const adapter=createCodexAdapter({process:{resolveExecutable:async()=>'/captured-cli-not-launched',spawn:()=>({
        done:Promise.resolve({exitCode:0,signal:null}),collected:{stdout:{readFrom:()=>({text:input,nextOffset:Buffer.byteLength(input),lossy:false})},stderr:{readFrom:()=>({text:'',nextOffset:0,lossy:false})}},
        terminate(){throw Error('unexpected cancellation')},waitForExit:async()=>true})},readTextFile:async()=>null,homeDir:process.cwd(),now:Date.now,cancelGraceMs:1000},{bin:'codex'});
      const outcome=await adapter.runTurn({prompt:'captured independent input',cwd:process.cwd()});
      return {status:outcome.status,result:outcome.result,providerSessionId:outcome.providerSessionId};
    }`
  )
  const candidate = f.service.collectCandidate(f.assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const stream = readFileSync(join(historical, 'captured-success.jsonl'), 'utf8')
  expect(createHash('sha256').update(stream).digest('hex')).toBe(provenance.captureSha256)
  const context = await f.service.sealVerificationContext({
    candidate,
    qualification: f.qualification,
    cases: [
      {
        criterion: 'requirement',
        input: stream,
        expected: {
          status: 'completed',
          result:
            'HTTP status 401 means authentication is required or the provided credentials are invalid.',
          providerSessionId: '01a1c89a-f4da-77f0-aa25-93460a297087'
        }
      }
    ]
  })
  const evidence = await f.run(context)
  expect(
    f.ledger.get(
      f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [evidence]).id
    )?.data.verdict,
    JSON.stringify(f.ledger.get(evidence.id)?.data)
  ).toBe('fail')
})

it('rejects a flood followed by valid-looking data instead of trusting a truncated tail', async () => {
  const f = setup(
    `export function inspect() { process.stdout.write('x'.repeat(2*1048576)); return 'expected' }`
  )
  const context = await f.seal(),
    evidence = await f.run(context)
  expect(f.ledger.get(evidence.id)?.data.complete).toBe(false)
  expect(
    f.ledger.get(
      f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence]).id
    )?.data.verdict
  ).toBe('inconclusive')
})

it('cannot run outside an admitted Action or replay a claimed verification context', async () => {
  const f = setup(),
    context = await f.seal()
  await expect(f.service.run(context, undefined as never)).rejects.toThrow(
    'VERIFICATION_ACTION_REQUIRED'
  )
  await f.run(context)
  await expect(f.run(context)).rejects.toThrow('VERIFICATION_RUN_ALREADY_CLAIMED')
})

it('real cancellation interrupts a busy candidate and never produces pass', async () => {
  const f = setup('export function inspect() { while(true) {} }'),
    context = await f.seal()
  const execution = f.admit(context),
    started = Date.now()
  const running = f.service.run(context, execution)
  const cancel = setTimeout(
    () => f.kernel.host.revokeControl(context, { id: 'host', revision: 1 }),
    150
  )
  try {
    const evidence = await running
    expect(Date.now() - started).toBeLessThan(1500)
    expect(f.ledger.get(evidence.id)?.data.complete).toBe(false)
  } finally {
    clearTimeout(cancel)
  }
})

it('retains real observations when qualification is revoked during execution', async () => {
  const f = setup(
      'export async function inspect(v) { await new Promise(r=>setTimeout(r,1500)); return v }'
    ),
    context = await f.seal()
  const running = f.run(context)
  const revoke = setTimeout(
    () =>
      f.service.revokeQualification(f.qualification, {
        reason: 'method compromised',
        evidenceRefs: ['review:counterexample'],
        reviewer: 'independent'
      }),
    150
  )
  try {
    const evidence = await running
    expect(f.ledger.get(evidence.id)?.data.complete).toBe(false)
    expect(f.ledger.applicability(evidence.id)).toBe('recheck_required')
  } finally {
    clearTimeout(revoke)
  }
})

it('rejects missing criteria, self-review and mutable symlink candidate inputs', async () => {
  const f = setup()
  await expect(f.seal([])).rejects.toThrow('CRITERION_COVERAGE_REQUIRED')
  expect(() =>
    f.service.registerAssignment({
      commitmentId: 'commitment',
      contract: { id: 'contract', revision: 1 },
      requirements: [{ id: 'requirement', revision: 1 }],
      generators: ['engineer'],
      reviewer: 'engineer'
    })
  ).toThrow('VERIFICATION_INDEPENDENCE_REQUIRED')
  symlinkSync('/etc/hosts', join(f.source, 'escape'))
  expect(() =>
    f.service.collectCandidate(f.assignment, {
      sourceRoot: f.source,
      entry: 'candidate.mjs',
      exportName: 'inspect',
      environment: 'node-local@1'
    })
  ).toThrow('CANDIDATE_UNSAFE_FILE')
})

it('denies host credentials, loopback connections and signalling the separate collector', async () => {
  let connections = 0
  const server = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('fixture listener required')
  const previous = process.env.P4_PRIVATE_CANARY
  process.env.P4_PRIVATE_CANARY = 'private-fixture-value'
  try {
    const f = setup(`import {readFileSync} from 'node:fs'; import {connect} from 'node:net';
      export async function inspect(input) {
        let read='denied', signal='denied';
        try { read=readFileSync(input.path,'utf8') } catch {}
        try { process.kill(process.ppid,'SIGKILL'); signal='sent' } catch {}
        const network=await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port:input.port});
          s.once('connect',()=>{s.destroy();resolve('connected')});s.once('error',()=>resolve('denied'))});
        return {read,signal,network,credential:process.env.P4_PRIVATE_CANARY??'absent'};
      }`)
    const secret = join(f.root, 'private-credential')
    writeFileSync(secret, 'private-fixture-value')
    const context = await f.seal([
      {
        criterion: 'requirement',
        input: { path: secret, port: address.port },
        expected: { read: 'denied', signal: 'denied', network: 'denied', credential: 'absent' }
      }
    ] as any)
    const evidence = await f.run(context)
    expect(
      f.ledger.get(
        f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence]).id
      )?.data.verdict
    ).toBe('pass')
    expect(connections).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.P4_PRIVATE_CANARY
    else process.env.P4_PRIVATE_CANARY = previous
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

it('rejects invalid UTF-8 instead of decoding attacker bytes into a passing replacement character', async () => {
  const f = setup(`export function inspect() {
    process.stdout.write(Buffer.concat([Buffer.from('{"id":0,"value":"'),Buffer.from([255]),Buffer.from('"}\\n')]));
    process.exit(0);
  }`)
  const context = await f.seal([{ criterion: 'requirement', input: '', expected: '\uFFFD' }])
  const evidence = await f.run(context)
  expect(f.ledger.get(evidence.id)?.data.complete).toBe(false)
  expect(
    f.ledger.get(
      f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence]).id
    )?.data.verdict
  ).toBe('inconclusive')
})
