/** Guide-entry icon for the right-pane agent-browser tab. */
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Agent-browser glyph: a monitor with a playing cursor, mirroring the live
 *  screencast surface (matches the outline style). */
export const IconAgentBrowser16: ComponentType<IconProps> = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5.5 15h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8 12v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M6 6.2 10 8l-4 1.8z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
  </svg>
)