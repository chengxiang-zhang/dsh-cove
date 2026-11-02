/**
 * Where the native page goes.
 *
 * A service page is not part of the renderer: it is a `WebContentsView` owned by the
 * main process and painted above the window's DOM. CSS therefore cannot place it, and
 * the only thing that can is `view.setBounds`. That call is where two coordinate
 * systems meet, and every "the page did not follow the window" defect comes from one
 * of them being used as if it were the other:
 *
 *   - the renderer measures the page area with `getBoundingClientRect`, which answers
 *     in CSS pixels - and CSS pixels shrink when the window is zoomed;
 *   - `setBounds` takes DIP, which is CSS pixels at zoom 1.
 *
 * So the rect is converted and clamped in one place, at the moment it is placed rather
 * than when it is measured. A measurement is only a measurement: keeping it in the
 * units it arrived in is what lets a zoom change or a window resize re-derive the
 * right answer instead of replaying a number that was correct for the previous state.
 *
 * Clamping is not defensive programming. During a live resize the renderer can report
 * the frame before the window manager finished growing the content area, and a rect
 * wider than the window leaves the native surface painting over the edge of the
 * window - a black band that the user reads as a broken page.
 */

/** A zoom factor that cannot be used is treated as 100% rather than refusing to draw. */
function usableZoom(zoom) {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/** A rect whose numbers are unusable collapses to nothing instead of spreading NaN. */
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * The rect to give `view.setBounds`: CSS pixels in, DIP out, never outside the window.
 *
 * @param {{ rect: {x: number, y: number, width: number, height: number}, zoom?: number,
 *   content: { width: number, height: number } }} input `content` is the window's
 *   content size in DIP (what `BrowserWindow.getContentBounds` reports).
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function contentRect({ rect, zoom = 1, content }) {
  const scale = usableZoom(zoom);
  const contentWidth = Math.max(0, Math.round(finite(content?.width)));
  const contentHeight = Math.max(0, Math.round(finite(content?.height)));
  const x = Math.min(Math.max(0, Math.round(finite(rect?.x) * scale)), contentWidth);
  const y = Math.min(Math.max(0, Math.round(finite(rect?.y) * scale)), contentHeight);
  const width = Math.min(Math.max(0, Math.round(finite(rect?.width) * scale)), contentWidth - x);
  const height = Math.min(Math.max(0, Math.round(finite(rect?.height) * scale)), contentHeight - y);
  return { x, y, width, height };
}

/** Whether a placed rect can actually hold a page. A zero edge is "nothing to cover". */
export function isCovering(rect) {
  return Boolean(rect) && rect.width > 0 && rect.height > 0;
}

/**
 * Whether two placed rects are the same placement.
 *
 * The renderer reports on every layout change - a live resize produces one per frame -
 * and re-placing a surface that is already there is pure cost. Comparing the final DIP
 * rect (not the reported CSS one) is what makes this safe across a zoom change, where
 * the CSS rect does change and the placement may not.
 */
export function sameRect(a, b) {
  if (!a || !b) {
    return a === b;
  }
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
