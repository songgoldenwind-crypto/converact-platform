package componenthook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestHTTPAuthorizerUsesBoundedAuthenticatedContract(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/v1/authorize" {
				t.Fatalf("unexpected path %s", request.URL.Path)
			}
			if request.Header.Get("Authorization") != "Bearer component-node-token-1234567890" {
				t.Fatalf("missing bearer token")
			}
			var body AuthorizationRequest
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if body.Operation != OperationOpen {
				t.Fatalf("unexpected operation %s", body.Operation)
			}
			payload, err := json.Marshal(map[string]any{
				"data": map[string]any{
					"allowed":          true,
					"component":        "livekit",
					"node_id":          "livekit-a",
					"cell_lease_epoch": 3,
					"owner_epoch":      "12884901889",
					"state_sequence":   7,
					"lease_expires_at": "2026-07-16T08:00:10.000Z",
				},
			})
			if err != nil {
				t.Fatalf("marshal response: %v", err)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(string(payload))),
			}, nil
		}),
	}

	authorizer, err := NewHTTPAuthorizer(HTTPAuthorizerConfig{
		Endpoint:     "http://node-admission.internal:3210",
		ServiceToken: "component-node-token-1234567890",
		Timeout:      time.Second,
		Client:       client,
	})
	if err != nil {
		t.Fatalf("new authorizer: %v", err)
	}
	result, err := authorizer.Authorize(context.Background(), AuthorizationRequest{
		Request: Request{
			ReservationID: "reservation-a",
			InteractionID: "room-a",
			OwnerEpoch:    "12884901889",
		},
		Operation: OperationOpen,
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if !result.Allowed || result.StateSequence != 7 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestHTTPAuthorizerRejectsOversizedResponses(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Header:        make(http.Header),
				ContentLength: 70_000,
				Body:          io.NopCloser(strings.NewReader("")),
			}, nil
		}),
	}

	authorizer, err := NewHTTPAuthorizer(HTTPAuthorizerConfig{
		Endpoint:     "http://node-admission.internal:3210",
		ServiceToken: "component-node-token-1234567890",
		Timeout:      time.Second,
		Client:       client,
	})
	if err != nil {
		t.Fatalf("new authorizer: %v", err)
	}
	_, err = authorizer.Authorize(context.Background(), AuthorizationRequest{
		Request: Request{
			ReservationID: "reservation-a",
			InteractionID: "room-a",
			OwnerEpoch:    "12884901889",
		},
		Operation: OperationOpen,
	})
	if err == nil {
		t.Fatal("expected oversized response error")
	}
}

func TestHTTPAuthorizerBatchRefreshKeepsPerOwnerFailures(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/v1/authorize/batch" {
				t.Fatalf("unexpected path %s", request.URL.Path)
			}
			payload := `{"data":{"results":[` +
				`{"request":{"reservation_id":"reservation-a","interaction_id":"room-a","owner_epoch":"12884901889","operation":"mutate"},` +
				`"authorization":{"allowed":true,"component":"livekit","node_id":"livekit-a","cell_lease_epoch":3,"owner_epoch":"12884901889","state_sequence":7,"lease_expires_at":"2026-07-16T08:00:10.000Z"}},` +
				`{"request":{"reservation_id":"reservation-b","interaction_id":"room-b","owner_epoch":"12884901890","operation":"mutate"},` +
				`"error":{"code":"stale_owner_epoch","status":409,"retryable":false}}]}}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(payload)),
			}, nil
		}),
	}
	authorizer, err := NewHTTPAuthorizer(HTTPAuthorizerConfig{
		Endpoint:     "http://node-admission.internal:3210",
		ServiceToken: "component-node-token-1234567890",
		Timeout:      time.Second,
		Client:       client,
	})
	if err != nil {
		t.Fatalf("new authorizer: %v", err)
	}
	results, err := authorizer.AuthorizeBatch(context.Background(), []AuthorizationRequest{
		{
			Request: Request{
				ReservationID: "reservation-a",
				InteractionID: "room-a",
				OwnerEpoch:    "12884901889",
			},
			Operation: OperationMutate,
		},
		{
			Request: Request{
				ReservationID: "reservation-b",
				InteractionID: "room-b",
				OwnerEpoch:    "12884901890",
			},
			Operation: OperationMutate,
		},
	})
	if err != nil {
		t.Fatalf("batch authorize: %v", err)
	}
	if !results[0].Authorization.Allowed || results[0].Error != nil {
		t.Fatalf("unexpected allowed result: %+v", results[0])
	}
	if results[1].Error == nil || results[1].Error.Code != "stale_owner_epoch" {
		t.Fatalf("unexpected failed result: %+v", results[1])
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	return function(request)
}
