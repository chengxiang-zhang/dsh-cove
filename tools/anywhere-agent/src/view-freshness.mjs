/**
 * What opening a tab does with the page that is already loaded.
 *
 * A tab's page is a resident `WebContentsView` (see `shell/main.mjs`, `workspaceViewFor`
 * and `webViewFor`): switching tabs is a visibility change, never a rebuild, so the page
 * keeps its route, its scroll position and an unsent composer draft. That residency is
 * the whole reason switching is instant.
 *
 * It also used to come with timers: a page off screen for five minutes was reloaded, one
 * off screen for ten minutes had its view destroyed, and a page on screen was reloaded
 * when the machine woke from sleep. All three were guesses about a dead update socket
 * (`/api/remote.mux`). A hidden page keeps its socket, Chromium already gives a background
 * tab's memory back, and after sleep the DSH client's own reconnect loop (500 ms to 10 s,
 * jittered, continuous) re-subscribes. So the shell now has no automatic reload at all: a
 * page is replaced when the user asks for it, and the next launch loads from the address.
 *
 * What is left is the decision at the moment a tab is opened:
 *   - `load`  the view has no page yet, or `fresh` (the new-session entry) must land on
 *             the machine's front door rather than wherever the page was left;
 *   - `reuse` the page is already there: show it as it is.
 *
 * The one reload outside this decision is the user's own explicit refresh
 * (`shouldReloadOnRefresh`). A page is destroyed only when its tab is closed or its
 * machine stays absent from the list past the prune grace - never on a timer, never on
 * wake, never because a tab was hidden.
 *
 * @module view-freshness
 */

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
