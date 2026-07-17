package componenthook

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"
)

type Operation string

const (
	OperationOpen   Operation = "open"
	OperationMutate Operation = "mutate"
	OperationClose  Operation = "close"
)

var (
	ErrAlreadyOpen             = errors.New("ivekit component owner already open")
	ErrNotOpen                 = errors.New("ivekit component owner is not open")
	ErrClosed                  = errors.New("ivekit component owner is closed")
	ErrStaleOwnerEpoch         = errors.New("ivekit component owner epoch is stale")
	ErrOwnerEpochAhead         = errors.New("ivekit component owner epoch is ahead")
	ErrLeaseExpired            = errors.New("ivekit component node lease expired")
	ErrAuthorizationMismatch   = errors.New("ivekit component authorization mismatch")
	ErrStateSequenceRegression = errors.New("ivekit component state sequence regressed")
)

type Request struct {
	ReservationID string `json:"reservation_id"`
	InteractionID string `json:"interaction_id"`
	OwnerEpoch    string `json:"owner_epoch"`
}

type AuthorizationRequest struct {
	Request
	Operation Operation `json:"operation"`
}

type Authorization struct {
	Allowed        bool
	Component      string
	NodeID         string
	CellLeaseEpoch uint64
	OwnerEpoch     string
	StateSequence  uint64
	LeaseExpiresAt time.Time
}

type Authorizer interface {
	Authorize(context.Context, AuthorizationRequest) (Authorization, error)
}

type Guard struct {
	authorizer Authorizer
	state      atomic.Pointer[cachedState]
}

type cachedState struct {
	request        Request
	component      string
	nodeID         string
	cellLeaseEpoch uint64
	stateSequence  uint64
	leaseExpiresAt time.Time
	closed         bool
}

type GuardSnapshot struct {
	Request        Request
	Component      string
	NodeID         string
	CellLeaseEpoch uint64
	StateSequence  uint64
	LeaseExpiresAt time.Time
	Closed         bool
}

func NewGuard(authorizer Authorizer) *Guard {
	if authorizer == nil {
		panic("componenthook: authorizer is required")
	}
	return &Guard{authorizer: authorizer}
}

func (guard *Guard) Open(
	ctx context.Context,
	request Request,
	now time.Time,
) error {
	if guard.state.Load() != nil {
		return ErrAlreadyOpen
	}
	if err := validateRequest(request); err != nil {
		return err
	}
	authorization, err := guard.authorizer.Authorize(ctx, AuthorizationRequest{
		Request:   request,
		Operation: OperationOpen,
	})
	if err != nil {
		return err
	}
	state, err := stateFromAuthorization(request, authorization, now, true)
	if err != nil {
		return err
	}
	if !guard.state.CompareAndSwap(nil, state) {
		return ErrAlreadyOpen
	}
	return nil
}

func (guard *Guard) Refresh(ctx context.Context, now time.Time) error {
	current := guard.state.Load()
	if current == nil {
		return ErrNotOpen
	}
	if current.closed {
		return ErrClosed
	}
	authorization, err := guard.authorizer.Authorize(ctx, AuthorizationRequest{
		Request:   current.request,
		Operation: OperationMutate,
	})
	if err != nil {
		return err
	}
	return guard.ApplyRefresh(authorization, now)
}

func (guard *Guard) ApplyRefresh(
	authorization Authorization,
	now time.Time,
) error {
	for {
		current := guard.state.Load()
		if current == nil {
			return ErrNotOpen
		}
		if current.closed {
			return ErrClosed
		}
		next, err := stateFromAuthorization(
			current.request,
			authorization,
			now,
			true,
		)
		if err != nil {
			return err
		}
		if next.stateSequence < current.stateSequence {
			return ErrStateSequenceRegression
		}
		if next.component != current.component ||
			next.nodeID != current.nodeID ||
			next.cellLeaseEpoch != current.cellLeaseEpoch {
			return ErrAuthorizationMismatch
		}
		if guard.state.CompareAndSwap(current, next) {
			return nil
		}
	}
}

func (guard *Guard) AssertMutation(ownerEpoch string, now time.Time) error {
	current := guard.state.Load()
	if current == nil {
		return ErrNotOpen
	}
	if current.closed {
		return ErrClosed
	}
	provided, err := parseOwnerEpoch(ownerEpoch)
	if err != nil {
		return err
	}
	expected, _ := parseOwnerEpoch(current.request.OwnerEpoch)
	if provided < expected {
		return ErrStaleOwnerEpoch
	}
	if provided > expected {
		return ErrOwnerEpochAhead
	}
	if !now.Before(current.leaseExpiresAt) {
		return ErrLeaseExpired
	}
	return nil
}

func (guard *Guard) AssertCurrent(now time.Time) error {
	current := guard.state.Load()
	if current == nil {
		return ErrNotOpen
	}
	if current.closed {
		return ErrClosed
	}
	if !now.Before(current.leaseExpiresAt) {
		return ErrLeaseExpired
	}
	return nil
}

func (guard *Guard) Snapshot() (GuardSnapshot, error) {
	current := guard.state.Load()
	if current == nil {
		return GuardSnapshot{}, ErrNotOpen
	}
	return GuardSnapshot{
		Request:        current.request,
		Component:      current.component,
		NodeID:         current.nodeID,
		CellLeaseEpoch: current.cellLeaseEpoch,
		StateSequence:  current.stateSequence,
		LeaseExpiresAt: current.leaseExpiresAt,
		Closed:         current.closed,
	}, nil
}

func (guard *Guard) Fence() {
	for {
		current := guard.state.Load()
		if current == nil || current.closed {
			return
		}
		next := *current
		next.closed = true
		if guard.state.CompareAndSwap(current, &next) {
			return
		}
	}
}

func (guard *Guard) Close(ctx context.Context) error {
	current := guard.state.Load()
	if current == nil {
		return ErrNotOpen
	}
	if current.closed {
		return nil
	}
	authorization, err := guard.authorizer.Authorize(ctx, AuthorizationRequest{
		Request:   current.request,
		Operation: OperationClose,
	})
	if err != nil {
		return err
	}
	if _, err := stateFromAuthorization(
		current.request,
		authorization,
		time.Time{},
		false,
	); err != nil {
		return err
	}
	for {
		current = guard.state.Load()
		if current == nil {
			return ErrNotOpen
		}
		if current.closed {
			return nil
		}
		next := *current
		next.closed = true
		if guard.state.CompareAndSwap(current, &next) {
			return nil
		}
	}
}

func stateFromAuthorization(
	request Request,
	authorization Authorization,
	now time.Time,
	requireFresh bool,
) (*cachedState, error) {
	if !authorization.Allowed || authorization.Component == "" ||
		authorization.NodeID == "" || authorization.OwnerEpoch != request.OwnerEpoch {
		return nil, ErrAuthorizationMismatch
	}
	ownerEpoch, err := parseOwnerEpoch(authorization.OwnerEpoch)
	if err != nil {
		return nil, err
	}
	if ownerEpoch>>32 != authorization.CellLeaseEpoch {
		return nil, ErrAuthorizationMismatch
	}
	if authorization.LeaseExpiresAt.IsZero() {
		return nil, ErrAuthorizationMismatch
	}
	if requireFresh && !now.Before(authorization.LeaseExpiresAt) {
		return nil, ErrLeaseExpired
	}
	return &cachedState{
		request:        request,
		component:      authorization.Component,
		nodeID:         authorization.NodeID,
		cellLeaseEpoch: authorization.CellLeaseEpoch,
		stateSequence:  authorization.StateSequence,
		leaseExpiresAt: authorization.LeaseExpiresAt,
	}, nil
}

func validateRequest(request Request) error {
	for name, value := range map[string]string{
		"reservation_id": request.ReservationID,
		"interaction_id": request.InteractionID,
	} {
		if !validIdentifier(value) {
			return fmt.Errorf("componenthook: invalid %s", name)
		}
	}
	_, err := parseOwnerEpoch(request.OwnerEpoch)
	return err
}

func parseOwnerEpoch(value string) (uint64, error) {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 || value == "" ||
		(len(value) > 1 && value[0] == '0') {
		return 0, fmt.Errorf("componenthook: invalid owner epoch")
	}
	return parsed, nil
}

func validIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 255 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' ||
				character == ':' || character == '-')) {
			continue
		}
		return false
	}
	return true
}
