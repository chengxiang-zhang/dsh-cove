/**
 * memoir host 服务域 —— agent 工具层（全新实现；行为契约参考旧包）。
 *
 * 工具名冻结：memoir_record / memoir_read / memoir_update。用 SDK
 * defineTool；text 渲染与参数 schema 保持旧包可感知形状。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MemoirStore, type MemoirEntry, type SectionKey } from './store.ts'
import type { MemoirSettings } from './settings.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

const SECTIONS: SectionKey[] = ['work', 'lessons', 'actions', 'note']

/** 单条目渲染。 */
function renderEntry(entry: MemoirEntry): string {
  return `[${entry.id}] (${entry.section}/${entry.status}${entry.pinned ? '/pinned' : ''}) ${entry.title}\n${entry.content}`
}

export function memoirRecordTool(store: MemoirStore) {
  return defineTool({
    name: 'memoir_record',
    description: 'Record a durable memory entry into the current project memory store. ' +
      'Sections: work (what was done), lessons (pitfalls/experience), actions (next-step guidance), note. ' +
      'Use when the user completes a phase of work, hits a pitfall, or defines a convention worth persisting.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project/repository path the memory belongs to.' },
      section: { type: 'string', required: true, enum: SECTIONS, description: 'Memory category.' },
      title: { type: 'string', required: true, description: 'One-line summary title.' },
      content: { type: 'string', required: true, description: 'The memory body.' },
      importance: { type: 'integer', description: 'Importance 1-5 (default 3).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional search tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          entry: { type: 'string', required: true },
        },
      },
      render: (_args, value: { ok: boolean; id: string; entry: string }) => text(value.entry),
    },
    async execute(args) {
      const now = Date.now()
      const entry: MemoirEntry = {
        id: `m-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: args.title.trim(),
        content: args.content.trim(),
        section: args.section,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        importance: typeof args.importance === 'number' ? Math.min(5, Math.max(1, args.importance)) : 3,
        ...(Array.isArray(args.tags) ? { tags: args.tags.filter((t): t is string => typeof t === 'string') } : {}),
      }
      const project = store.project(args.path)
      project.entries.push(entry)
      store.saveProject(args.path, project.entries)
      return { ok: true, id: entry.id, entry: renderEntry(entry) }
    },
  })
}

export function memoirReadTool(store: MemoirStore, settings: () => MemoirSettings) {
  return defineTool({
    name: 'memoir_read',
    description: 'Read the project memory entries for a path, optionally filtered by section and query.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project/repository path.' },
      section: { type: 'string', enum: SECTIONS, description: 'Optional section filter.' },
      query: { type: 'string', description: 'Optional keyword filter against title/content.' },
      limit: { type: 'integer', description: 'Max entries to return (default from settings).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { entries: string; count: number }) => text(value.entries),
    },
    async execute(args) {
      const project = store.project(args.path)
      const needle = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const limit = typeof args.limit === 'number' ? args.limit : settings().readDefaultLimit
      const filtered = project.entries
        .filter(e => e.status !== 'archived')
        .filter(e => args.section === undefined || e.section === args.section)
        .filter(e => needle === '' || e.title.toLowerCase().includes(needle) || e.content.toLowerCase().includes(needle))
        .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3))
        .slice(0, limit)
      return { entries: filtered.length === 0 ? '(no matching entries)' : filtered.map(renderEntry).join('\n\n'), count: filtered.length }
    },
  })
}

export function memoirUpdateTool(store: MemoirStore) {
  return defineTool({
    name: 'memoir_update',
    description: 'Update an existing memory entry (title/content/section/status/pinned/importance) by id.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project/repository path.' },
      id: { type: 'string', required: true, description: 'Entry id (from memoir_read).' },
      title: { type: 'string', description: 'New title.' },
      content: { type: 'string', description: 'New content.' },
      section: { type: 'string', enum: SECTIONS, description: 'New section.' },
      status: { type: 'string', enum: ['active', 'superseded', 'archived'], description: 'New status.' },
      pinned: { type: 'boolean', description: 'Pin toggle.' },
      importance: { type: 'integer', description: 'Importance 1-5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          entry: { type: 'string', required: true },
        },
      },
      render: (_args, value: { ok: boolean; id: string; entry: string }) => text(value.entry),
    },
    async execute(args) {
      const project = store.project(args.path)
      const entry = project.entries.find(e => e.id === args.id)
      if (entry === undefined) return { ok: false, id: args.id, entry: `entry not found: ${args.id}` }
      if (typeof args.title === 'string' && args.title.trim() !== '') entry.title = args.title.trim()
      if (typeof args.content === 'string' && args.content.trim() !== '') entry.content = args.content.trim()
      if (typeof args.section === 'string' && SECTIONS.includes(args.section as SectionKey)) entry.section = args.section as SectionKey
      if (typeof args.status === 'string' && ['active', 'superseded', 'archived'].includes(args.status)) entry.status = args.status as MemoirEntry['status']
      if (typeof args.pinned === 'boolean') entry.pinned = args.pinned
      if (typeof args.importance === 'number') entry.importance = Math.min(5, Math.max(1, args.importance))
      entry.updatedAt = Date.now()
      store.saveProject(args.path, project.entries)
      return { ok: true, id: entry.id, entry: renderEntry(entry) }
    },
  })
}

/** 全部 memoir agent 工具。 */
export function makeMemoirTools(store: MemoirStore, settings: () => MemoirSettings) {
  return [
    memoirRecordTool(store),
    memoirReadTool(store, settings),
    memoirUpdateTool(store),
  ]
}

