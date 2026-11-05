/**
 * `doc add <path>` and `doc list [q]`: a person registering and finding handoff
 * documents (02, 05).
 *
 * `doc add` is one of the two writers of the index and the only human one; the
 * host registers a closure product itself, and the model has no path in. The path
 * is checked here because a path that does not exist is an argument error, not a
 * policy failure: the insert would otherwise succeed and leave an index entry that
 * cannot be read.
 *
 * An empty `list` is "no data", not success with an empty table: `status` is the
 * command whose empty answer is meaningful.
 */

import { statSync } from 'node:fs'
import { EXIT_NODATA, EXIT_OK, EXIT_USAGE, usage, type CommandDeps, type CommandResult } from './index.ts'

/** Whether `path` is an existing regular file; a stat failure is a usage error. */
function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const USAGE = '用法: doc add <path> | doc list [q]'

export function docCommand(deps: CommandDeps, args: string[]): CommandResult {
  const [sub, ...rest] = args
  if (sub === 'add') {
    if (rest.length !== 1) return usage(USAGE, 'usage: doc add <path>')
    const path = rest[0]
    if (!isReadableFile(path)) {
      return { json: { error: 'path-not-found', path }, text: `文件不存在: ${path}`, exitCode: EXIT_USAGE }
    }
    const docId = deps.docs.add(path)
    return { json: { doc_id: docId, path, added_by: 'human' }, text: `已登记 ${docId} · ${path}`, exitCode: EXIT_OK }
  }
  if (sub === 'list') {
    if (rest.length > 1) return usage(USAGE, 'usage: doc list [q]')
    const docs = deps.docs.list(rest[0])
    if (docs.length === 0) {
      return { json: { docs: [] }, text: '没有匹配的文档', exitCode: EXIT_NODATA }
    }
    const text = docs.map((doc) => `${doc.doc_id} · ${doc.kind} · ${doc.title} · ${doc.path}`).join('\n')
    return { json: { docs }, text, exitCode: EXIT_OK }
  }
  return usage(USAGE, 'usage: doc add <path> | doc list [q]')
}