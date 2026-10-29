// Command anywhere-tunnel exposes the embedded NetBird engine over a JSON-lines
// protocol on stdin/stdout.
//
// It exists so the desktop client can drive an app-scoped overlay without a
// native binding: no gomobile, no per-platform bridge, the same helper binary
// shape on macOS, Windows and Linux. The Node agent owns the process and reads
// one JSON response per request.
//
// The binding package below is NetBird's own client library running in userspace
// (netstack inside this process). It never creates a system interface and never
// touches the system resolver, which is the whole point: joining the private
// network must not take the machine over.
//
// Protocol, one request per line:
//
//	{"id":1,"cmd":"sso-configured","managementUrl":"...","configPath":"..."}
//	{"id":2,"cmd":"login","deviceName":"...","managementUrl":"...","configPath":"...","statePath":"..."}
//	{"id":3,"cmd":"sso-status"}
//	{"id":4,"cmd":"start","setupKey":"","deviceName":"...","managementUrl":"...","configPath":"...","statePath":"..."}
//	{"id":5,"cmd":"status"}
//	{"id":6,"cmd":"services"}
//	{"id":7,"cmd":"peers"}
//	{"id":8,"cmd":"proxy"}
//	{"id":9,"cmd":"fetch","url":"http://dsh.<machine>.netbird/"}
//	{"id":10,"cmd":"stop"}
//	{"id":11,"cmd":"version"}
//
// Responses are {"id":N,"ok":true,"result":...} or {"id":N,"ok":false,"error":"..."}.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"

	portal "github.com/netbirdio/netbird/client/portalbind"
)

// protocolVersion is the JSON-lines contract this helper speaks. The agent and
// the helper are updated independently, so a mismatch must fail loudly at
// startup instead of degrading into a half-working overlay.
const protocolVersion = 1

// buildVersion is stamped with -ldflags at build time. "dev" marks an un-stamped
// local build, which is not fit for a released bundle.
var buildVersion = "dev"

type request struct {
	ID            int    `json:"id"`
	Cmd           string `json:"cmd"`
	SetupKey      string `json:"setupKey"`
	DeviceName    string `json:"deviceName"`
	ManagementURL string `json:"managementUrl"`
	ConfigPath    string `json:"configPath"`
	StatePath     string `json:"statePath"`
	URL           string `json:"url"`
	Address       string `json:"address"`
	Host          string `json:"host"`
}

type response struct {
	ID     int    `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

/** raw keeps a JSON string returned by the binding as JSON, not as a quoted string. */
func raw(value string) json.RawMessage {
	if json.Valid([]byte(value)) {
		return json.RawMessage(value)
	}
	encoded, _ := json.Marshal(value)
	return json.RawMessage(encoded)
}

func failed(id int, err error) response {
	return response{ID: id, OK: false, Error: err.Error()}
}

func dispatch(req request) response {
	switch req.Cmd {
	case "sso-configured":
		configured, err := portal.IsSSOConfigured(req.ManagementURL, req.ConfigPath)
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: configured}

	case "login":
		url, err := portal.LoginSSO(req.DeviceName, req.ManagementURL, req.ConfigPath, req.StatePath)
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: url}

	case "sso-status":
		status, err := portal.SSOStatus()
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: raw(status)}

	case "start":
		if err := portal.Start(req.SetupKey, req.DeviceName, req.ManagementURL, req.ConfigPath, req.StatePath); err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: "started"}

	case "status":
		status, err := portal.Status()
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: raw(status)}

	case "services":
		services, err := portal.ListServices()
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: raw(services)}

	case "peers":
		peers, err := portal.PeerAddresses()
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: raw(peers)}

	case "proxy":
		url, err := portal.StartProxy()
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: url}

	case "fetch":
		body, err := portal.Fetch(req.URL)
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: body}

	case "fetch-static":
		// The app resolves the name and hands the address in: the netstack's own
		// resolver only answers this network's zones, while the netstack still has
		// to decide which route carries the request.
		body, err := portal.FetchStatic(req.URL, req.Address, req.Host)
		if err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: body}

	case "stop":
		if err := portal.Stop(); err != nil {
			return failed(req.ID, err)
		}
		return response{ID: req.ID, OK: true, Result: "stopped"}

	case "version":
		return response{ID: req.ID, OK: true, Result: versionInfo()}

	default:
		return response{ID: req.ID, OK: false, Error: fmt.Sprintf("unknown command %q", req.Cmd)}
	}
}

// netbirdVersion is stamped with -ldflags from the tag the tree was built from.
// The engine inside this binary is the thing that must stay pinned: an agent
// that hot-updates itself may never drag the overlay library with it.
var netbirdVersion = "unknown"

// versionInfo reports what this binary is, so the agent can refuse a mismatched
// pair before touching the network, and so packaging can generate third-party
// attributions from the same build the binary came from.
func versionInfo() map[string]any {
	info := map[string]any{
		"protocol": protocolVersion,
		"helper":   buildVersion,
		"netbird":  netbirdVersion,
		"deps":     0,
	}
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	info["go"] = build.GoVersion
	info["mainModule"] = build.Main.Path
	if build.Main.Version != "" && build.Main.Version != "(devel)" {
		info["netbird"] = build.Main.Version
	}
	count := 0
	embedded := map[string]string{}
	// The full module list is reported so packaging can generate the third-party
	// notices from the same build the binary came from, rather than from a list
	// maintained by hand that drifts.
	modules := make([]map[string]string, 0, len(build.Deps))
	for _, dep := range build.Deps {
		count++
		modules = append(modules, map[string]string{"path": dep.Path, "version": dep.Version})
		switch dep.Path {
		case "github.com/wlynxg/anet":
			embedded["anet"] = dep.Version
		case "golang.zx2c4.com/wireguard":
			embedded["wireguard"] = dep.Version
		case "gvisor.dev/gvisor":
			embedded["netstack"] = dep.Version
		}
	}
	info["modules"] = modules
	info["deps"] = count
	for name, version := range embedded {
		info[name] = version
	}
	// A tag checkout carries its revision, which is the evidence that the pinned
	// version in this report is the one that was actually compiled.
	for _, setting := range build.Settings {
		if setting.Key == "vcs.revision" {
			info["revision"] = setting.Value
		}
		if setting.Key == "vcs.modified" {
			info["modified"] = setting.Value
		}
	}
	return info
}

func main() {
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			encoded, _ := json.Marshal(response{ID: req.ID, OK: false, Error: "bad request: " + err.Error()})
			fmt.Fprintln(writer, string(encoded))
			writer.Flush()
			continue
		}
		encoded, err := json.Marshal(dispatch(req))
		if err != nil {
			encoded, _ = json.Marshal(response{ID: req.ID, OK: false, Error: "encode response: " + err.Error()})
		}
		fmt.Fprintln(writer, string(encoded))
		writer.Flush()
	}
}