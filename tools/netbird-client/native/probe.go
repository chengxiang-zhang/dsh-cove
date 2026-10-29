package portal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type probeResult struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode"`
	Reachable  bool   `json:"reachable"`
}

// Probe performs a single quick HTTP GET through the embedded NetBird
// netstack with a short timeout, returning reachability and status code.
// Unlike Fetch it never retries, so it is suitable for probing many
// services concurrently from the service list screen.
func Probe(url string) (string, error) {
	client, err := currentClient()
	if err != nil {
		// Reporting "not started" as a successful empty result made an engine
		// that is gone indistinguishable from a host that did not answer.
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	httpClient := client.NewHTTPClient()
	response, err := httpClient.Do(req)
	result := probeResult{URL: url, Reachable: false}
	if err == nil {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		result.StatusCode = response.StatusCode
		result.Reachable = true
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
