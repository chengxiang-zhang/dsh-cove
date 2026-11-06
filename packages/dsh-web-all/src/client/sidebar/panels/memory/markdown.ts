/**
 * 极简 Markdown 分块器（零依赖、纯函数）。
 *
 * 记忆文档是 OpenViking 里的 Markdown / 纯文本，产品面只需要「按块排版」：
 * 标题、段落、列表、代码围栏、引用。这里刻意不引入 Markdown 依赖，也不做
 * 行内语法（粗体、链接、行内代码保持原文），因为面板从不写 `innerHTML`：
 * 每个块都由 React 以纯文本渲染，任何 `<script>` 之类的内容只会显示成字面量。
 *
 * 支持的块级规则（CommonMark 的常用子集）：
 * - 围栏代码：行首 0-3 个空格的 ``` 或 ~~~，可带语言标记；未闭合时延续到文末；
 * - ATX 标题：1-6 个 `#`，去掉结尾的装饰性 `#`；
 * - 分隔线：`---` / `***` / `___`（含空格变体）只断开段落，不产出块；
 * - 引用：连续的 `>` 行合成一个块，保留行内换行；
 * - 列表：同一层级的连续 `-` / `*` / `+` 或 `1.` / `1)` 行；缩进续行并入上一项，
 *   更深层的嵌套标记按纯文本处理（面板不做嵌套列表）；
 * - 其余非空行合成段落，保留换行（`white-space: pre-wrap`）。
 */

/** 一个块级元素。 */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; text: string }

/** 围栏起始行：0-3 个空格 + 三个以上同类标记 + 可选语言。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/u
/** ATX 标题起始行。 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u
/** 分隔线（在列表之前判定：`- - -` 是分隔线而不是列表）。 */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u
/** 引用行。 */
const QUOTE = /^ {0,3}>[ \t]?(.*)$/u
/** 无序列表项。 */
const UNORDERED = /^ {0,3}[-*+][ \t]+(.*)$/u
/** 有序列表项。 */
const ORDERED = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/u
/** 列表项续行：至少两个空格或一个制表符起头。 */
const CONTINUATION = /^(?: {2,}|\t)/u

/** 这一行是否会开启一个新块（用于判定列表续行是否已经结束）。 */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
}

/** `line` 是否是关闭 `marker` 的围栏行（同字符、不短于开启标记、无其他内容）。 */
function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed[0] !== marker[0]) return false
  let length = 0
  while (length < trimmed.length && trimmed[length] === marker[0]) length += 1
  return length >= marker.length && trimmed.slice(length).trim() === ''
}

/** 去掉标题结尾的装饰性 `#`（必须由空白分隔，`C#` 这种不算）。 */
function headingText(raw: string): string {
  return raw.replace(/[ \t]+#+[ \t]*$/u, '').trim()
}

/**
 * 把 Markdown 原文切成块。
 *
 * @param source - 原文；`\r\n` / `\r` 会先归一成 `\n`。
 * @returns 块序列；空输入返回空数组。
 */
export function splitMarkdownBlocks(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  // 末尾换行是最后一行的行终止符，不是多出来的一行空内容：不剥掉它，未闭合
  // 代码块会在正文尾部凭空多一个换行。
  if (normalized.endsWith('\n')) lines.pop()
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    // 围栏代码：吃到关闭围栏或文末。
    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1] ?? '```'
      const language = (fence[2] ?? '').trim()
      const body: string[] = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        if (closesFence(lines[cursor] ?? '', marker)) break
        body.push(lines[cursor] ?? '')
      }
      // 未闭合时 `cursor` 停在文末，正文已经收全。
      index = cursor
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    // ATX 标题。
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: headingText(heading[2] ?? '') })
      continue
    }

    // 分隔线：只断开段落，不占一块。
    if (RULE.test(line)) {
      flushParagraph()
      continue
    }

    // 引用：连续 `>` 行合成一块。
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      const parts: string[] = []
      let cursor = index
      for (; cursor < lines.length; cursor += 1) {
        const match = QUOTE.exec(lines[cursor] ?? '')
        if (match === null) break
        parts.push((match[1] ?? '').trimEnd())
      }
      index = cursor - 1
      const text = parts.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
      if (text !== '') blocks.push({ kind: 'quote', text })
      continue
    }

    // 列表：同层级连续项，缩进续行并入上一项。
    const unordered = UNORDERED.exec(line)
    const ordered = ORDERED.exec(line)
    if (unordered !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      const items: string[] = []
      let cursor = index
      for (; cursor < lines.length; cursor += 1) {
        const current = lines[cursor] ?? ''
        const item = isOrdered ? ORDERED.exec(current) : UNORDERED.exec(current)
        if (item !== null) {
          items.push((item[1] ?? '').trim())
          continue
        }
        const isContinuation = CONTINUATION.test(current) && current.trim() !== '' && !startsBlock(current)
        if (isContinuation && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''}\n${current.trim()}`
          continue
        }
        break
      }
      index = cursor - 1
      if (items.length > 0) blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    // 空行：断开段落。
    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    // 其余：段落行。
    paragraph.push(line.trimEnd())
  }

  flushParagraph()
  return blocks
}