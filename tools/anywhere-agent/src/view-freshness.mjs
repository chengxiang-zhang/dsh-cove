/**
 * What opening a tab does with the page that is already loaded.
 *
 * A tab's page is a resident `WebContentsView` (see `shell/main.mjs`, `workspaceViewFor`
 * and `webViewFor`): switching tabs is a visibility change, never a rebuild, so the page
 * keeps its route, its scroll position and an unsent composer draft. That residency is
 * the whole reason switching is instant.
 *
 * It also used to come with a timer: a page that had been off screen for five minutes was
 * reloaded, and one off screen for ten minutes had its view destroyed. Both were guesses
 * about a dead update socket (`/api/remote.mux`), and both were wrong in the common case:
 * a hidden page keeps its socket, so the timer threw away the user's place in a
 * conversation for a failure that had not happened. The DSH client's own reconnect loop
 * (500 ms to 10 s, jittered, continuous) already handles an interruption, and the explicit
 * refresh is the user's own answer when a screen looks stuck. Nothing reloads a page
 * because elapsed time says so.
 *
 * So the shell performs exactly two navigations on its own, both of them real:
 *   - `load`  the view has no page yet, or `fresh` (the new-session entry) must land on
 *             the machine's front door rather than wherever the page was left;
 *   - `reuse` the page is already there: show it as it is.
 *
 * The remaining reload paths live beside this decision, not in it: wake from sleep, where
 * the socket really did die with the suspend (`shouldReloadOnWake`), and an explicit
 * refresh (`shouldReloadOnRefresh`). A page is destroyed only when its tab is closed or
 * its machine stays absent from the list past the prune grace, never on a timer.
 *
 * @module view-freshness
 */

/** How long the machine may sleep before the page on screen is reloaded on wake. */
export const WAKE_STALE_AFTER_MS = 60 * 1000;

/**
 * What opening a machine does with its resident page.
 *
 * @param {object} input
 * @param {boolean} input.hasPage whether the view already holds a loaded page.
 * @param {boolean} [input.fresh] the explicit new-session entry.
 * @returns {'load'|'reuse'} the navigation to perform
 */
export function workspacePageAction({ hasPage, fresh = false }) {
  if (!hasPage || fresh) {
    return 'load';
  }
  return 'reuse';
}

/**
 * Decides whether waking the machine reloads the page that is on screen.
 *
 * Nothing was hidden here: the whole app slept, so the page's socket died with
 * the process suspended and no resume path re-subscribed it.
 *
 * @param {object} input
 * @param {boolean} input.hasPage whether the active view holds a loaded page.
 * @param {number} input.suspendedMs how long the machine was asleep.
 * @param {number} [input.staleAfterMs] sleep duration that invalidates the page.
 * @returns {boolean} true when the caller must reload instead of trusting the page.
 */
export function shouldReloadOnWake({ hasPage, suspendedMs, staleAfterMs = WAKE_STALE_AFTER_MS }) {
  if (!hasPage) {
    return false;
  }
  return Number.isFinite(suspendedMs) && suspendedMs >= staleAfterMs;
}

/**
 * Decides whether an explicit refresh reloads the page.
 *
 * Refresh is the user's own answer to a screen that looks stuck, so it always
 * reloads a loaded page; with no page there is nothing to replace and the caller's
 * normal navigation applies.
 *
 * @param {object} input
 * @param {boolean} input.hasPage whether the target view holds a loaded page.
 * @returns {boolean} true when the caller must reload instead of re-reading state.
 */
export function shouldReloadOnRefresh({ hasPage }) {
  return hasPage === true;
}
