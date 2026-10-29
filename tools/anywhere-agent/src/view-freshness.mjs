/**
 * When a resident workspace page must be reloaded instead of reused.
 *
 * A machine's workspace lives in one long-lived `WebContentsView` (see
 * `shell/main.mjs`, `workspaceViewFor`): switching machines is a swap, never a
 * window management action, so the page stays loaded indefinitely. That is what
 * makes switching instant, and it is also the page's one failure mode: the page
 * receives its updates over `/api/remote.mux`, so any interruption of that
 * socket - a sleep, a network switch, the app's own overlay engine reconnecting,
 * the host restarting `dsh web` - leaves the page painting the last snapshot it
 * had. The page does not reload itself, and the shell has no other path that
 * reloads it: before this policy existed, the list and the transcript stayed
 * frozen at the moment the socket died, and the same machine opened in a browser
 * showed everything that had happened since.
 *
 * The policy is deliberately conservative about the user's work. Reloading a
 * page drops an unsent composer draft, so a page that was only briefly hidden is
 * reused as-is: the DSH client's own reconnect loop (500 ms to 10 s, jittered,
 * continuous) is the first line of defence and it handles short interruptions.
 * Only a page that has been off screen long enough for that loop to have given up
 * - or a page the user explicitly asked to refresh - is replaced.
 *
 * @module view-freshness
 */

/** How long a hidden workspace page may be reused before it is reloaded. */
export const HIDDEN_STALE_AFTER_MS = 5 * 60 * 1000;

/** How long the machine may sleep before the page on screen is reloaded on wake. */
export const WAKE_STALE_AFTER_MS = 60 * 1000;

/**
 * What opening a machine does with its resident page.
 *
 * Three answers, because they are three different navigations:
 *   - `load`   the view has no page yet, or the user asked for the front door: load
 *              the machine's entry URL. The front door is the "new session" entry, and
 *              it must not be replaced by a reload of wherever the page happened to be.
 *   - `reload` the page is loaded but has been off screen long enough for its update
 *              socket to have died: reload it, which keeps its route and therefore the
 *              conversation the user was in.
 *   - `reuse`  the page was on screen a moment ago: show it as it is.
 *
 * @param {object} input
 * @param {boolean} input.hasPage whether the view already holds a loaded page.
 * @param {boolean} [input.fresh] the explicit new-session entry.
 * @param {number|null} [input.hiddenSince] when the page last stopped being visible.
 * @param {number} input.now the decision time.
 * @param {number} [input.staleAfterMs] reuse window; defaults to {@link HIDDEN_STALE_AFTER_MS}.
 * @returns {'load'|'reload'|'reuse'} the navigation to perform
 */
export function workspacePageAction({
  hasPage,
  fresh = false,
  hiddenSince = null,
  now,
  staleAfterMs = HIDDEN_STALE_AFTER_MS,
}) {
  if (!hasPage || fresh) {
    return 'load';
  }
  if (hiddenSince === null || !Number.isFinite(hiddenSince)) {
    // A page that was never recorded as hidden is the active one: it has been on
    // screen the whole time and its socket was being watched, not abandoned.
    return 'reuse';
  }
  return now - hiddenSince >= staleAfterMs ? 'reload' : 'reuse';
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
