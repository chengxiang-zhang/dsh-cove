/** Guide-entry icons for the right-pane additions (git, browser, agent browser). */
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Browser glyph: a globe with meridians (matches the primitives' outline style). */
export const IconGlobeOutline16: ComponentType<IconProps> = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="8" cy="8" rx="2.8" ry="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M1.5 8h13M8 1.5c-2.4 1.8-2.4 11.2 0 13M8 1.5c2.4 1.8 2.4 11.2 0 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

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