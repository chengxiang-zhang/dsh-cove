/**
 * `brief --now`: build today's briefing immediately and submit it (02, 09, 23).
 *
 * Nothing about the briefing lives here: the timing module builds and submits it,
 * and this command only insists on the one flag that distinguishes "now" from the
 * daily schedule. No content is "no data", not an empty message: sending an empty
 * brief would be noise, which is the failure this project exists to avoid.
 */

import { EXIT_NODATA, EXIT_OK, usage, type CommandDeps, type CommandResult } from './index.ts'

export async function briefCommand(deps: CommandDeps, args: string[]): Promise<CommandResult> {
  if (args.length !== 1 || args[0] !== '--now') return usage('用法: brief --now', 'usage: brief --now')
  const brief = await deps.briefNow()
  if (brief === null) {
    return { json: { brief: null, reason: 'nothing-to-say' }, text: '今天没有要说的', exitCode: EXIT_NODATA }
  }
  return { json: { brief: brief.body, items: brief.items }, text: brief.body, exitCode: EXIT_OK }
}