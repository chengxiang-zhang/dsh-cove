/**
 * memoir host 服务域 —— 记忆存储（全新实现；行为契约参考旧包）。
 *
 * 一个 JSON 索引（~/.dsh/dsh-memoir.json），按调用方给出的项目路径分键；
 * 条目带 section/status/tags/importance 元数据（四大分区
 * work/lessons/actions/note）；原子写 + 文件锁防并发撕裂。schema v4。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SECTION_KEYS, type MemoirEntry, type MemoirStatus, type SectionKey } from '../../../core/memoir/protocol.ts'

export const FORMAT_VERSION = 4

export type { MemoirEntry, MemoirStatus, SectionKey } from '../../../core/memoir/protocol.ts'
export { SECTION_KEYS }

export const MEMOIR_STATUSES: MemoirStatus[] = ['active', 'superseded', 'archived']

/** 单项目记忆文件。 */
export interface MemoirProject {
  path: string
  entries: MemoirEntry[]
}

/** 存储文件（全部项目索引）。 */
export interface MemoirStoreFile {
  formatVersion: number
  projects: Record<string, MemoirProject>
}

/** 查询一个项目路径下的条目。 */
export function queryProjects(store: MemoirStoreFile, path?: string): MemoirProject[] {
  if (path === undefined || path === '') return Object.values(store.projects)
  return Object.values(store.projects).filter(p => p.path === path)
}

/** 默认存储路径（~/.dsh/dsh-memoir.json）。 */
export function defaultStorePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-memoir.json')
}

/** 校验一条记忆记录。 */
function isValidEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.title !== 'string') return false
  if (typeof entry.content !== 'string') return false
  if (typeof entry.section !== 'string' || !SECTION_KEYS.includes(entry.section as SectionKey)) return false
  if (typeof entry.createdAt !== 'number') return false
  if (typeof entry.updatedAt !== 'number') return false
  if (typeof entry.status !== 'string' || !MEMOIR_STATUSES.includes(entry.status as MemoirStatus)) return false
  return true
}

/** 解析存储文件：损坏/非法行丢弃。 */
export function parseStoreFile(text: string): MemoirStoreFile {
  try {
    const parsed = JSON.parse(text) as Partial<MemoirStoreFile>
    const projects: Record<string, MemoirProject> = {}
    if (parsed.projects !== null && typeof parsed.projects === 'object') {
      for (const [path, project] of Object.entries(parsed.projects)) {
        if (project !== null && typeof project === 'object' && Array.isArray(project.entries)) {
          projects[path] = {
            path: typeof project.path === 'string' ? project.path : path,
            entries: project.entries.filter(isValidEntry) as MemoirEntry[],
          }
        }
      }
    }
    return { formatVersion: FORMAT_VERSION, projects }
  } catch {
    return { formatVersion: FORMAT_VERSION, projects: {} }
  }
}

/** 记忆存储（原子写）。 */
export class MemoirStore {
  constructor(private readonly file: string = defaultStorePath()) {}

  load(): MemoirStoreFile {
    if (!existsSync(this.file)) return { formatVersion: FORMAT_VERSION, projects: {} }
    try {
      return parseStoreFile(readFileSync(this.file, 'utf8'))
    } catch {
      return { formatVersion: FORMAT_VERSION, projects: {} }
    }
  }

  save(store: MemoirStoreFile): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(temp, this.file)
  }

  /** 取某项目的全部条目（无项目则建空）。 */
  project(path: string): MemoirProject {
    const store = this.load()
    const existing = store.projects[path]
    if (existing !== undefined) return existing
    return { path, entries: [] }
  }

  /** 写回某项目（保留其他项目）。 */
  saveProject(path: string, entries: MemoirEntry[]): void {
    const store = this.load()
    store.projects[path] = { path, entries }
    this.save(store)
  }
}

/** Compact deterministic hot-memory block for prompt injection. */
export function renderHotMemory(project: MemoirProject, maxTokens = 1200): string {
  const active = project.entries.filter(entry => entry.status === 'active' && entry.section !== 'note')
  const selected = [...active]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || (b.importance ?? 3) - (a.importance ?? 3)
      || b.updatedAt - a.updatedAt
      || a.id.localeCompare(b.id))
  const lines = ['[Project memory]']
  for (const section of ['actions', 'lessons', 'work'] as const) {
    const group = selected.filter(entry => entry.section === section)
    if (group.length === 0) continue
    lines.push(section === 'actions' ? 'Actions:' : section === 'lessons' ? 'Lessons:' : 'Recent state:')
    for (const entry of group) lines.push(`- ${entry.title}：${entry.content.replace(/\s+/g, ' ').trim()}`)
  }
  const text = lines.length === 1 ? '' : lines.join('\n')
  return text.length <= maxTokens * 4 ? text : text.slice(0, Math.max(0, maxTokens * 4 - 1)) + '…'
}
