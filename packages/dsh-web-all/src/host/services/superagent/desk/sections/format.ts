/**
 * Formatting helpers shared by the dossier sections (T11).
 *
 * A section renders one block of the dossier: a label, then one line per fact.
 * Everything here is pure and clock-injected — the caller passes `nowMs` and the
 * desk time zone, so the same ledger snapshot always renders the same text.
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** Width the Chinese section labels are padded to, matching the 07 layout. */
export const LABEL_WIDTH = 12

interface Parts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  weekday: number
}

function partsOf(ms: number, tz: string): Parts {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) throw new TypeError(`format: ${String(ms)} is not a valid epoch millisecond`)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const found: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') found[part.type] = part.value
  }
  const weekdayName = found.weekday ?? 'Sun'
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName)
  return {
    year: found.year ?? '0000',
    month: found.month ?? '00',
    day: found.day ?? '00',
    hour: found.hour === '24' ? '00' : (found.hour ?? '00'),
    minute: found.minute ?? '00',
    weekday: weekday < 0 ? 0 : weekday,
  }
}

/** `HH:mm` in the desk time zone. */
export function clock(ms: number, tz: string): string {
  const parts = partsOf(ms, tz)
  return `${parts.hour}:${parts.minute}`
}

/** `MM-DD HH:mm` in the desk time zone. */
export function stamp(ms: number, tz: string): string {
  const parts = partsOf(ms, tz)
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** `YYYY-MM-DD 周X HH:mm` — the dossier header timestamp. */
export function fullStamp(ms: number, tz: string): string {
  const parts = partsOf(ms, tz)
  return `${parts.year}-${parts.month}-${parts.day} ${WEEKDAYS[parts.weekday]} ${parts.hour}:${parts.minute}`
}

/** Pads a Chinese label to the fixed column, counting each character as one cell. */
export function label(text: string): string {
  return text.length >= LABEL_WIDTH ? text : text + ' '.repeat(LABEL_WIDTH - text.length)
}

/** Renders one labelled block: the label then the first line, continuation lines aligned. */
export function block(name: string, lines: readonly string[]): string {
  if (lines.length === 0) return `${name}（无）`
  const prefix = label(name)
  const indent = ' '.repeat(LABEL_WIDTH)
  return lines
    .map((line, index) => (index === 0 ? prefix + line : indent + line))
    .join('\n')
}