package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestCanceledUsageHasExplicitClientCauseForHost(t *testing.T) {
	for _, message := range []string{"context canceled", "write tcp: broken pipe", "", "upstream timed out before caller canceled"} {
		tracker := newRequestUsageTracker()
		tracker.record(usagePayload{RequestID: "cancel", AccountID: "keep-account", Usage: usageDetails{TotalTokens: 10}, ErrorCategory: "upstream_stream_timeout", ErrorMessage: "earlier timeout"})
		payload, ok := tracker.finalize("cancel", usageFinalizeInput{status: clientClosedRequestStatus, errorMessage: message})
		if !ok || payload.Success || payload.Status != clientClosedRequestStatus || payload.ErrorCategory != "client_canceled" || payload.AccountID != "keep-account" || payload.Usage.TotalTokens != 10 {
			t.Fatalf("lost final cancellation or recorded usage: %#v", payload)
		}
		// The installed host recognizes this explicit phrase before its generic
		// context-canceled timeout fallback; retain the original detail too.
		if !strings.HasPrefix(payload.ErrorMessage, "client canceled") || !strings.Contains(payload.ErrorMessage, message) {
			t.Fatalf("ambiguous cancellation sent to installed host: %q", payload.ErrorMessage)
		}
	}
	for _, status := range []int{http.StatusGatewayTimeout, http.StatusBadGateway} {
		payload, _ := newRequestUsageTracker().finalize("upstream", usageFinalizeInput{status: status, errorMessage: context.Canceled.Error()})
		if payload.ErrorMessage != context.Canceled.Error() || payload.ErrorCategory == "client_canceled" || payload.Success {
			t.Fatalf("upstream failure changed into caller cancellation: %#v", payload)
		}
	}
}
