package main

import (
	"testing"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func TestAPIKeyScopePrecedesBackupFallback(t *testing.T) {
	s, auths := rotationSelectorForTest()
	s.manifest.CustomRoutingRules = []customRoutingRule{{AccountID: "c", IsBackup: true}}
	selector := buildCoreAuthSelector(nil, s, s.manifest)
	auth, err := selector.Pick(rotationContextForTest("key", "c"), "codex", "gpt-5.4", cliproxyexecutor.Options{}, auths)
	if err != nil || auth == nil || auth.ID != "c.json" {
		t.Fatalf("outside-scope regular accounts suppressed authorized backup: auth=%#v err=%v", auth, err)
	}
}
