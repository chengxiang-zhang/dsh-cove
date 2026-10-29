package portal

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"sort"
	"sync"
	"time"

	ice "github.com/pion/ice/v4"
	"github.com/pion/stun/v3"

	"github.com/netbirdio/netbird/client/iface/netstack"
	nbice "github.com/netbirdio/netbird/client/internal/peer/ice"
	"github.com/netbirdio/netbird/client/internal/stdnet"
)

// probeSTUN is the STUN endpoint the connectivity report probes. A phone that
// cannot gather a server-reflexive candidate still has host candidates; the
// probe uses one real public STUN URI so the report shows both kinds when the
// device can reach it. Deployments that run their own STUN server replace this
// value at build time rather than committing an internal endpoint here.
const probeSTUN = "stun:stun.l.google.com:19302"

// discoveryReport is the JSON DescribeInterfaceDiscovery returns. Counts are
// what a caller asserts on; the string slices exist so a failing run says which
// interfaces and candidates the device produced.
type discoveryReport struct {
	// NetstackMode records that the probe mirrored the engine's userspace mode.
	NetstackMode bool `json:"netstackMode"`
	// NetError is what net.Interfaces() answered inside this app process.
	NetError string `json:"netError"`
	NetCount int    `json:"netCount"`
	// Discovered is the interface list the engine's ICE discoverer sees.
	Discovered    []string `json:"discovered"`
	DiscoverError string   `json:"discoverError"`
	// Candidates is the ICE candidate list gathered the way the engine does it.
	Candidates  []string `json:"candidates"`
	GatherError string   `json:"gatherError"`
}

// DescribeInterfaceDiscovery reports how this device answers the two questions
// that decide whether a direct connection is possible at all:
//
//  1. does interface enumeration work in this app process, and
//  2. does the ICE agent built from it gather any candidate.
//
// Android 11+ denies an ordinary app the NETLINK_ROUTE bind and RTM_GETLINK that
// net.Interfaces() issues, so (1) answers "permission denied" there and the
// engine used to resolve that into an empty interface list that ICE accepted
// silently: no candidate, no direct path, everything on the relay. The ICE
// discoverer therefore goes through anet (see scripts/build-aar.sh), and this
// report backs the on-device regression test that keeps it that way.
func DescribeInterfaceDiscovery() (string, error) {
	report := discoveryReport{Discovered: []string{}, Candidates: []string{}}

	// Baseline: the call the engine must not depend on.
	if ifaces, err := net.Interfaces(); err != nil {
		report.NetError = err.Error()
	} else {
		report.NetCount = len(ifaces)
	}

	// Mirror the engine's userspace mode so the discoverer under test is the one
	// the ICE agent actually uses on a phone.
	if err := os.Setenv(netstack.EnvUseNetstackMode, "true"); err != nil {
		return "", err
	}
	report.NetstackMode = true

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if discovered, err := stdnet.NewNet(ctx, nil); err != nil {
		report.DiscoverError = err.Error()
	} else if ifaces, err := discovered.Interfaces(); err != nil {
		report.DiscoverError = err.Error()
	} else {
		for _, iface := range ifaces {
			report.Discovered = append(report.Discovered, iface.Name)
		}
	}
	sort.Strings(report.Discovered)

	// Build the agent exactly as the engine does: same discoverer, same STUN
	// list shape, host and server-reflexive candidates.
	stunTurn := &nbice.StunTurn{}
	if uri, err := stun.ParseURI(probeSTUN); err == nil {
		stunTurn.Store([]*stun.URI{uri})
	}
	agent, err := nbice.NewAgent(
		ctx,
		nil,
		nbice.Config{StunTurn: stunTurn},
		[]ice.CandidateType{ice.CandidateTypeHost, ice.CandidateTypeServerReflexive},
		"diagnoseufrag",
		// pion requires at least 128 bits of ICE password material.
		"diagnosepassword-0123456789abcdef",
	)
	if err != nil {
		report.GatherError = err.Error()
	} else {
		var mu sync.Mutex
		agent.OnCandidate(func(candidate ice.Candidate) {
			if candidate == nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			report.Candidates = append(report.Candidates, candidate.String())
		})
		if err := agent.GatherCandidates(); err != nil {
			report.GatherError = err.Error()
		}
		time.Sleep(4 * time.Second)
		mu.Lock()
		sort.Strings(report.Candidates)
		mu.Unlock()
		if err := agent.Close(); err != nil {
			report.GatherError = err.Error()
		}
	}

	raw, err := json.Marshal(report)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
