package livekitowner

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	componenthook "ivekit.local/componenthook"
)

func TestDisabledRegistryPreservesUpstreamRoomBehavior(t *testing.T) {
	registry, err := NewRegistry(Config{})
	if err != nil {
		t.Fatalf("new disabled registry: %v", err)
	}
	opened, err := registry.OpenOrAssert(
		context.Background(),
		"room-a",
		"",
		time.Now(),
	)
	if err != nil || opened {
		t.Fatalf("disabled registry changed behavior: opened=%v err=%v", opened, err)
	}
}

func TestRoomOwnerOpensOnceAndFencesConflictingTokenMetadata(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := newFakeBatchAuthorizer(now)
	registry := mustRegistry(t, authorizer)
	metadata := placementMetadata("interaction-a", "reservation-a", "12884901889")

	opened, err := registry.OpenOrAssert(
		context.Background(),
		"room-a",
		metadata,
		now,
	)
	if err != nil || !opened {
		t.Fatalf("open owner: opened=%v err=%v", opened, err)
	}
	opened, err = registry.OpenOrAssert(
		context.Background(),
		"room-a",
		metadata,
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
		"room-a",
		placementMetadata("interaction-a", "reservation-other", "12884901889"),
		now.Add(time.Second),
	)
	if !errors.Is(err, ErrRoomOwnerMismatch) {
		t.Fatalf("expected room owner mismatch, got %v", err)
	}
	if err := registry.Close(context.Background(), "room-a"); err != nil {
		t.Fatalf("close room owner: %v", err)
	}
}

func TestBatchRefreshIsolatesStaleRoomWithoutDroppingHealthyOwners(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := newFakeBatchAuthorizer(now)
	registry := mustRegistry(t, authorizer)
	for index := 0; index < 130; index++ {
		interactionID := fmt.Sprintf("interaction-%03d", index)
		reservationID := fmt.Sprintf("reservation-%03d", index)
		ownerEpoch := fmt.Sprintf("%d", 12884901889+index)
		if _, err := registry.OpenOrAssert(
			context.Background(),
			fmt.Sprintf("room-%03d", index),
			placementMetadata(interactionID, reservationID, ownerEpoch),
			now,
		); err != nil {
			t.Fatalf("open room %d: %v", index, err)
		}
	}
	authorizer.staleReservation = "reservation-064"
	report := registry.RefreshAll(
		context.Background(),
		now.Add(2*time.Second),
	)

	if report.Refreshed != 129 || len(report.Lost) != 1 ||
		report.Lost[0].RoomName != "room-064" {
		t.Fatalf("unexpected refresh report: %+v", report)
	}
	if authorizer.BatchCalls() != 3 {
		t.Fatalf("expected three bounded batches, got %d", authorizer.BatchCalls())
	}
	if err := registry.Assert("room-063", now.Add(3*time.Second)); err != nil {
		t.Fatalf("healthy room was lost: %v", err)
	}
}

func TestPlacementMetadataRejectsMissingOwnerContractAndWrongNode(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	registry := mustRegistry(t, newFakeBatchAuthorizer(now))
	for _, metadata := range []string{
		`{}`,
		placementMetadata("interaction-a", "reservation-a", "0"),
		`{"placement":{"interaction_id":"interaction-a","reservation_id":"reservation-a","owner_node_id":"livekit-other","owner_epoch":"12884901889"}}`,
	} {
		if _, err := registry.OpenOrAssert(
			context.Background(),
			"room-a",
			metadata,
			now,
		); err == nil {
			t.Fatalf("expected invalid placement metadata: %s", metadata)
		}
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
		NodeID:          "livekit-a",
		Authorizer:      authorizer,
		BatchAuthorizer: authorizer,
		RefreshInterval: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	return registry
}

func placementMetadata(
	interactionID string,
	reservationID string,
	ownerEpoch string,
) string {
	return fmt.Sprintf(
		`{"tenant_id":"tenant-a","placement":{"interaction_id":"%s","reservation_id":"%s","owner_node_id":"livekit-a","owner_epoch":"%s"}}`,
		interactionID,
		reservationID,
		ownerEpoch,
	)
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
				StatusCode: 409,
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
		Component:      "livekit",
		NodeID:         "livekit-a",
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
