package portal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var downloadState struct {
	sync.Mutex
	active   bool
	destPath string
	bytes    int64
	total    int64
	cancel   bool
}

type downloadResult struct {
	DestPath string `json:"destPath"`
	Bytes    int64  `json:"bytes"`
	Total    int64  `json:"total"`
}

// downloadTransport is one way out of the phone.
//
// They are not interchangeable, and the update flow needs both. The channel is
// published on an ordinary public HTTPS name (publish.sh serves it so a phone
// on ordinary WiFi, with no NetBird at all, can download), and the overlay
// answers the same document from a literal address. Neither transport can
// fetch the other's address:
//
//   - inside the userspace netstack every destination is routed into the
//     WireGuard tunnel - wireguard-go's CreateNetTUN adds the 0.0.0.0/0 route
//     to the tun NIC - so the tunnel reaches overlay addresses and nothing
//     else, and its embedded resolver answers only the zones management
//     distributes (a public name comes back SERVFAIL, which Go reports as
//     "server misbehaving");
//   - the device network is the reverse: it resolves and reaches public names,
//     and has no route to the overlay.
type downloadTransport int

const (
	// deviceTransport dials the phone's own network, resolving through the
	// device's resolver (net.DefaultResolver falls back to the platform
	// resolver where there is no resolv.conf, which is how the engine itself
	// resolves the management domain on Android).
	deviceTransport downloadTransport = iota
	// tunnelTransport dials through the embedded netstack.
	tunnelTransport
)

// overlayPrefix is the CGNAT range every overlay address lives in - the overlay's
// own address space as well as the channel's literal fallback. A
// literal address inside it has no route from the device network, so it decides
// the transport outright rather than being discovered by a connect that would
// otherwise hang until TCP gives up.
var overlayPrefix = netip.MustParsePrefix("100.64.0.0/10")

// transportOrder returns the transports to try for one URL, best first.
//
// A name is left to the device first: an overlay-only name simply does not
// resolve there, which fails fast, whereas a literal overlay address would make
// the device attempt sit in connect() for the whole TCP budget.
func transportOrder(rawURL string) ([]downloadTransport, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse download url %s: %w", rawURL, err)
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, fmt.Errorf("download url %s has no host", rawURL)
	}
	if address, err := netip.ParseAddr(host); err == nil && overlayPrefix.Contains(address) {
		return []downloadTransport{tunnelTransport, deviceTransport}, nil
	}
	return []downloadTransport{deviceTransport, tunnelTransport}, nil
}

// transportClient builds the client for one transport. Reaching the tunnel
// needs the running engine, so a missing engine is a transport error the caller
// falls back from: it must not fail a download the device network can serve.
func transportClient(transport downloadTransport) (*http.Client, error) {
	if transport == tunnelTransport {
		client, err := currentClient()
		if err != nil {
			return nil, err
		}
		httpClient := client.NewHTTPClient()
		// No deadline on either transport: this is a 248 MB transfer whose only
		// deadline is progress, which the caller watches through DownloadState.
		httpClient.Timeout = 0
		return httpClient, nil
	}
	return &http.Client{Timeout: 0}, nil
}

// Download streams a remote file into destPath over whichever transport can
// reach it. An existing .part file is resumed with an HTTP Range request. The
// partial file is retained on cancellation or transport failure.
//
// A single-transport download was the bug: the manifest is read over the device
// network (see src/updater.ts), so a bare filename resolves against the public
// origin, and handing that public URL to the tunnel-only client could only ever
// fail - "dial: lookup ...: server misbehaving" - no matter how healthy the
// channel or the tunnel was.
func Download(url, destPath string) (string, error) {
	order, err := transportOrder(url)
	if err != nil {
		return "", err
	}

	downloadState.Lock()
	if downloadState.active {
		downloadState.Unlock()
		return "", fmt.Errorf("download already in progress")
	}
	downloadState.active = true
	downloadState.destPath = destPath
	downloadState.bytes = 0
	downloadState.total = 0
	downloadState.cancel = false
	downloadState.Unlock()

	defer func() {
		downloadState.Lock()
		downloadState.active = false
		downloadState.Unlock()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchDownloadCancel(ctx, cancel)

	tmpPath := destPath + ".part"

	var firstErr error
	for _, transport := range order {
		client, err := transportClient(transport)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		result, err := downloadOnce(ctx, client, url, destPath, tmpPath)
		if err == nil {
			return result, nil
		}
		if firstErr == nil {
			firstErr = err
		}
		if ctx.Err() != nil {
			// Cancelled by the caller, or stalled long enough that the caller
			// cancelled it: the next transport would only repeat a transfer
			// nobody is waiting for any more.
			return "", err
		}
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("download %s: no transport available", url)
	}
	return "", firstErr
}

// downloadOnce moves the file over one transport, resuming from an existing
// .part and taking one clean pass when the server can no longer satisfy it.
func downloadOnce(ctx context.Context, client *http.Client, url, destPath, tmpPath string) (string, error) {
	offset, err := partialSize(tmpPath)
	if err != nil {
		return "", err
	}

	// attempt fetches the file, resuming from offset when a partial exists.
	// retryFromZero reports that the partial can never be satisfied (the served
	// file no longer matches it) and has to be discarded before trying again.
	attempt := func(offset int64) (string, bool, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", false, err
		}
		if offset > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}

		resp, err := client.Do(req)
		if err != nil {
			return "", false, fmt.Errorf("download %s: %w", url, err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && offset > 0 {
			total := rangeTotal(resp.Header.Get("Content-Range"))
			if total > 0 && total == offset {
				if err := os.Rename(tmpPath, destPath); err != nil {
					return "", false, fmt.Errorf("publish complete partial: %w", err)
				}
				result, err := marshalDownloadResult(destPath, offset, total)
				return result, false, err
			}
			return "", true, nil
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			return "", false, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
		}

		flags := os.O_CREATE | os.O_WRONLY
		if resp.StatusCode == http.StatusPartialContent && offset > 0 {
			flags |= os.O_APPEND
		} else {
			offset = 0
			flags |= os.O_TRUNC
		}
		out, err := os.OpenFile(tmpPath, flags, 0o600)
		if err != nil {
			return "", false, fmt.Errorf("open partial %s: %w", tmpPath, err)
		}
		defer out.Close()

		total := responseTotal(resp, offset)
		setDownloadProgress(offset, total)

		buf := make([]byte, 256*1024)
		written := offset
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, err := out.Write(buf[:n]); err != nil {
					return "", false, fmt.Errorf("write partial %s: %w", tmpPath, err)
				}
				written += int64(n)
				setDownloadProgress(written, total)
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				if ctx.Err() != nil {
					return "", false, fmt.Errorf("download cancelled at %d bytes", written)
				}
				return "", false, fmt.Errorf("read %s at %d bytes: %w", url, written, readErr)
			}
		}
		if total > 0 && written != total {
			return "", false, fmt.Errorf("download incomplete: got %d of %d bytes", written, total)
		}
		if err := out.Sync(); err != nil {
			return "", false, fmt.Errorf("sync partial: %w", err)
		}
		if err := out.Close(); err != nil {
			return "", false, fmt.Errorf("close partial: %w", err)
		}
		if err := os.Rename(tmpPath, destPath); err != nil {
			return "", false, fmt.Errorf("publish download: %w", err)
		}
		result, err := marshalDownloadResult(destPath, written, total)
		return result, false, err
	}

	result, retryFromZero, err := attempt(offset)
	if err == nil && !retryFromZero {
		return result, nil
	}
	if !retryFromZero {
		return "", err
	}
	// A partial the server can no longer satisfy (for example a re-published
	// file of the same name) fails on every later attempt and is never cleaned
	// up by the resumer: drop it and take one clean pass, instead of an update
	// that can never install until the app's data is cleared.
	if err := os.Remove(tmpPath); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("discard stale partial %s: %w", tmpPath, err)
	}
	setDownloadProgress(0, 0)
	result, _, err = attempt(0)
	return result, err
}

func watchDownloadCancel(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			downloadState.Lock()
			stop := downloadState.cancel
			downloadState.Unlock()
			if stop {
				cancel()
				return
			}
		}
	}
}

func partialSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err == nil {
		return info.Size(), nil
	}
	if os.IsNotExist(err) {
		return 0, nil
	}
	return 0, fmt.Errorf("stat partial %s: %w", path, err)
}

func responseTotal(resp *http.Response, offset int64) int64 {
	if resp.StatusCode == http.StatusPartialContent {
		if total := rangeTotal(resp.Header.Get("Content-Range")); total > 0 {
			return total
		}
	}
	if resp.ContentLength >= 0 {
		return offset + resp.ContentLength
	}
	return 0
}

func rangeTotal(value string) int64 {
	index := strings.LastIndex(value, "/")
	if index < 0 || index == len(value)-1 || value[index+1:] == "*" {
		return 0
	}
	total, err := strconv.ParseInt(value[index+1:], 10, 64)
	if err != nil || total < 0 {
		return 0
	}
	return total
}

func setDownloadProgress(bytes, total int64) {
	downloadState.Lock()
	downloadState.bytes = bytes
	downloadState.total = total
	downloadState.Unlock()
}

func marshalDownloadResult(destPath string, bytes, total int64) (string, error) {
	encoded, err := json.Marshal(downloadResult{DestPath: destPath, Bytes: bytes, Total: total})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// CancelDownload requests an early stop of an in-flight Download.
func CancelDownload() {
	downloadState.Lock()
	downloadState.cancel = true
	downloadState.Unlock()
}

// DownloadState reports the current transfer progress as JSON.
func DownloadState() (string, error) {
	downloadState.Lock()
	defer downloadState.Unlock()
	result := map[string]any{
		"active":   downloadState.active,
		"destPath": downloadState.destPath,
		"bytes":    downloadState.bytes,
		"total":    downloadState.total,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
