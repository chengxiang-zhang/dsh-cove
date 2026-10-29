

/** The private BrowserAuth surface used by the host adapter. */
export interface BrowserAuthLike {
  isAuthenticated(request: unknown): boolean
}

/** Structural subset of the host connection service used by this capability. */
export interface BrowserConnectionLike {
  browserAuth?: BrowserAuthLike
}

/** Explicit opt-in configuration. Disabled by default inside web-all. */
export interface NoBrowserAuthConfig {
  enabled?: boolean
}
