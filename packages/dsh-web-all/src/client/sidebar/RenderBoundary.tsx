import { Component, type ErrorInfo, type ReactNode } from 'react'
import css from './sidebar.module.css'

/** Contain one native page crash without blanking the official right sidebar. */
export class RenderBoundary extends Component<{ children?: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-web-all/sidebar] render error:', error, info.componentStack)
  }
  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return <div className={css.boundaryError} role="alert" data-dsh-part="boundary"><span>{this.state.error}</span><button type="button" onClick={() => { this.setState({ error: null }) }}>Retry</button></div>
  }
}
