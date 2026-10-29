package portal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"

	"github.com/netbirdio/netbird/client/iface/netstack"
	"github.com/netbirdio/netbird/client/internal/auth"
	"github.com/netbirdio/netbird/client/internal/profilemanager"
)

// enableNetstackMode mirrors the environment setup nb.New performs when it
// runs with userspace networking. Auth dials go through the custom nbnet
// dialer whose Control hook short-circuits only when netstack mode is
// enabled; without it Android rejects the socket in Portal grants.
func enableNetstackMode() error {
	if err := os.Setenv(netstack.EnvUseNetstackMode, "true"); err != nil {
		return fmt.Errorf("enable netstack mode: %w", err)
	}
	if err := os.Setenv(netstack.EnvSkipProxy, "true"); err != nil {
		return fmt.Errorf("skip proxy: %w", err)
	}
	return nil
}

var ssoFlow struct {
	sync.Mutex
	active  bool
	done    bool
	errText string
	url     string
}

type ssoStatus struct {
	State string `json:"state"` // waiting | done | error | not_started
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

func resetSSOState() {
	ssoFlow.Lock()
	defer ssoFlow.Unlock()
	ssoFlow.active = false
	ssoFlow.done = false
	ssoFlow.errText = ""
	ssoFlow.url = ""
}

// LoginSSO starts the authorization flow the management server offers. A
// self-hosted server answers with the PKCE authorization-code flow; NetBird
// Cloud answers with the device authorization flow (NetBird's own account
// login, not the embedded IdP). It returns the URL the UI must open (WebView)
// and reports progress through SSOStatus; for PKCE the browser redirects back
// to the loopback callback, for device flow the client polls the token
// endpoint while the user approves the device.
func LoginSSO(deviceName, managementURL, configPath, statePath string) (string, error) {
	resetSSOState()
	if err := enableNetstackMode(); err != nil {
		return "", err
	}

	mgmURL, err := url.Parse(managementURL)
	if err != nil {
		return "", fmt.Errorf("parse management url: %w", err)
	}

	input := profilemanager.ConfigInput{
		ConfigPath:    configPath,
		ManagementURL: managementURL,
	}
	cfg, err := profilemanager.UpdateOrCreateConfig(input)
	if err != nil {
		return "", fmt.Errorf("load config: %w", err)
	}

	ctx := context.Background()
	authClient, err := auth.NewAuth(ctx, cfg.PrivateKey, mgmURL, cfg)
	if err != nil {
		return "", fmt.Errorf("create auth client: %w", err)
	}

	needsLogin, err := authClient.IsLoginRequired(ctx)
	if err != nil {
		authClient.Close()
		return "", fmt.Errorf("check login required: %w", err)
	}

	// Already authenticated with a persisted token: nothing to do.
	if !needsLogin {
		ssoFlow.Lock()
		ssoFlow.done = true
		ssoFlow.active = true
		ssoFlow.Unlock()
		authClient.Close()
		return "", nil
	}

	flow, err := authClient.GetOAuthFlow(ctx, false, "")
	if err != nil {
		authClient.Close()
		return "", fmt.Errorf("get oauth flow: %w", err)
	}

	flowInfo, err := flow.RequestAuthInfo(ctx)
	if err != nil {
		authClient.Close()
		return "", fmt.Errorf("request auth info: %w", err)
	}

	ssoFlow.Lock()
	ssoFlow.active = true
	ssoFlow.url = flowInfo.VerificationURIComplete
	ssoFlow.Unlock()

	go func() {
		token, err := flow.WaitToken(ctx, flowInfo)
		if err != nil {
			ssoFlow.Lock()
			ssoFlow.errText = fmt.Sprintf("wait token: %v", err)
			ssoFlow.done = true
			ssoFlow.Unlock()
			authClient.Close()
			return
		}
		_, authError := authClient.Login(ctx, "", token.GetTokenToUse())
		if authError {
			ssoFlow.Lock()
			ssoFlow.errText = "authentication rejected by management"
			ssoFlow.done = true
			ssoFlow.Unlock()
			authClient.Close()
			return
		}
		ssoFlow.Lock()
		ssoFlow.done = true
		ssoFlow.Unlock()
		authClient.Close()
	}()

	return flowInfo.VerificationURIComplete, nil
}

// SSOStatus reports the state of the in-flight authorization flow.
func SSOStatus() (string, error) {
	ssoFlow.Lock()
	defer ssoFlow.Unlock()
	st := ssoStatus{URL: ssoFlow.url}
	switch {
	case !ssoFlow.active:
		st.State = "not_started"
	case !ssoFlow.done:
		st.State = "waiting"
	case ssoFlow.errText != "":
		st.State = "error"
		st.Error = ssoFlow.errText
	default:
		st.State = "done"
	}
	encoded, err := json.Marshal(st)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// IsSSOConfigured reports whether a persisted profile already carries valid
// credentials (used by the app to skip the login screen on relaunch).
func IsSSOConfigured(managementURL, configPath string) (bool, error) {
	if err := enableNetstackMode(); err != nil {
		return false, err
	}
	mgmURL, err := url.Parse(managementURL)
	if err != nil {
		return false, fmt.Errorf("parse management url: %w", err)
	}
	input := profilemanager.ConfigInput{
		ConfigPath:    configPath,
		ManagementURL: managementURL,
	}
	cfg, err := profilemanager.UpdateOrCreateConfig(input)
	if err != nil {
		return false, fmt.Errorf("load config: %w", err)
	}
	ctx := context.Background()
	authClient, err := auth.NewAuth(ctx, cfg.PrivateKey, mgmURL, cfg)
	if err != nil {
		return false, fmt.Errorf("create auth client: %w", err)
	}
	defer authClient.Close()
	needsLogin, err := authClient.IsLoginRequired(ctx)
	if err != nil {
		// An unreachable management server is not "no credentials": a caller
		// that gets a plain false here would treat an outage as an expired
		// login, which is the regression this app already fixed once.
		return false, fmt.Errorf("check login required: %w", err)
	}
	return !needsLogin, nil
}
