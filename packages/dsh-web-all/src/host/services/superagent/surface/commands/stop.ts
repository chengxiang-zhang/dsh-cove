/**
 * `stop C-n`: the person takes a promise back (02, 09).
 *
 * The command parses and reports; the release itself is the judgment module's host
 * path, injected as `release`, so a stop is the same write a fast-path release
 * makes rather than a second implementation of releasing. The four outcomes map
 * one-to-one onto the exit codes: a malformed id is an argument error, an unknown
 * promise has no data, an already closed one is a failure, a live one succeeds.
 */

import { EXIT_FAIL, EXIT_NODATA, EXIT_OK, usage, type CommandDeps, type CommandResult } from './index.ts'

/** A commitment id as people type it in chat. */
export const COMMITMENT_ID = /^C-\d+$/

export function stopCommand(deps: CommandDeps, args: string[]): CommandResult {
  const target = args[0]
  if (args.length !== 1 || target === undefined || !COMMITMENT_ID.test(target)) {
    return usage('用法: stop C-n', 'usage: stop C-n')
  }
  const outcome = deps.release(target)
  if (!outcome.ok && outcome.reason === 'missing') {
    return {
      json: { commitment: target, released: false, reason: 'missing' },
      text: `${target} 不存在`,
      exitCode: EXIT_NODATA,
    }
  }
  if (!outcome.ok) {
    return {
      json: { commitment: target, released: false, reason: outcome.reason ?? 'failed' },
      text: `${target} 已结束，不能再停`,
      exitCode: EXIT_FAIL,
    }
  }
  return { json: { commitment: target, released: true }, text: `${target} 已释放`, exitCode: EXIT_OK }
}