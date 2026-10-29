/** Typed errors returned by the right-pane service domain. */
export class BetterSidebarError extends Error {
  constructor(
    readonly code: 'bad-request' | 'forbidden' | 'not-found' | 'method-error' | 'too-large' | 'fs-error' | 'git-error' | 'terminal-error' | 'settings-rejected' | 'settings-conflict' | 'internal',
    message: string,
  ) {
    super(message)
    this.name = 'BetterSidebarError'
  }
}
