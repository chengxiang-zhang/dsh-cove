package portal

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// These tests exercise the page proxy itself, with the overlay replaced by a dialer that
// points at a local server. That is deliberate: what is worth pinning down here is the
// behaviour a WKWebView depends on - the Host the upstream sees, streaming, upgrades, and
// the refusal to serve anything but loopback - none of which needs a private network.

// dialTo sends every address to one local server, whatever the proxy asked for.
func dialTo(address string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, address)
	}
}

func localAddress(t *testing.T, server *httptest.Server) string {
	t.Helper()
	return strings.TrimPrefix(server.URL, "http://")
}

func TestPageProxyServesThroughTheOverlayAndKeepsTheCanonicalHost(t *testing.T) {
	var seenHost, seenPath, seenRawQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seenHost = request.Host
		seenPath = request.URL.Path
		seenRawQuery = request.URL.RawQuery
		_, _ = io.WriteString(writer, "workspace\n")
	}))
	defer upstream.Close()

	// The upstream is the fleet's canonical name, which resolves only inside the overlay;
	// the injected dialer is what actually reaches the local server.
	target, err := url.Parse("http://dsh.studio-mac.netbird")
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	proxy := httptest.NewServer(newPageProxyHandler(target, dialTo(localAddress(t, upstream))))
	defer proxy.Close()

	response, err := http.Get(proxy.URL + "/api/dsh-notify/feed?since=0")
	if err != nil {
		t.Fatalf("get through the page proxy: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	if string(body) != "workspace\n" {
		t.Fatalf("body %q", body)
	}
	if seenHost != "dsh.studio-mac.netbird" {
		t.Fatalf("the upstream saw Host %q, not the canonical authority", seenHost)
	}
	if seenPath != "/api/dsh-notify/feed" || seenRawQuery != "since=0" {
		t.Fatalf("the upstream saw %q?%q", seenPath, seenRawQuery)
	}
}

func TestPageProxyStreamsWithoutBuffering(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Error("the test upstream cannot flush")
			return
		}
		_, _ = io.WriteString(writer, "first\n")
		flusher.Flush()
		<-release
		_, _ = io.WriteString(writer, "second\n")
	}))
	defer upstream.Close()

	target, _ := url.Parse("http://dsh.studio-mac.netbird")
	proxy := httptest.NewServer(newPageProxyHandler(target, dialTo(localAddress(t, upstream))))
	defer proxy.Close()

	response, err := http.Get(proxy.URL + "/events")
	if err != nil {
		t.Fatalf("get through the page proxy: %v", err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)

	// The first line has to arrive while the upstream is still open. A buffered proxy would
	// hold it until the handler returned, which never happens before the second line.
	type readResult struct {
		line string
		err  error
	}
	first := make(chan readResult, 1)
	go func() {
		line, readErr := reader.ReadString('\n')
		first <- readResult{line, readErr}
	}()

	select {
	case result := <-first:
		if result.err != nil || result.line != "first\n" {
			t.Fatalf("first chunk %q err %v", result.line, result.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first chunk did not arrive while the upstream was still streaming: the proxy is buffering")
	}

	close(release)
	second, err := reader.ReadString('\n')
	if err != nil || second != "second\n" {
		t.Fatalf("second chunk %q err %v", second, err)
	}
}

func TestPageProxyRelaysProtocolUpgrades(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			http.Error(writer, "no upgrade header", http.StatusBadRequest)
			return
		}
		hijacker, ok := writer.(http.Hijacker)
		if !ok {
			http.Error(writer, "cannot hijack", http.StatusInternalServerError)
			return
		}
		connection, buffer, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buffer.Flush()
		line, err := buffer.ReadString('\n')
		if err != nil {
			return
		}
		_, _ = buffer.WriteString("echo:" + line)
		_ = buffer.Flush()
	}))
	defer upstream.Close()

	target, _ := url.Parse("http://dsh.studio-mac.netbird")
	proxy := httptest.NewServer(newPageProxyHandler(target, dialTo(localAddress(t, upstream))))
	defer proxy.Close()

	connection, err := net.Dial("tcp", localAddress(t, proxy))
	if err != nil {
		t.Fatalf("dial the page proxy: %v", err)
	}
	defer connection.Close()

	_, _ = fmt.Fprintf(connection, "GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	reader := bufio.NewReader(connection)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("the upgrade was not relayed, status line %q", status)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	if _, err := fmt.Fprintf(connection, "hello\n"); err != nil {
		t.Fatalf("write after upgrade: %v", err)
	}
	echo, err := reader.ReadString('\n')
	if err != nil || echo != "echo:hello\n" {
		t.Fatalf("after the upgrade the connection carried %q err %v", echo, err)
	}
}

func TestPageProxyReportsAnUnreachableUpstream(t *testing.T) {
	target, _ := url.Parse("http://dsh.studio-mac.netbird")
	dial := func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("the overlay is down")
	}
	proxy := httptest.NewServer(newPageProxyHandler(target, dial))
	defer proxy.Close()

	response, err := http.Get(proxy.URL + "/")
	if err != nil {
		t.Fatalf("get through the page proxy: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", response.StatusCode)
	}
	if !strings.Contains(string(body), "the overlay is down") {
		t.Fatalf("the page said %q, which does not explain the failure", body)
	}
}

func TestStartPageProxyRefusesANonLoopbackAddress(t *testing.T) {
	t.Setenv("PAGE_PROXY_ADDR", "0.0.0.0:19002")
	if _, err := StartPageProxy("http://dsh.studio-mac.netbird"); err == nil {
		t.Fatal("a page proxy reachable from the network was accepted")
	} else if !strings.Contains(err.Error(), "not a loopback address") {
		t.Fatalf("refused for the wrong reason: %v", err)
	}
}

func TestLoopbackAddressesOnly(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:19002", "localhost:19002", "[::1]:19002"} {
		if !isLoopbackAddr(addr) {
			t.Errorf("%s should be loopback", addr)
		}
	}
	for _, addr := range []string{"0.0.0.0:19002", "192.168.1.5:19002", "example.com:80", "127.0.0.1"} {
		if isLoopbackAddr(addr) {
			t.Errorf("%s should not be accepted as loopback", addr)
		}
	}
}

func TestStopPageProxyIsSafeWhenNothingIsServed(t *testing.T) {
	// The engine calls this wherever the forward proxy is dropped, including on a start
	// that never got as far as a page.
	StopPageProxy()
	StopPageProxy()
	pageProxyState.Lock()
	defer pageProxyState.Unlock()
	if pageProxyState.listener != nil || pageProxyState.url != "" {
		t.Fatalf("state left behind: %q", pageProxyState.url)
	}
}
