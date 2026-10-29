/** CSS Modules class-map declaration (tsdown compiles .module.css at build). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/** Plain CSS side-effect imports (layout.css, vendor css) — tsdown inlines them. */
declare module '*.css'
