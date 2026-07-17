package tinodeowner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	componenthook "ivekit.local/componenthook"
)

func TestNativeTopicWithoutPlacementPreservesUpstreamBehavior(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	registry := mustRegistry(t, newFakeBatchAuthorizer(now))

	opened, err := registry.OpenOrAssert(
		context.Background(),
		"grpNativeTopic",
		map[string]any{"moderated": true},
		now,
	)
	if err != nil || opened {
		t.Fatalf("native topic changed behavior: opened=%v err=%v", opened, err)
	}
}

func TestTrustedPlacementOpensOnceAndFencesConflicts(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := newFakeBatchAuthorizer(now)
	registry := mustRegistry(t, authorizer)
	trusted := trustedPlacement("interaction-a", "reservation-a", "12884901889")

	opened, err := registry.OpenOrAssert(
		context.Background(),
		"grpTopicA",
		trusted,
		now,
	)
	if err != nil || !opened {
		t.Fatalf("open owner: opened=%v err=%v", opened, err)
	}
	opened, err = registry.OpenOrAssert(
		context.Background(),
		"grpTopicA",
		trusted,
		now.Add(time.Second),
	)
	if err != nil || opened {
		t.Fatalf("replay owner: opened=%v err=%v", opened, err)
	}
	if authorizer.OpenCalls() != 1 {
		t.Fatalf("expected one open call, got %d", authorizer.OpenCalls())
	}
	_, err = registry.OpenOrAssert(
		context.Background(),
		"grpTopicA",
		trustedPlacement("interaction-a", "reservation-other", "12884901889"),
		now.Add(time.Second),
	)
	if !errors.Is(err, ErrTopicOwnerMismatch) {
		t.Fatalf("expected owner mismatch, got %v", err)
	}
}

func TestPreparedNewEpochCanIgnorePersistedStaleTrustedMetadata(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	registry := mustRegistry(t, newFakeBatchAuthorizer(now))
	current := Placement{
		InteractionID: "interaction-a",
		ReservationID: "reservation-new",
		OwnerNodeID:   "tinode-a",
		OwnerEpoch:    "12884901899",
	}
	if opened, err := registry.Prepare(
		context.Background(),
		"grpTopicA",
		current,
		now,
	); err != nil || !opened {
		t.Fatalf("prepare newer owner: opened=%v err=%v", opened, err)
	}
	if opened, err := registry.OpenOrAssert(
		context.Background(),
		"grpTopicA",
		trustedPlacement("interaction-a", "reservation-old", "12884901889"),
		now.Add(time.Second),
	); err != nil || opened {
		t.Fatalf("stale persisted metadata overrode prepared owner: opened=%v err=%v", opened, err)
	}
}

func TestBatchRefreshIsolatesOneStaleTopic(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := newFakeBatchAuthorizer(now)
	registry := mustRegistry(t, authorizer)
	for index := 0; index < 130; index++ {
		placement := Placement{
			InteractionID: fmt.Sprintf("interaction-%03d", index),
			ReservationID: fmt.Sprintf("reservation-%03d", index),
			OwnerNodeID:   "tinode-a",
			OwnerEpoch:    fmt.Sprintf("%d", 12884901889+index),
		}
		if _, err := registry.Prepare(
			context.Background(),
			fmt.Sprintf("grpTopic%03d", index),
			placement,
			now,
		); err != nil {
			t.Fatalf("prepare topic %d: %v", index, err)
		}
	}
	authorizer.staleReservation = "reservation-064"
	report := registry.RefreshAll(context.Background(), now.Add(2*time.Second))

	if report.Refreshed != 129 || len(report.Lost) != 1 ||
		report.Lost[0].TopicName != "grpTopic064" {
		t.Fatalf("unexpected refresh report: %+v", report)
	}
	if authorizer.BatchCalls() != 3 {
		t.Fatalf("expected three bounded batches, got %d", authorizer.BatchCalls())
	}
	if err := registry.Assert("grpTopic063", now.Add(3*time.Second)); err != nil {
		t.Fatalf("healthy topic was lost: %v", err)
	}
}

func TestOwnerPrepareHTTPHandlerRequiresSeparateBearerToken(t *testing.T) {
	now := time.Now()
	registry := mustRegistry(t, newFakeBatchAuthorizer(now))
	handler, err := NewHTTPHandler(
		registry,
		"tinode-owner-api-token-123456",
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	body := []byte(`{"topic_name":"grpTopicA","placement":{"interaction_id":"interaction-a","reservation_id":"reservation-a","owner_node_id":"tinode-a","owner_epoch":"12884901889"}}`)

	unauthorized := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	unauthorizedResult := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResult, unauthorized)
	if unauthorizedResult.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", unauthorizedResult.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer tinode-owner-api-token-123456")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusOK {
		t.Fatalf("expected success, got %d: %s", result.Code, result.Body.String())
	}
	if !registry.IsManaged("grpTopicA") {
		t.Fatal("prepared topic is not managed")
	}
}

func mustRegistry(
	t *testing.T,
	authorizer *fakeBatchAuthorizer,
) *Registry {
	t.Helper()
	registry, err := NewRegistry(Config{
		Enabled:         true,
		Required:        true,
		NodeID:          "tinode-a",
		Authorizer:      authorizer,
		BatchAuthorizer: authorizer,
		RefreshInterval: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	return registry
}

func trustedPlacement(
	interactionID string,
	reservationID string,
	ownerEpoch string,
) map[string]any {
	return map[string]any{
		"ivekit_placement": map[string]any{
			"interaction_id": interactionID,
			"reservation_id": reservationID,
			"owner_node_id":  "tinode-a",
			"owner_epoch":    ownerEpoch,
		},
	}
}

type fakeBatchAuthorizer struct {
	mu               sync.Mutex
	now              time.Time
	openCalls        int
	batchCalls       int
	staleReservation string
}

func newFakeBatchAuthorizer(now time.Time) *fakeBatchAuthorizer {
	return &fakeBatchAuthorizer{now: now}
}

func (fake *fakeBatchAuthorizer) Authorize(
	_ context.Context,
	request componenthook.AuthorizationRequest,
) (componenthook.Authorization, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.openCalls++
	return fake.authorization(request, 1), nil
}

func (fake *fakeBatchAuthorizer) AuthorizeBatch(
	_ context.Context,
	requests []componenthook.AuthorizationRequest,
) ([]componenthook.BatchAuthorizationResult, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.batchCalls++
	results := make([]componenthook.BatchAuthorizationResult, 0, len(requests))
	for _, request := range requests {
		result := componenthook.BatchAuthorizationResult{Request: request}
		if request.ReservationID == fake.staleReservation {
			result.Error = &componenthook.HTTPAuthorizationError{
				Code:       "stale_owner_epoch",
				StatusCode: http.StatusConflict,
			}
		} else {
			result.Authorization = fake.authorization(request, 2)
		}
		results = append(results, result)
	}
	return results, nil
}

func (fake *fakeBatchAuthorizer) authorization(
	request componenthook.AuthorizationRequest,
	sequence uint64,
) componenthook.Authorization {
	return componenthook.Authorization{
		Allowed:        true,
		Component:      "tinode",
		NodeID:         "tinode-a",
		CellLeaseEpoch: 3,
		OwnerEpoch:     request.OwnerEpoch,
		StateSequence:  sequence,
		LeaseExpiresAt: fake.now.Add(10 * time.Second),
	}
}

func (fake *fakeBatchAuthorizer) OpenCalls() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.openCalls
}

func (fake *fakeBatchAuthorizer) BatchCalls() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.batchCalls
}
