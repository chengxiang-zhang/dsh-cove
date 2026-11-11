/**
 * What a message says: the templates from `09`, one row per moment.
 *
 * A template is data, not a decision: adding a moment means adding a row to
 * `TEMPLATES` and nothing else in this file, and the same table renders the same
 * words for every caller. The outlet decides *whether* a message goes out; this
 * module only decides what it looks like, so the model-supplied prose and the
 * fixed skeleton can never be confused for one another.
 *
 * Two rules are enforced here rather than at the outlet, because a template that
 * breaks them is a bug at the source: no rendered message exceeds the shared word
 * ceiling (N19), and no brief line exceeds fifteen words (`09`).
 *
 * Pure module: no clock, no store, no channel.
 */

import type { OutboxMoment } from '../protocol/objects.ts'
import { MAX_WORDS, countWords } from './words.ts'

/** The values a template may interpolate; every field is optional so one shape covers all moments. */
export interface TemplateData {
  /** `C-<n>`, so the boss can quote the commitment back. */
  commitmentId?: string
  /** How the request was understood, in the boss's own terms. */
  understanding?: string
  /** The calibrated estimate the acknowledgement promises. */
  etaMinutes?: number
  /** The single question an acknowledgement may carry instead of a closing line. */
  question?: string
  /** What happens when that question goes unanswered. */
  questionDefault?: string
  /** Whether the delivery was verified; `false` forces the honest prefix. */
  verified?: boolean
  /** What changed. */
  changed?: string
  /** What was run. */
  ran?: string
  /** The exit code the run left behind. */
  exitCode?: number | string
  /** The reading that proves the claim. */
  reading?: string
  /** The step a `cannot` stopped at. */
  step?: string
  /** What was already tried. */
  tried?: string
  /** What was already changed, and how it stands. */
  changes?: string
  /** The two directions a `cannot` offers; the first is the default. */
  directions?: readonly string[]
  /** Which direction happens when nobody answers. */
  directionDefault?: string
  /** The options an `ask` offers. */
  options?: readonly string[]
  /** Which option happens when nobody answers. */
  choiceDefault?: string
  /** Brief items, already ordered; overflow folds into one line. */
  items?: readonly string[]
  /** Body for the moments the model writes itself (`answer`, `alert`). */
  body?: string
}

/** One rendered message. */
export interface RenderedTemplate {
  text: string
  words: number
  expectsReply: boolean
}

/** Template failures: a template that cannot obey its own contract must not send. */
export class TemplateError extends Error {
  readonly code: 'TOO_LONG' | 'BRIEF_LINE_TOO_LONG' | 'TEMPLATE_MISSING'

  constructor(code: TemplateError['code'], message: string) {
    super(`${code}: ${message}`)
    this.name = 'TemplateError'
    this.code = code
  }
}

/** A brief shows at most six lines; the sixth is the overflow line. */
export const MAX_BRIEF_LINES = 6

/** A brief line may not exceed this many words, overflow included (`09`). */
export const MAX_BRIEF_LINE_WORDS = 15

type Builder = (data: TemplateData) => { text: string; expectsReply: boolean }

const DIRECTION_DEFAULT = '1'

/** The template row set. Add a row to add a moment's wording; nothing else changes. */
const TEMPLATES: Readonly<Partial<Record<OutboxMoment, Builder>>> = {
  ack: (data) => {
    const head = `接了 ${data.commitmentId ?? ''}：${data.understanding ?? ''}。预计 ${String(data.etaMinutes ?? 0)} 分钟。`
    if (data.question !== undefined && data.question !== '') {
      const fallback = data.questionDefault === undefined ? '' : `（不回按 ${data.questionDefault}）`
      return { text: `${head}先回答我：${data.question}${fallback}`, expectsReply: true }
    }
    return { text: `${head}不对就说。`, expectsReply: false }
  },
  deliver: (data) => {
    const prefix = data.verified === false ? '做完了，但没验证：' : ''
    const facts = [
      `改了 ${data.changed ?? ''}`,
      `跑了 ${data.ran ?? ''}`,
      `退出码 ${String(data.exitCode ?? '')}`,
      `读数 ${data.reading ?? ''}`,
    ]
    return { text: `${prefix}${facts.join('；')}。`, expectsReply: false }
  },
  cannot: (data) => {
    const directions = data.directions ?? []
    const first = directions[0] ?? '继续等'
    const second = directions[1] ?? '缩范围交付'
    const fallback = data.directionDefault ?? DIRECTION_DEFAULT
    return {
      text: `停在${data.step ?? ''}。已试过：${data.tried ?? ''}。改动：${data.changes ?? ''}。两个方向：1 ${first} 2 ${second}（不回按 ${fallback}）`,
      expectsReply: true,
    }
  },
  ask: (data) => {
    const options = (data.options ?? []).map((option, index) => `${index + 1} ${option}`).join(' ')
    const fallback = data.choiceDefault ?? DIRECTION_DEFAULT
    const body = options === '' ? `${data.question ?? ''}` : `${data.question ?? ''}：${options}`
    return { text: `${body}（不回按 ${fallback}）`, expectsReply: true }
  },
  brief: (data) => {
    const items = data.items ?? []
    const lines: string[] = []
    const shown = items.length > MAX_BRIEF_LINES ? MAX_BRIEF_LINES - 1 : items.length
    for (let index = 0; index < shown; index += 1) lines.push(`${index + 1} ${items[index]}`)
    if (items.length > MAX_BRIEF_LINES) lines.push(`另有 ${items.length - shown} 件，回"全部"展开`)
    for (const line of lines) {
      if (countWords(line) > MAX_BRIEF_LINE_WORDS) {
        throw new TemplateError('BRIEF_LINE_TOO_LONG', `brief line is over ${MAX_BRIEF_LINE_WORDS} words: ${line}`)
      }
    }
    return { text: lines.join('\n'), expectsReply: false }
  },
  alert: (data) => ({ text: `告警：${data.body ?? ''}`, expectsReply: false }),
  answer: (data) => ({ text: data.body ?? '', expectsReply: false }),
}

/**
 * Render one moment.
 *
 * `pushback` has no row on purpose: `02` says that moment never goes through
 * `say`, it is produced by the pushback tool, so asking for it here is an error
 * rather than an empty message.
 * @param moment - the moment the outlet is about to send.
 * @param data - the values the row interpolates.
 * @returns the rendered text, its word count, and whether it asks a question.
 * @throws TemplateError `TEMPLATE_MISSING` when the moment has no row,
 *   `BRIEF_LINE_TOO_LONG` when a brief line is too long, `TOO_LONG` when the
 *   rendered message exceeds the shared ceiling.
 */
export function render(moment: OutboxMoment, data: TemplateData): RenderedTemplate {
  const builder = TEMPLATES[moment]
  if (builder === undefined) {
    throw new TemplateError('TEMPLATE_MISSING', `${moment} has no template; it does not go through say`)
  }
  const built = builder(data)
  const words = countWords(built.text)
  if (words > MAX_WORDS) {
    throw new TemplateError('TOO_LONG', `${moment} rendered ${String(words)} words, over ${String(MAX_WORDS)}`)
  }
  return { text: built.text, words, expectsReply: built.expectsReply }
}
export interface WorkReportFacts {
  question?: { ref: string; text: string }
  progress?: { ref: string; state: string; toolCalls: number }
}

/** Work reports are rendered from host state. Model prose cannot carry achievement claims. */
export function renderWorkReport(moment: OutboxMoment, state: string, delivery?: import('../protocol/delivery.ts').DeliveryEvaluation, commitmentId?: string, facts?: WorkReportFacts): string {
  if (delivery?.verdict === 'pass' && delivery.receipt) {
    const r = delivery.receipt
    return `已核对本地 dev 提交 ${r.commit}，交付范围、文件模式、工作树及暂存区与验收版本一致。未推送，未上线。`
  }
  if (moment === 'ack' && commitmentId) return `接了 ${commitmentId}，正在处理；尚未完成验收与交付。`
  if (moment === 'ask' && facts?.question) return `待确认的问题（${facts.question.ref}）：${JSON.stringify(facts.question.text)}。这是一项待决问题，尚未完成验收与交付。`
  if (moment !== 'ask' && facts?.progress) return `执行 ${facts.progress.ref} 当前状态：${facts.progress.state}；已观察到 ${facts.progress.toolCalls} 次工具调用。尚无完整验收与本地交付证据。`
  if (moment === 'ask') return '需要你确认此事项下一步的目标或约束；当前尚无完整验收与本地交付证据。'
  if (['broken', 'at_risk', 'released', 'withdrawn'].includes(state)) return '此事项当前未完成验收与交付，需要调整下一步安排。'
  return '此事项仍在处理中；尚无完整验收与本地交付证据，不能报告完成或测试通过。'
}
