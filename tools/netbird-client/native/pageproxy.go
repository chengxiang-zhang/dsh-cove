package portal

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sync"
	"time"
)

// The page proxy: one private-network page served from a loopback origin.
//
// Android and the desktop reach a DSH page by pointing their browser at the forward proxy
// (StartProxy) because both can configure one - GeckoView by preference, Chromium by
// session. iOS cannot: WKWebView has no proxy API at all, so the only way to render those
// pages inside the app is to serve them from an origin the web view can load. That is what
// this is: an HTTP reverse proxy, bound to loopback, whose upstream is dialled through the
// same userspace overlay as the forward proxy. The app loads http://127.0.0.1:<port>/ and
// every relative URL, stream and socket in the page comes back through here.
//
// It deliberately has no equivalent of PROXY_ADDR: a page proxy reachable from the network
// would publish the fleet's private pages to it, which is the one thing the app-scope
// contract forbids (see src/app-scope.mjs, `loopback-proxy`).

var pageProxyState struct {
	sync.Mutex
	upstream *url.URL
	listener net.Listener
	url      string
	cancel   context.CancelFunc
}

// defaultPageProxyAddr is where the page proxy listens unless the environment overrides it.
const defaultPageProxyAddr = "127.0.0.1:19002"

// isLoopbackAddr reports whether host:port binds this machine and nothing else.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// StartPageProxy serves the page at `upstream` from a loopback origin and returns that
// origin, for a web view to load. It is idempotent per upstream: a second call for the same
// address returns the same origin instead of a second listener.
func StartPageProxy(upstream string) (string, error) {
	target, err := url.Parse(upstream)
	if err != nil {
		return "", fmt.Errorf("parse upstream %q: %w", upstream, err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return "", fmt.Errorf("upstream %q must be http or https", upstream)
	}
	if target.Host == "" {
		return "", fmt.Errorf("upstream %q has no host", upstream)
	}

	addr := os.Getenv("PAGE_PROXY_ADDR")
	if addr == "" {
		addr = defaultPageProxyAddr
	}
	if !isLoopbackAddr(addr) {
		return "", fmt.Errorf("page proxy %s is not a loopback address", addr)
	}

	client, err := currentClient()
	if err != nil {
		return "", err
	}

	pageProxyState.Lock()
	defer pageProxyState.Unlock()
	if pageProxyState.listener != nil && pageProxyState.upstream != nil && pageProxyState.upstream.String() == target.String() {
		return pageProxyState.url, nil
	}
	// A different page replaces the one being served: one app shows one page at a time,
	// and leaving the old listener behind would keep a dead upstream reachable.
	dropPageProxyLocked()

	listener, err := net.Listen("tcp", addr)
	if err != nil && addr != defaultPageProxyAddr {
		return "", fmt.Errorf("listen page proxy %s: %w", addr, err)
	}
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", fmt.Errorf("listen page proxy: %w", err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	origin := "http://" + listener.Addr().String() + "/"
	handler := newPageProxyHandler(target, client.DialContext)
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 15 * time.Second}

	pageProxyState.upstream = target
	pageProxyState.listener = listener
	pageProxyState.url = origin
	pageProxyState.cancel = cancel
	go func() {
		<-ctx.Done()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancelShutdown()
		_ = server.Shutdown(shutdownCtx)
		_ = listener.Close()
	}()
	go func() {
		_ = server.Serve(listener)
	}()
	return origin, nil
}

// StopPageProxy tears the origin down. The engine calls it wherever the forward proxy is
// dropped: a page proxy outliving its client would be a proxy with no network.
func StopPageProxy() {
	pageProxyState.Lock()
	defer pageProxyState.Unlock()
	dropPageProxyLocked()
}

// dropPageProxyLocked stops whatever origin is being served. Callers must hold the lock.
func dropPageProxyLocked() {
	if pageProxyState.cancel != nil {
		pageProxyState.cancel()
		pageProxyState.cancel = nil
	}
	if pageProxyState.listener != nil {
		_ = pageProxyState.listener.Close()
		pageProxyState.listener = nil
	}
	pageProxyState.upstream = nil
	pageProxyState.url = ""
}

// newPageProxyHandler builds the reverse proxy for one upstream.
//
// `dial` is the overlay's dialer, injected so that the parts which are easy to get wrong -
// the Host the upstream sees, streaming responses, and protocol upgrades - can be tested
// against a local server without an overlay.
func newPageProxyHandler(upstream *url.URL, dial func(ctx context.Context, network, addr string) (net.Conn, error)) http.Handler {
	target := &url.URL{Scheme: upstream.Scheme, Host: upstream.Host}
	proxy := &httputil.ReverseProxy{
		Director: func(request *http.Request) {
			request.URL.Scheme = target.Scheme
			request.URL.Host = target.Host
			// The page is served as the canonical authority, not as 127.0.0.1: the fleet
			// decides what a request may do from the Host header, and a page fetched under a
			// loopback Host would be a different page to it. This is the same thing the
			// forward proxy gives the other platforms, where the browser keeps the URL.
			request.Host = target.Host
		},
		Transport: &http.Transport{
			DialContext:       dial,
			ForceAttemptHTTP2: false,
		},
		// A DSH page is a live page: server-sent events, long polls and websockets are how
		// it reports work. Buffered writes turn it into one that looks hung.
		FlushInterval: -1,
		ErrorHandler: func(writer http.ResponseWriter, request *http.Request, err error) {
			message := fmt.Sprintf("the private network did not answer %s: %v", target.Host, err)
			writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
			writer.WriteHeader(http.StatusBadGateway)
			if errors.Is(err, context.Canceled) {
				return
			}
			_, _ = writer.Write([]byte(message))
		},
	}
	return proxy
}
