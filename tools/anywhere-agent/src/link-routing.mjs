/**
 * What a page's link does.
 *
 * The window is a browser for two networks (`src/proxy-pac.mjs` says which one each
 * request uses), so the address no longer decides *whether* a page may open here: a
 * public page and an overlay page are both pages of this window. What is left for this
 * module is the smaller question a browser still has to answer - a `window.open` or a
 * `target=_blank` becomes a tab, and an address that is not a web page at all is either
 * handed to the platform (a mail client, a phone app) or dropped.
 *
 * That keeps the tab strip the only place pages appear: a raw second window is a browser
 * without a way back to the list, and the identity provider in a sign-in flow cannot be
 * told apart from a report link by its scheme alone.
 *
 * @module anywhere-agent/link-routing
 */

/** What opening an address means. */
export const LINK_ROUTE = {
  /** Open it as a tab in this window. */
  tab: 'tab',
  /** Hand it to the platform (another application owns this scheme). */
  external: 'external',
  /** There is nothing to open. */
  ignore: 'ignore',
};

/** Schemes whose only meaning is "let the operating system hand this on". */
const HAND_OFF_SCHEMES = new Set(['mailto:', 'tel:', 'sms:']);

/** A host name without the URL syntax around it: lower case, no brackets, no trailing dot. */
export function hostOfAddress(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    return '';
  }
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * Routes one address.
 *
 * @param {unknown} rawUrl the address a page asked to open
 * @returns {{ route: string, url: string, host: string, reason: string }} the decision,
 *   the address it applies to (normalized), and why it was made - the reason travels into
 *   the shell log so a link that went the unexpected way can be explained
 */
export function classifyLink(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (raw === '') {
    return { route: LINK_ROUTE.ignore, url: '', host: '', reason: 'empty' };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { route: LINK_ROUTE.ignore, url: raw, host: '', reason: 'unparsable' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // Both networks are this window's: whether the page is public or overlay is a routing
    // question for the proxy, not a reason to keep the page out.
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'web' };
  }
  if (HAND_OFF_SCHEMES.has(parsed.protocol)) {
    return { route: LINK_ROUTE.external, url: parsed.href, host, reason: `scheme:${parsed.protocol.replace(':', '')}` };
  }
  // `javascript:`, `about:`, `data:` and friends refer to the page itself; there is
  // nothing to open and nothing to hand anywhere.
  return { route: LINK_ROUTE.ignore, url: parsed.href, host, reason: `scheme:${parsed.protocol.replace(':', '')}` };
}