// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffView, parseUnifiedDiff, untrackedFile } from '../src/client/sidebar/diff-view.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const SIMPLE = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@ section',
  ' one',
  '-two',
  '+two changed',
  ' three',
  '\\ No newline at end of file',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses files, hunks, gutters and no-newline meta rows', () => {
    const { files } = parseUnifiedDiff(SIMPLE)
    expect(files).toHaveLength(1)
    const file = files[0]!
    expect(file.oldPath).toBe('a/a.ts')
    expect(file.newPath).toBe('b/a.ts')
    expect(file.binary).toBe(false)
    const hunk = file.hunks[0]!
    expect(hunk.oldStart).toBe(1)
    expect(hunk.newStart).toBe(1)
    expect(hunk.header).toBe(' section')
    expect(hunk.lines.map(line => line.kind)).toEqual(['ctx', 'del', 'add', 'ctx', 'meta'])
    expect(hunk.lines[1]).toMatchObject({ kind: 'del', text: 'two', oldNum: 2, newNum: null })
    expect(hunk.lines[2]).toMatchObject({ kind: 'add', text: 'two changed', oldNum: null, newNum: 2 })
    expect(hunk.lines[4]).toMatchObject({ kind: 'meta', text: ' No newline at end of file' })
  })

  it('skips index/mode noise and keeps mode-only changes hunkless', () => {
    const { files } = parseUnifiedDiff([
      'diff --git a/x.sh b/x.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n'))
    expect(files).toHaveLength(1)
    expect(files[0]!.hunks).toHaveLength(0)
  })

  it('flags binary files without hunks', () => {
    const { files } = parseUnifiedDiff('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n')
    expect(files[0]).toMatchObject({ binary: true, hunks: [] })
  })
})

describe('DiffView rendering', () => {
  it('renders file sections, tags and collapsible hunks', () => {
    render(<DiffView text={SIMPLE}/>)
    expect(screen.getByText('a.ts')).toBeTruthy()
    // source files expand by default; the del/add rows are visible.
    expect(screen.getByText('two')).toBeTruthy()
    expect(screen.getByText('two changed')).toBeTruthy()
    // toggle the file section closed.
    fireEvent.click(screen.getByText('a.ts'))
    expect(screen.queryByText('two')).toBeNull()
  })

  it('tags new, deleted and renamed files', () => {
    const renamed = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-x',
      '+x',
    ].join('\n')
    render(<DiffView text={`diff --git a/newfile.md b/newfile.md\n--- /dev/null\n+++ b/newfile.md\n@@ -0,0 +1 @@\n+hi\n\n${renamed}\ndiff --git a/gone.png b/gone.png\nBinary files differ\n`}/>)
    expect(screen.getByText('Added')).toBeTruthy()
    expect(screen.getByText('Renamed')).toBeTruthy()
    expect(screen.getByText('Binary file')).toBeTruthy()
    // renamed rows show the old path next to the new one.
    expect(screen.getByText(/← old\.ts/)).toBeTruthy()
  })

  it('caps huge patches with an expand button and renders untracked content as additions', () => {
    const big = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', '@@ -1,600 +1,600 @@']
    for (let i = 0; i < 600; i += 1) big.push(` line ${i}`)
    const { container } = render(<DiffView text={big.join('\n')}/>)
    expect(container.textContent).toMatch(/Expand \d+ lines/)
    fireEvent.click(screen.getByText(/Expand \d+ lines/))
    expect(screen.queryByText(/Expand \d+ lines/)).toBeNull()

    const untracked = untrackedFile('new.txt', 'hello\nworld\n')
    expect(untracked.hunks[0]!.lines).toHaveLength(2)
  })
})
