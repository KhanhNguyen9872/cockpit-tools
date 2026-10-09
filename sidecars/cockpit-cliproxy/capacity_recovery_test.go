package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestCapacityFailurePreservesUpstreamHTTPAndStreamErrors(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable} {
		for _, code := range []string{"server_is_overloaded", "slow_down", "usage_limit_reached"} {
			err := relayStatusError{
				status:  status,
				message: `{"error":{"code":"` + code + `","message":"original upstream failure"}}`,
			}
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
			(&relayServer{}).writeExecutorError(c, err)
			wantCode := "upstream_error"
			if status == http.StatusTooManyRequests {
				wantCode = "rate_limited"
			}
			if w.Code != status || gjson.Get(w.Body.String(), "error.code").String() != wantCode ||
				gjson.Get(w.Body.String(), "error.message").String() != err.Error() {
				t.Fatalf("upstream failure changed: %d %s", w.Code, w.Body.String())
			}
			w = httptest.NewRecorder()
			c, _ = gin.CreateTestContext(w)
			writeStreamTerminalErrorForFormat(c, err, sdktranslator.FormatOpenAIResponse)
			if !strings.Contains(w.Body.String(), code) || strings.Contains(w.Body.String(), `"code":"server_error"`) {
				t.Fatalf("upstream stream error changed: %s", w.Body.String())
			}
		}
	}
}

func TestMeaningfulStreamOutputAndOverloadDetection(t *testing.T) {
	// Handshake events must NOT be treated as meaningful output
	handshakeEvents := [][]byte{
		[]byte(`{"type":"response.created","sequence_number":0,"response":{"id":"resp_1"}}`),
		[]byte(`data: {"type":"response.created","sequence_number":0}`),
		[]byte(`{"type":"response.in_progress","sequence_number":1}`),
		[]byte(`data: {"type":"response.in_progress","sequence_number":1}`),
		[]byte(`: keep-alive`),
		[]byte(`data: [DONE]`),
		[]byte(`{"choices":[{"index":0,"delta":{"role":"assistant"}}]}`),
	}
	for _, event := range handshakeEvents {
		if hasMeaningfulStreamOutput(event) {
			t.Fatalf("expected event %s to not be meaningful output", string(event))
		}
	}

	// Output events MUST be treated as meaningful output
	outputEvents := [][]byte{
		[]byte(`{"type":"response.output_item.added","sequence_number":2}`),
		[]byte(`{"type":"response.output_text.delta","delta":"Hello"}`),
		[]byte(`{"type":"response.reasoning_summary_text.delta","delta":"Thinking..."}`),
		[]byte(`{"choices":[{"index":0,"delta":{"content":"Hi"}}]}`),
		[]byte(`{"choices":[{"index":0,"delta":{"reasoning_content":"Thought"}}]}`),
		[]byte(`data: {"choices":[{"index":0,"delta":{"content":"World"}}]}`),
		[]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`),
	}
	for _, event := range outputEvents {
		if !hasMeaningfulStreamOutput(event) {
			t.Fatalf("expected event %s to be meaningful output", string(event))
		}
	}

	// Overload rejections
	overloadPayload := []byte(`{"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null,"type":"service_unavailable_error"},"sequence_number":2}`)
	if !isPayloadOverload(overloadPayload) {
		t.Fatalf("expected overloadPayload to be recognized as overload")
	}
	if hasMeaningfulStreamOutput(overloadPayload) {
		t.Fatalf("overloadPayload must not be treated as meaningful output")
	}
}

