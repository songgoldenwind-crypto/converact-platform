package componenthook

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestGuardUsesNetworkOnlyForOwnershipTransitions(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := &fakeAuthorizer{
		responses: []Authorization{
			authorization(now, 1),
			authorization(now.Add(time.Second), 2),
			authorization(now.Add(2*time.Second), 3),
		},
	}
	guard := NewGuard(authorizer)
	request := Request{
		ReservationID: "reservation-a",
		InteractionID: "room-a",
		OwnerEpoch:    "12884901889",
	}

	if err := guard.Open(context.Background(), request, now); err != nil {
		t.Fatalf("open: %v", err)
	}
	for index := 0; index < 10_000; index++ {
		if err := guard.AssertMutation(request.OwnerEpoch, now.Add(500*time.Millisecond)); err != nil {
			t.Fatalf("assert mutation %d: %v", index, err)
		}
	}
	if calls := authorizer.Calls(); len(calls) != 1 {
		t.Fatalf("hot path made network calls: %v", calls)
	}

	if err := guard.Refresh(context.Background(), now.Add(time.Second)); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if err := guard.Close(context.Background()); err != nil {
		t.Fatalf("close: %v", err)
	}
	if calls := authorizer.Calls(); len(calls) != 3 {
		t.Fatalf("expected open, refresh, close calls; got %v", calls)
	}
	if calls := authorizer.Calls(); calls[0].Operation != OperationOpen ||
		calls[1].Operation != OperationMutate ||
		calls[2].Operation != OperationClose {
		t.Fatalf("unexpected operations: %v", calls)
	}
}

func TestGuardRejectsStaleEpochExpiredLeaseAndSequenceRegression(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	authorizer := &fakeAuthorizer{
		responses: []Authorization{
			authorization(now, 5),
			authorization(now.Add(time.Second), 4),
		},
	}
	guard := NewGuard(authorizer)
	request := Request{
		ReservationID: "reservation-a",
		InteractionID: "room-a",
		OwnerEpoch:    "12884901889",
	}
	if err := guard.Open(context.Background(), request, now); err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := guard.AssertMutation("12884901888", now); !errors.Is(err, ErrStaleOwnerEpoch) {
		t.Fatalf("expected stale epoch, got %v", err)
	}
	if err := guard.AssertMutation(request.OwnerEpoch, now.Add(11*time.Second)); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("expected lease expiry, got %v", err)
	}
	if err := guard.Refresh(context.Background(), now.Add(time.Second)); !errors.Is(err, ErrStateSequenceRegression) {
		t.Fatalf("expected sequence regression, got %v", err)
	}
}

func TestGuardValidatesAgentResponseIdentity(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	value := authorization(now, 1)
	value.OwnerEpoch = "17179869185"
	guard := NewGuard(&fakeAuthorizer{responses: []Authorization{value}})
	err := guard.Open(context.Background(), Request{
		ReservationID: "reservation-a",
		InteractionID: "room-a",
		OwnerEpoch:    "12884901889",
	}, now)
	if !errors.Is(err, ErrAuthorizationMismatch) {
		t.Fatalf("expected authorization mismatch, got %v", err)
	}
}

func TestGuardAppliesBatchRefreshAndExposesOnlyBoundedIdentity(t *testing.T) {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	guard := NewGuard(&fakeAuthorizer{
		responses: []Authorization{authorization(now, 1)},
	})
	request := Request{
		ReservationID: "reservation-a",
		InteractionID: "room-a",
		OwnerEpoch:    "12884901889",
	}
	if err := guard.Open(context.Background(), request, now); err != nil {
		t.Fatalf("open: %v", err)
	}
	next := authorization(now.Add(time.Second), 2)
	if err := guard.ApplyRefresh(next, now.Add(time.Second)); err != nil {
		t.Fatalf("apply refresh: %v", err)
	}
	if err := guard.AssertCurrent(now.Add(2 * time.Second)); err != nil {
		t.Fatalf("assert current: %v", err)
	}
	snapshot, err := guard.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Request != request || snapshot.Component != "livekit" ||
		snapshot.NodeID != "livekit-a" || snapshot.StateSequence != 2 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if err := guard.AssertCurrent(now.Add(12 * time.Second)); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("expected expired lease, got %v", err)
	}
}

func authorization(now time.Time, sequence uint64) Authorization {
	return Authorization{
		Allowed:        true,
		Component:      "livekit",
		NodeID:         "livekit-a",
		CellLeaseEpoch: 3,
		OwnerEpoch:     "12884901889",
		StateSequence:  sequence,
		LeaseExpiresAt: now.Add(10 * time.Second),
	}
}

type fakeAuthorizer struct {
	mu        sync.Mutex
	responses []Authorization
	calls     []AuthorizationRequest
}

func (fake *fakeAuthorizer) Authorize(
	_ context.Context,
	request AuthorizationRequest,
) (Authorization, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.calls = append(fake.calls, request)
	if len(fake.responses) == 0 {
		return Authorization{}, errors.New("no fake response")
	}
	response := fake.responses[0]
	fake.responses = fake.responses[1:]
	return response, nil
}

func (fake *fakeAuthorizer) Calls() []AuthorizationRequest {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]AuthorizationRequest(nil), fake.calls...)
}
