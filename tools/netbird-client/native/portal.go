// Package portal exposes a minimal mobile API around NetBird's embedded client.
package portal

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	nb "github.com/netbirdio/netbird/client/embed"
	mgmProto "github.com/netbirdio/netbird/shared/management/proto"
)

var state struct {
	sync.Mutex
	client *nb.Client
	// startErr keeps the reason the embedded client failed to start. Without it
	// every caller only ever saw the literal "client not started", which cannot
	// be told apart from "not connected yet" and carries no authentication
	// marker, so an expired identity looked like a transient outage forever.
	startErr    error
	proxy       net.Listener
	proxyURL    string
	proxyCancel context.CancelFunc
}

// notStartedLocked builds the "no engine" error. Callers must hold state.Lock.
func notStartedLocked() error {
	if state.startErr != nil {
		return fmt.Errorf("client not started: %w", state.startErr)
	}
	return errors.New("client not started")
}

// currentClient returns the running client, or the reason there is none.
func currentClient() (*nb.Client, error) {
	state.Lock()
	defer state.Unlock()
	if state.client != nil {
		return state.client, nil
	}
	return nil, notStartedLocked()
}

// dropProxyLocked tears down both loopback proxies. Their handlers captured the
// client they were built for, so they must never outlive that client: otherwise
// the next StartProxy hands callers a forwarder whose dialer is dead, and the page
// proxy keeps serving a page from a network that is gone.
// Callers must hold state.Lock.
func dropProxyLocked() {
	if state.proxy != nil {
		_ = state.proxy.Close()
		state.proxy = nil
	}
	if state.proxyCancel != nil {
		state.proxyCancel()
		state.proxyCancel = nil
	}
	state.proxyURL = ""
	dropPageProxyLocked()
}

type fetchResult struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode"`
	Body       string `json:"body"`
}

type serviceRecord struct {
	Name  string `json:"name"`
	Type  int64  `json:"type"`
	Class string `json:"class"`
	RData string `json:"content"`
	Zone  string `json:"zone"`
}

// Start connects an embedded, process-local NetBird client.
//
// Auto-login: when setupKey is empty and a persisted config already exists at
// configPath (peer previously enrolled), the WireGuard private key is read from
// the config file and reused, so the user does not have to type the setup key
// again. A non-empty setupKey always takes the classic registration path.
func Start(setupKey, deviceName, managementURL, configPath, statePath string) error {
	state.Lock()
	defer state.Unlock()
	if state.client != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	if err := os.Setenv("NB_LAZY_CONN", "false"); err != nil {
		return fmt.Errorf("disable lazy connections: %w", err)
	}
	lazyConnections := false
	opts := nb.Options{
		DeviceName:            deviceName,
		ManagementURL:         managementURL,
		ConfigPath:            configPath,
		StatePath:             statePath,
		BlockInbound:          true,
		DisableIPv6:           true,
		NoUserspace:           false,
		LazyConnectionEnabled: &lazyConnections,
		LogLevel:              "info",
	}
	if setupKey != "" {
		opts.SetupKey = setupKey
	} else {
		privateKey, err := readPersistedPrivateKey(configPath)
		if err != nil {
			return fmt.Errorf("auto-login: %w", err)
		}
		opts.PrivateKey = privateKey
	}
	client, err := nb.New(opts)
	if err != nil {
		return fmt.Errorf("create embedded client: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	state.client = client
	state.startErr = nil
	go func() {
		if err := client.Start(ctx); err != nil {
			state.Lock()
			if state.client == client {
				state.client = nil
				state.startErr = err
				dropProxyLocked()
			}
			state.Unlock()
			cancel()
		}
	}()
	return nil
}

// readPersistedPrivateKey extracts the WireGuard private key already stored in
// the profilemanager config JSON (field name is the exported Go field name).
func readPersistedPrivateKey(configPath string) (string, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no setup key provided and no persisted config at %s", configPath)
		}
		return "", fmt.Errorf("read config: %w", err)
	}
	var cfg struct {
		PrivateKey string `json:"PrivateKey"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parse config: %w", err)
	}
	if cfg.PrivateKey == "" {
		return "", fmt.Errorf("config exists but holds no private key; provide a setup key")
	}
	return cfg.PrivateKey, nil
}

// ListServices returns every DNS record the embedded client received from the
// management server (custom zones as well as component-mode all-records),
// serialized as a JSON array of {name,type,class,content,zone}.
func ListServices() (string, error) {
	client, engineErr := currentClient()
	if engineErr != nil {
		return "", engineErr
	}
	syncResp, err := client.GetLatestSyncResponse()
	if err != nil {
		return "", fmt.Errorf("get sync response: %w", err)
	}
	records := make([]serviceRecord, 0)
	seen := map[string]bool{}
	add := func(name string, rec *mgmProto.SimpleRecord, zone string) {
		if rec == nil {
			return
		}
		key := name + "|" + rec.GetName() + "|" + rec.GetRData()
		if seen[key] {
			return
		}
		seen[key] = true
		records = append(records, serviceRecord{
			Name:  rec.GetName(),
			Type:  rec.GetType(),
			Class: rec.GetClass(),
			RData: rec.GetRData(),
			Zone:  zone,
		})
	}
	if nm := syncResp.GetNetworkMap(); nm != nil {
		if dnsCfg := nm.GetDNSConfig(); dnsCfg != nil {
			for _, zone := range dnsCfg.GetCustomZones() {
				for _, rec := range zone.GetRecords() {
					add(zone.GetDomain(), rec, zone.GetDomain())
				}
			}
		}
	}
	if env := syncResp.GetNetworkMapEnvelope(); env != nil {
		if full, ok := env.Payload.(*mgmProto.NetworkMapEnvelope_Full); ok && full.Full != nil {
			for _, rec := range full.Full.GetAllDnsRecords() {
				add(full.Full.GetCustomZoneDomain(), rec, full.Full.GetCustomZoneDomain())
			}
		}
	}
	// NetBird Cloud names peers under the account DNS domain and serves those
	// names from the client's peer table rather than a custom zone, so the DNS
	// config above holds nothing for them. Synthesize one A record per peer so
	// both deployments feed the same registry: a self-hosted registry rejects
	// these (`dsh.<machine>` is its rule), while cloud mode accepts them as the
	// peer FQDN.
	//
	// This lives here, not in each platform's bridge, because the two platform
	// registries must agree on which names exist.
	if status, statusErr := client.Status(); statusErr == nil {
		for _, peer := range status.Peers {
			fqdn := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(peer.FQDN)), ".")
			ip, _, _ := strings.Cut(peer.IP, "/")
			if fqdn == "" || ip == "" {
				continue
			}
			dot := strings.Index(fqdn, ".")
			if dot < 0 || dot == len(fqdn)-1 {
				continue
			}
			zone := fqdn[dot+1:]
			key := "peer|" + fqdn + "|" + ip
			if seen[key] {
				continue
			}
			seen[key] = true
			records = append(records, serviceRecord{
				Name:  fqdn,
				Type:  1,
				Class: "IN",
				RData: ip,
				Zone:  zone,
			})
		}
	}
	encoded, err := json.Marshal(records)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// StartProxy starts a loopback-only HTTP/CONNECT proxy backed by NetBird Dial.
// The loopback port is stable across sessions when free (19001) so embedded
// browsers (GeckoView) can be configured with a fixed proxy port before the
// runtime starts; it falls back to an ephemeral port when 19001 is taken.
// PROXY_ADDR overrides the listen address (used by the host-side acceptance
// harness so an emulator can reach the tunnel proxy over the docker bridge).
func StartProxy() (string, error) {
	state.Lock()
	defer state.Unlock()
	if state.client == nil {
		return "", notStartedLocked()
	}
	if state.proxy != nil {
		return state.proxyURL, nil
	}
	addr := os.Getenv("PROXY_ADDR")
	if addr == "" {
		addr = "127.0.0.1:19001"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil && addr != "127.0.0.1:19001" {
		return "", fmt.Errorf("listen proxy %s: %w", addr, err)
	}
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", fmt.Errorf("listen proxy: %w", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	state.proxy = listener
	state.proxyURL = "http://" + listener.Addr().String()
	state.proxyCancel = cancel
	client := state.client
	go serveProxy(ctx, client, listener)
	return state.proxyURL, nil
}

func serveProxy(ctx context.Context, client *nb.Client, listener net.Listener) {
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go handleProxyConnection(ctx, client, conn)
	}
}

func handleProxyConnection(ctx context.Context, client *nb.Client, downstream net.Conn) {
	defer downstream.Close()
	reader := bufio.NewReader(downstream)
	request, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	if request.Method == http.MethodConnect {
		proxyTunnel(ctx, client, downstream, request.Host)
		return
	}
	proxyHTTP(ctx, client, downstream, request)
}

func proxyTunnel(ctx context.Context, client *nb.Client, downstream net.Conn, address string) {
	if !strings.Contains(address, ":") {
		address += ":443"
	}
	upstream, err := client.Dial(ctx, "tcp", address)
	if err != nil {
		_, _ = io.WriteString(downstream, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer upstream.Close()
	_, _ = io.WriteString(downstream, "HTTP/1.1 200 Connection Established\r\n\r\n")
	go func() { _, _ = io.Copy(upstream, downstream); _ = upstream.Close() }()
	_, _ = io.Copy(downstream, upstream)
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "portal-proxy: "+format+"\n", args...)
}

// hasUpgrade reports whether the request carries a protocol-switch intent
// (Connection: Upgrade / Upgrade: websocket), which must be tunneled raw:
// plain HTTP transport would kill the connection right after a 101.
func hasUpgrade(request *http.Request) bool {
	for _, value := range request.Header.Values("Connection") {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
				return true
			}
		}
	}
	return strings.EqualFold(request.Header.Get("Upgrade"), "websocket")
}

func proxyUpgrade(ctx context.Context, client *nb.Client, downstream net.Conn, request *http.Request) {
	address := request.Host
	if !strings.Contains(address, ":") {
		scheme := "http"
		if request.URL != nil && request.URL.IsAbs() {
			scheme = request.URL.Scheme
		}
		if scheme == "https" {
			address += ":443"
		} else {
			address += ":80"
		}
	}
	upstream, err := client.DialContext(ctx, "tcp", address)
	if err != nil {
		logf("upgrade dial %s: %v", address, err)
		_, _ = io.WriteString(downstream, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer upstream.Close()
	request.RequestURI = ""
	request.Header.Del("Proxy-Connection")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Close = false
	if err := request.Write(upstream); err != nil {
		logf("upgrade write %s: %v", address, err)
		return
	}
	buffered := bufio.NewReader(upstream)
	response, err := http.ReadResponse(buffered, request)
	if err != nil {
		logf("upgrade read response %s: %v", address, err)
		return
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		logf("upgrade unexpected status %d for %s", response.StatusCode, address)
		_ = response.Write(downstream)
		return
	}
	// Forward the 101 head verbatim (Response.Write would strip the
	// Connection/Upgrade/Sec-WebSocket-* headers the client needs).
	if _, err := fmt.Fprintf(downstream, "HTTP/1.1 %d %s\r\n", response.StatusCode, response.Status); err != nil {
		logf("upgrade head write: %v", err)
		return
	}
	for key, values := range response.Header {
		for _, value := range values {
			if _, err := fmt.Fprintf(downstream, "%s: %s\r\n", key, value); err != nil {
				logf("upgrade header write: %v", err)
				return
			}
		}
	}
	if _, err := io.WriteString(downstream, "\r\n"); err != nil {
		return
	}
	// Bidirectional raw pipe: all later traffic is WebSocket frames.
	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(upstream, downstream)
		_ = upstream.Close()
		done <- struct{}{}
	}()
	_, _ = io.Copy(downstream, buffered)
	<-done
}

func proxyHTTP(ctx context.Context, client *nb.Client, downstream net.Conn, request *http.Request) {
	target := request.URL
	if !target.IsAbs() {
		target = &url.URL{Scheme: "http", Host: request.Host, Path: request.URL.Path, RawQuery: request.URL.RawQuery}
	}
	if hasUpgrade(request) {
		proxyUpgrade(ctx, client, downstream, request)
		return
	}
	request.RequestURI = ""
	request.URL = target
	request.Header.Del("Proxy-Connection")
	transport := &http.Transport{DialContext: client.DialContext}
	response, err := transport.RoundTrip(request)
	if err != nil {
		logf("http %s %s: %v", request.Method, target.String(), err)
		_, _ = io.WriteString(downstream, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer response.Body.Close()
	logf("http %s %s -> %d", request.Method, target.String(), response.StatusCode)
	_ = response.Write(downstream)
}

// Status returns a compact JSON status snapshot.
func Status() (string, error) {
	client, engineErr := currentClient()
	if engineErr != nil {
		return "", engineErr
	}
	status, err := client.Status()
	if err != nil {
		return "", err
	}
	result := map[string]any{
		"managementConnected": status.ManagementState.Connected,
		"ip":                  status.LocalPeerState.IP,
		"fqdn":                status.LocalPeerState.FQDN,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// PeerAddresses returns the overlay addresses of every peer this client knows
// about — connected and offline alike — as a JSON array of strings.
//
// This is the trust anchor for the DSH entry registry: a DNS record may only be
// offered when it points at a machine of this network. Offline peers stay in
// the set on purpose, because "is this one of our machines" and "is it up right
// now" are different questions and only the second one belongs to a probe.
func PeerAddresses() (string, error) {
	client, engineErr := currentClient()
	if engineErr != nil {
		return "", engineErr
	}
	status, err := client.Status()
	if err != nil {
		return "", err
	}
	addresses := make([]string, 0, len(status.Peers)*2)
	seen := make(map[string]bool, len(status.Peers)*2)
	add := func(address string) {
		// Peer state may carry the overlay address with its prefix
		// (100.64.0.11/16); a DNS answer never does, so compare bare hosts.
		host, _, _ := strings.Cut(address, "/")
		if host == "" || seen[host] {
			return
		}
		seen[host] = true
		addresses = append(addresses, host)
	}
	for _, peer := range status.Peers {
		add(peer.IP)
		add(peer.IPv6)
	}
	encoded, err := json.Marshal(addresses)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// Fetch performs an HTTP GET entirely through the embedded NetBird netstack.
func Fetch(url string) (string, error) {
	client, engineErr := currentClient()
	if engineErr != nil {
		return "", engineErr
	}
	deadline := time.Now().Add(90 * time.Second)
	var response *http.Response
	var err error
	for time.Now().Before(deadline) {
		httpClient := client.NewHTTPClient()
		httpClient.Timeout = 10 * time.Second
		response, err = httpClient.Get(url)
		if err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return "", fmt.Errorf("get %s: %w", url, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	encoded, err := json.Marshal(fetchResult{URL: url, StatusCode: response.StatusCode, Body: string(body)})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// Stop disconnects the embedded NetBird client and loopback proxy.
func Stop() error {
	state.Lock()
	client := state.client
	proxyCancel := state.proxyCancel
	state.client = nil
	state.proxy = nil
	state.proxyURL = ""
	state.proxyCancel = nil
	state.Unlock()
	if proxyCancel != nil {
		proxyCancel()
	}
	// The page proxy has its own listener and the same dead dialer.
	StopPageProxy()
	if client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return client.Stop(ctx)
}
