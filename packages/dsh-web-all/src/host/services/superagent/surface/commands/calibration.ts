/**
 * `calibration`: the work-class readout of `06`, unchanged (02, 06).
 *
 * The query is the last line of `06`'s readout section, verbatim: classes with
 * samples, most sampled first. Calibration is data the rules module writes, so the
 * command reads the table and renders it; it never recomputes a factor, because a
 * second formula would be a second source of truth.
 */

import type { LedgerReader } from '../../protocol/db.ts'
import { EXIT_NODATA, EXIT_OK, usage, type CommandDeps, type CommandResult } from './index.ts'

export interface CalibrationRow {
  class_id: string
  samples: number
  eta_factor: number
  ask_mode: string
  pushback_mode: string
  preferred_executor: string | null
}

/** `06` readout: `SELECT class_id, samples, eta_factor, ... WHERE samples > 0 ORDER BY samples DESC`. */
export const CALIBRATION_SQL = `SELECT class_id, samples, round(eta_factor, 2) AS eta_factor, ask_mode,
    pushback_mode, preferred_executor
  FROM sa_work_class WHERE samples > 0 ORDER BY samples DESC, class_id ASC`

function renderText(rows: CalibrationRow[]): string {
  return rows
    .map((row) => `${row.class_id} · ${row.samples} 次 · ETA x${row.eta_factor} · 问法 ${row.ask_mode}`
      + ` · ${row.pushback_mode === 'on' ? '会顶回' : '不顶回'} · ${row.preferred_executor ?? '未定执行体'}`)
    .join('\n')
}

export function calibrationCommand(deps: CommandDeps, args: string[]): CommandResult {
  if (args.some((arg) => arg !== '--json')) return usage('用法: calibration [--json]', 'usage: calibration [--json]')
  const rows = deps.read.all<CalibrationRow>(CALIBRATION_SQL)
  if (rows.length === 0) {
    return { json: { work_classes: [] }, text: '还没有样本', exitCode: EXIT_NODATA }
  }
  return { json: { work_classes: rows }, text: renderText(rows), exitCode: EXIT_OK }
}

/** Re-exported for the readout tests: the same rows without the command wrapper. */
export function readCalibration(read: LedgerReader): CalibrationRow[] {
  return read.all<CalibrationRow>(CALIBRATION_SQL)
}