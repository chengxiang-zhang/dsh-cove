import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

// These two closed bundles are host programs, never candidate-selected modules.
const bundles = {
  delivery: ['verification/delivery-keeper-check.ts', 'executors/project-keeper.ts', 'executors/project-keeper-fixture-client.ts'],
  keeperFixture: ['executors/project-keeper-fixture-server.ts', 'executors/project-keeper.ts'],
  broker: ['kernel/sandbox-launch-port.ts', 'kernel/sandbox-wire.ts', 'kernel/sandbox-policy.ts'],
} as const
const cache = new Map<keyof typeof bundles, { entry: string; files: { path: string; digest: string }[] }>()
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Node refuses raw TS in installed dependencies; copy the fixed TCB outside node_modules. */
export function hostProgramAsset(kind: keyof typeof bundles): string {
  const old = cache.get(kind)
  if (old) {
    if (old.files.some(file => digest(readFileSync(file.path)) !== file.digest)) throw Error('HOST_PROGRAM_ASSET_CHANGED')
    return old.entry
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-tcb-'))), files: { path: string; digest: string }[] = []
  for (const relative of bundles[kind]) {
    const source = createRequire(import.meta.url).resolve('@dsh-cove/dsh-web-all/src/host/services/superagent/' + relative)
    const bytes = readFileSync(source), path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 }); files.push({ path, digest: digest(bytes) })
  }
  for (const directory of new Set(files.map(file => dirname(file.path)))) chmodSync(directory, 0o500)
  chmodSync(root, 0o500)
  const entry = files[0]!.path; cache.set(kind, { entry, files }); return entry
}
