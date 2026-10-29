package portal

// FetchStatic performs an HTTP GET through the embedded netstack while the caller
// supplies the destination address.
//
// Why this exists: the netstack's own resolver points at this network's DNS,
// which answers the fleet's zones and nothing else, so a request for a public
// name fails inside the engine ("server misbehaving"). The app therefore resolves
// the name itself and hands the address in, which is also what makes routing
// meaningful: the netstack still decides whether a peer, a routed network or the
// office exit carries the request. The URL keeps the real host, so SNI and the
// Host header stay correct; only the dial target is overridden.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type staticFetchResult struct {
	URL        string `json:"url"`
	Address    string `json:"address"`
	StatusCode int    `json:"statusCode"`
	Body       string `json:"body"`
}

func defaultPort(url string) string {
	if strings.HasPrefix(strings.ToLower(url), "https://") {
		return ":443"
	}
	return ":80"
}

// FetchStatic gets a URL through the netstack, dialing the given address.
func FetchStatic(url, address, host string) (string, error) {
	client, engineErr := currentClient()
	if engineErr != nil {
		return "", engineErr
	}
	target := strings.TrimSpace(address)
	if target == "" {
		return "", fmt.Errorf("address is required")
	}
	if !strings.Contains(target, ":") {
		target += defaultPort(url)
	}

	// A fresh transport per call: the destination address is per request, and a
	// pooled connection would silently reuse the previous one.
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return client.Dial(ctx, network, target)
		},
		TLSClientConfig:   &tls.Config{},
		DisableKeepAlives: true,
	}
	httpClient := &http.Client{Transport: transport, Timeout: 20 * time.Second}

	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	if host != "" {
		request.Host = host
	}

	var response *http.Response
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		response, err = httpClient.Do(request)
		if err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return "", fmt.Errorf("get %s via %s: %w", url, target, err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	encoded, err := json.Marshal(staticFetchResult{
		URL:        url,
		Address:    target,
		StatusCode: response.StatusCode,
		Body:       string(body),
	})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}