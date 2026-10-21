package main

import (
	"context"
	"encoding/json"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyOAuthReserveCannotBlockRoutingOrSurviveManifestSerialization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	raw := `{"accounts":[{"id":"oauth-fixture","email":"fixture@example.invalid","authId":"oauth-fixture.json","remainingQuota":1,"quotaReserve":{"hourlyThresholdPercent":99,"weeklyThresholdPercent":99,"hourlyRemainingPercent":1,"weeklyRemainingPercent":1}}]}`
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := loadManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	selector := buildCoreAuthSelector(nil, &cockpitSelector{manifest: m}, m)
	account := &coreauth.Auth{ID: "oauth-fixture.json", Provider: "codex", Status: coreauth.StatusActive}
	selected, err := selector.Pick(context.Background(), "codex", "gpt-5.4", cliproxyexecutor.Options{}, []*coreauth.Auth{account})
	if err != nil || selected == nil || selected.ID != account.ID {
		t.Fatalf("legacy reserve still blocks remaining quota: selected=%v err=%v", selected, err)
	}
	encoded, err := json.Marshal(m.Accounts[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "quotaReserve") {
		t.Fatalf("obsolete policy survived serialization: %s", encoded)
	}
	account.Disabled = true
	if selected, err = selector.Pick(context.Background(), "codex", "gpt-5.4", cliproxyexecutor.Options{}, []*coreauth.Auth{account}); err == nil || selected != nil {
		t.Fatal("removing reserve must not admit a disabled account")
	}
}
