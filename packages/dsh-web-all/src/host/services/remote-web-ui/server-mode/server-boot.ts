/**
 * Server-mode boot script injected into the desktop GUI's index HTML. Runs
 * only on non-loopback origins (i.e. when the page was reached through the
 * gateway at http://<lan-ip>:3082 or a tunnel), where it probes the gateway
 * session endpoint and, when no session cookie is live, redirects to the login
 * page preserving the intended target.
 *
 * It deliberately does NOT claim Host ownership. The ownership claim is a
 * privileged decision and belongs to one per-request fenced owner: the
 * remote-access domain's `GET /web-all/remote-access/boot.js`, which answers
 * `__DSH_TRANSPORT__.ownsHost` only for a Host the shared host access fence
 * admits. This row is injected into every served index document, host-
 * independently, so an unconditional claim here would hand the privileged
 * settings plane to a page loaded from an authority the deployment never
 * declared (and it silently overrode the fenced no-op that row serves).
 *
 * The loopback origin skips the probe: the local host is already the admin
 * surface.
 */

export const SERVER_BOOT_SCRIPT = `(function () {
  try {
    var host = location.hostname;
    var isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\\./.test(host);
    if (isLoopback) return;
    fetch('/api/gateway/session', { credentials: 'same-origin', headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (!body || !body.authenticated) {
          var target = location.pathname + location.search;
          if (target.indexOf('/login') !== 0 && target.indexOf('/api/') !== 0) {
            location.replace('/login?next=' + encodeURIComponent(target));
          }
        }
      })
      .catch(function () { /* offline/proxy down: leave the page to its own errors */ });
  } catch (e) { /* never break the SPA boot */ }
})();`