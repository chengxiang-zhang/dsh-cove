import { hostProgramAsset } from './host-program-assets.ts'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { CollectorObservation, VerificationCase } from '../protocol/verification.ts'
import { COLLECT_PROGRAM, PREPARE_PROGRAM, CANDIDATE_PROGRAM } from './verification-programs.ts'

const digest = (v: Buffer | string) => createHash('sha256').update(v).digest('hex')

function program(
  source: string,
  input: unknown,
  timeoutMs: number,
  liveFence?: () => boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(realpathSync(process.execPath), ['--input-type=module', '-e', source], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...(process.env.DSH_QA_SANDBOX_BROKER ? { DSH_QA_SANDBOX_BROKER: process.env.DSH_QA_SANDBOX_BROKER, DSH_QA_SANDBOX_PROFILE: process.env.DSH_QA_SANDBOX_PROFILE ?? '' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0,
      stderr = '',
      failed = false
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      child.kill('SIGTERM')
    }
    const monitor = liveFence
      ? setInterval(() => {
          try {
            if (!liveFence()) stop()
          } catch {
            stop()
          }
        }, 25)
      : undefined
    const timer = setTimeout(() => {
      failed = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 8 * 1048576) stdoutChunks.push(chunk)
      if (stdoutBytes > 8 * 1048576) {
        failed = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      clearInterval(monitor)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearInterval(monitor)
      if (failed || code !== 0) reject(new Error(`VERIFICATION_PROCESS_FAILED: ${stderr}`))
      else {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks)))
        } catch {
          reject(new Error('COLLECTOR_INVALID_UTF8'))
        }
      }
    })
    child.stdin.on('error', () => {
      failed = true
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export async function prepareVerificationAssets(
  path: string,
  cases: VerificationCase[]
): Promise<number> {
  const response = JSON.parse(await program(PREPARE_PROGRAM, { path, cases }, 5000))
  if (!Number.isSafeInteger(response.pid) || response.pid === process.pid)
    throw new Error('ASSET_PREPARER_REQUIRED')
  return response.pid
}

export interface VerificationLaunch {
  root: string
  entry: string
  exportName: string
  assets: string
  assetDigest: string
  manifest: { path: string; digest: string }[]
  runId: string
  scratch: string
  wrapper: string
  timeoutMs: number
}

export const verificationProcessLaunch = () => ({
  executable: realpathSync(process.execPath),
  args: ['--input-type=module', '-e', COLLECT_PROGRAM],
  processPolicy: 'single' as const
})

export function verificationRuntimeDigest(): string {
  return digest(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      executable: realpathSync(process.execPath),
      binary: digest(readFileSync(process.execPath)),
      collector: digest(COLLECT_PROGRAM),
      wrapper: digest(CANDIDATE_PROGRAM),
      launcher: digest(collectVerification.toString())
    })
  )
}

/** Fixed, offline, single-process method. No caller profile, credential or network option. */
export async function collectVerification(
  launch: VerificationLaunch,
  liveFence: () => boolean
): Promise<{ observation: CollectorObservation; digest: string }> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new Error('VERIFICATION_ISOLATION_UNAVAILABLE')
  const root = realpathSync(launch.root),
    scratch = realpathSync(launch.scratch),
    wrapper = realpathSync(launch.wrapper)
  if (root !== launch.root || scratch !== launch.scratch || wrapper !== launch.wrapper)
    throw new Error('VERIFICATION_PATH_IDENTITY')
  const executable = realpathSync(process.execPath),
    lit = JSON.stringify
  const ancestors = new Set<string>()
  for (const leaf of [root, scratch, wrapper, executable]) {
    let parent = dirname(leaf)
    while (parent !== '/') {
      ancestors.add(parent)
      parent = dirname(parent)
    }
  }
  const metadata = `(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${lit(path)})`).join(' ')})`
  const profile = `(version 1)(deny default)${metadata}(allow process-exec process-info*)(allow sysctl-read)(allow mach-lookup (global-name "com.apple.system.logger"))(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal ${lit(executable)}) (literal ${lit(wrapper)}) (subpath ${lit(root)}) (subpath ${lit(scratch)}))(allow file-write* (subpath ${lit(scratch)}) (literal "/dev/null"))`
  if (digest(readFileSync(launch.assets)) !== launch.assetDigest)
    throw new Error('SEALED_ASSETS_CHANGED')
  if (!liveFence()) throw new Error('VERIFICATION_EXECUTION_FENCED')
  const raw = await program(
    COLLECT_PROGRAM,
    { ...launch, executable, profile, ...(process.env.DSH_QA_SANDBOX_BROKER ? { launchPortModule: pathToFileURL(hostProgramAsset('broker')).href } : {}) },
    launch.timeoutMs + 2000,
    liveFence
  )
  const observation = JSON.parse(raw) as CollectorObservation
  if (
    observation.run_id !== launch.runId ||
    !Number.isSafeInteger(observation.collector_pid) ||
    !Array.isArray(observation.results)
  )
    throw new Error('COLLECTOR_PROTOCOL')
  return { observation, digest: digest(raw) }
}
