package portal

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRangeTotal(t *testing.T) {
	tests := []struct {
		name  string
		value string
		total int64
	}{
		{name: "valid", value: "bytes 1048576-2097151/283632534", total: 283632534},
		{name: "complete", value: "bytes */283632534", total: 283632534},
		{name: "unknown", value: "bytes 0-99/*", total: 0},
		{name: "invalid", value: "garbage", total: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := rangeTotal(test.value); got != test.total {
				t.Fatalf("rangeTotal(%q) = %d, want %d", test.value, got, test.total)
			}
		})
	}
}

func TestResponseTotal(t *testing.T) {
	partial := &http.Response{
		StatusCode:    http.StatusPartialContent,
		ContentLength: 1024,
		Header:        http.Header{"Content-Range": []string{"bytes 4096-5119/8192"}},
	}
	if got := responseTotal(partial, 4096); got != 8192 {
		t.Fatalf("partial total = %d, want 8192", got)
	}

	full := &http.Response{StatusCode: http.StatusOK, ContentLength: 2048, Header: http.Header{}}
	if got := responseTotal(full, 0); got != 2048 {
		t.Fatalf("full total = %d, want 2048", got)
	}
}

func TestPartialSize(t *testing.T) {
	path := t.TempDir() + "/update.apk.part"
	if err := os.WriteFile(path, make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := partialSize(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4096 {
		t.Fatalf("partial size = %d, want 4096", got)
	}
}

// The channel is a public HTTPS name and the overlay is a literal address, and
// neither transport can fetch the other's: the netstack routes every
// destination into the tunnel and answers only the zones management
// distributes, while the device network has no route to the overlay. Picking
// the transport from the URL is what keeps the download from being handed to a
// client that cannot possibly serve it.
func TestTransportOrder(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want []downloadTransport
	}{
		{
			name: "public name goes out over the device network",
			url:  "https://anywhere.example.com/AnywhereWork.apk",
			want: []downloadTransport{deviceTransport, tunnelTransport},
		},
		{
			name: "the channel's literal fallback is tunnel-only",
			url:  "http://100.64.0.20/AnywhereWork.apk",
			want: []downloadTransport{tunnelTransport, deviceTransport},
		},
		{
			name: "another overlay subrange is tunnel-only",
			url:  "http://100.100.138.168/AnywhereWork.apk",
			want: []downloadTransport{tunnelTransport, deviceTransport},
		},
		{
			name: "a public literal address goes out over the device network",
			url:  "https://203.0.113.10/AnywhereWork.apk",
			want: []downloadTransport{deviceTransport, tunnelTransport},
		},
		{
			// Overlay names cannot be told apart from public ones without
			// compiling the zone list twice, and the device resolver answers
			// NXDOMAIN for them quickly: the fallback is the cheap decision.
			name: "an overlay name is tried on the device first, then the tunnel",
			url:  "http://tx.vpn/AnywhereWork.apk",
			want: []downloadTransport{deviceTransport, tunnelTransport},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := transportOrder(test.url)
			if err != nil {
				t.Fatalf("transportOrder(%q) failed: %v", test.url, err)
			}
			if len(got) != len(test.want) {
				t.Fatalf("transportOrder(%q) = %v, want %v", test.url, got, test.want)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("transportOrder(%q) = %v, want %v", test.url, got, test.want)
				}
			}
		})
	}
}

func TestTransportOrderRejectsAUrlWithoutAHost(t *testing.T) {
	if _, err := transportOrder("file:///tmp/AnywhereWork.apk"); err == nil {
		t.Fatal("a URL with no host must be refused, not downloaded")
	}
}

// No engine is running in this test, which is the point: the public channel
// must download over the device network without the tunnel. Handing this URL to
// the netstack client is what produced "server misbehaving" on a connected
// phone.
func TestDownloadUsesTheDeviceNetworkWithoutAnEngine(t *testing.T) {
	payload := bytes.Repeat([]byte("anywhere-work"), 8192)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "AnywhereWork.apk", time.Time{}, bytes.NewReader(payload))
	}))
	defer server.Close()

	destPath := filepath.Join(t.TempDir(), "update.apk")
	encoded, err := Download(server.URL+"/AnywhereWork.apk", destPath)
	if err != nil {
		t.Fatalf("download over the device network failed: %v", err)
	}
	if !strings.Contains(encoded, `"total":`) {
		t.Fatalf("result is not a download result: %s", encoded)
	}
	written, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("read published file: %v", err)
	}
	if !bytes.Equal(written, payload) {
		t.Fatalf("published %d bytes, want %d", len(written), len(payload))
	}
}

// A partial left by an interrupted transfer has to keep resuming after the
// transport rework: the resumed bytes must be appended, not re-fetched.
func TestDownloadResumesOverTheDeviceNetwork(t *testing.T) {
	payload := bytes.Repeat([]byte("anywhere-work"), 8192)
	var sawRange string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawRange = r.Header.Get("Range")
		http.ServeContent(w, r, "AnywhereWork.apk", time.Time{}, bytes.NewReader(payload))
	}))
	defer server.Close()

	dir := t.TempDir()
	destPath := filepath.Join(dir, "update.apk")
	resumed := int64(4096)
	if err := os.WriteFile(destPath+".part", payload[:resumed], 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Download(server.URL+"/AnywhereWork.apk", destPath); err != nil {
		t.Fatalf("resumed download failed: %v", err)
	}
	if sawRange != "bytes=4096-" {
		t.Fatalf("server saw Range %q, want bytes=4096-", sawRange)
	}
	written, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("read published file: %v", err)
	}
	if !bytes.Equal(written, payload) {
		t.Fatalf("resumed file is %d bytes and does not match, want %d", len(written), len(payload))
	}
}

// A channel that answers with an error must surface the device attempt's
// failure, not the tunnel's "client not started", or a broken channel would
// read as a broken tunnel.
func TestDownloadReportsTheDeviceFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	destPath := filepath.Join(t.TempDir(), "update.apk")
	_, err := Download(server.URL+"/AnywhereWork.apk", destPath)
	if err == nil {
		t.Fatal("an HTTP 500 channel must be reported as a failure")
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("error %q does not report the device attempt's HTTP status", err)
	}
}
