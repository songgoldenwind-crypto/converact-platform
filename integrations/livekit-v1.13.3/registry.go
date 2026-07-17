package livekitowner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	componenthook "ivekit.local/componenthook"
)

var (
	ErrPlacementMetadataInvalid = errors.New("ivekit livekit placement metadata invalid")
	ErrRoomOwnerMismatch        = errors.New("ivekit livekit room owner mismatch")
	ErrRoomOwnerMissing         = errors.New("ivekit livekit room owner missing")
)

type BatchAuthorizer interface {
	AuthorizeBatch(
		context.Context,
		[]componenthook.AuthorizationRequest,
	) ([]componenthook.BatchAuthorizationResult, error)
}

type Config struct {
	Enabled         bool
	Required        bool
	NodeID          string
	Authorizer      componenthook.Authorizer
	BatchAuthorizer BatchAuthorizer
	RefreshInterval time.Duration
}

type Registry struct {
	enabled         bool
	nodeID          string
	authorizer      componenthook.Authorizer
	batchAuthorizer BatchAuthorizer
	refreshInterval time.Duration

	mu    sync.Mutex
	rooms map[string]*roomOwner

	runMu     sync.Mutex
	runCancel context.CancelFunc
	runDone   chan struct{}
}

type placementIdentity struct {
	InteractionID string
	ReservationID string
	OwnerNodeID   string
	OwnerEpoch    string
}

type roomOwner struct {
	ready     chan struct{}
	placement placementIdentity
	guard     *componenthook.Guard
	err       error
}

type RefreshFailure struct {
	RoomName string
	Err      error
}

type RefreshReport struct {
	Refreshed int
	Deferred  int
	Lost      []RefreshFailure
}

func NewRegistry(config Config) (*Registry, error) {
	if !config.Enabled {
		if config.Required {
			return nil, fmt.Errorf("livekitowner: required registry is disabled")
		}
		return &Registry{rooms: make(map[string]*roomOwner)}, nil
	}
	if !validIdentifier(config.NodeID) ||
		config.Authorizer == nil || config.BatchAuthorizer == nil {
		return nil, fmt.Errorf("livekitowner: incomplete registry configuration")
	}
	interval := config.RefreshInterval
	if interval == 0 {
		interval = 3 * time.Second
	}
	if interval < 100*time.Millisecond || interval > time.Minute {
		return nil, fmt.Errorf("livekitowner: invalid refresh interval")
	}
	return &Registry{
		enabled:         true,
		nodeID:          config.NodeID,
		authorizer:      config.Authorizer,
		batchAuthorizer: config.BatchAuthorizer,
		refreshInterval: interval,
		rooms:           make(map[string]*roomOwner),
	}, nil
}

func NewRegistryFromEnv() (*Registry, error) {
	endpoint := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_ENDPOINT"))
	token := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_TOKEN"))
	nodeID := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_ID"))
	required, err := boolValue(os.Getenv("IVEKIT_OWNER_GUARD_REQUIRED"))
	if err != nil {
		return nil, err
	}
	enabled := endpoint != "" || token != "" || nodeID != "" || required
	if !enabled {
		return NewRegistry(Config{})
	}
	refreshTimeout, err := durationMilliseconds(
		os.Getenv("IVEKIT_OWNER_REFRESH_TIMEOUT_MS"),
		time.Second,
		100*time.Millisecond,
		30*time.Second,
	)
	if err != nil {
		return nil, err
	}
	refreshInterval, err := durationMilliseconds(
		os.Getenv("IVEKIT_OWNER_REFRESH_INTERVAL_MS"),
		3*time.Second,
		100*time.Millisecond,
		time.Minute,
	)
	if err != nil {
		return nil, err
	}
	authorizer, err := componenthook.NewHTTPAuthorizer(
		componenthook.HTTPAuthorizerConfig{
			Endpoint:     endpoint,
			ServiceToken: token,
			Timeout:      refreshTimeout,
		},
	)
	if err != nil {
		return nil, err
	}
	return NewRegistry(Config{
		Enabled:         true,
		Required:        required,
		NodeID:          nodeID,
		Authorizer:      authorizer,
		BatchAuthorizer: authorizer,
		RefreshInterval: refreshInterval,
	})
}

func (registry *Registry) OpenOrAssert(
	ctx context.Context,
	roomName string,
	rawMetadata string,
	now time.Time,
) (bool, error) {
	if !registry.enabled {
		return false, nil
	}
	if !validRoomName(roomName) {
		return false, ErrPlacementMetadataInvalid
	}
	placement, err := parsePlacement(rawMetadata)
	if err != nil {
		return false, err
	}
	if placement.OwnerNodeID != registry.nodeID {
		return false, ErrRoomOwnerMismatch
	}

	registry.mu.Lock()
	existing := registry.rooms[roomName]
	if existing != nil {
		registry.mu.Unlock()
		<-existing.ready
		if existing.err != nil {
			return false, existing.err
		}
		if existing.placement != placement {
			return false, ErrRoomOwnerMismatch
		}
		return false, existing.guard.AssertMutation(placement.OwnerEpoch, now)
	}
	entry := &roomOwner{
		ready:     make(chan struct{}),
		placement: placement,
	}
	registry.rooms[roomName] = entry
	registry.mu.Unlock()

	guard := componenthook.NewGuard(registry.authorizer)
	err = guard.Open(ctx, componenthook.Request{
		ReservationID: placement.ReservationID,
		InteractionID: placement.InteractionID,
		OwnerEpoch:    placement.OwnerEpoch,
	}, now)
	if err == nil {
		var snapshot componenthook.GuardSnapshot
		snapshot, err = guard.Snapshot()
		if err == nil &&
			(snapshot.Component != "livekit" ||
				snapshot.NodeID != registry.nodeID) {
			err = ErrRoomOwnerMismatch
		}
	}

	registry.mu.Lock()
	entry.guard = guard
	entry.err = err
	if err != nil && registry.rooms[roomName] == entry {
		delete(registry.rooms, roomName)
	}
	close(entry.ready)
	registry.mu.Unlock()
	return err == nil, err
}

func (registry *Registry) Assert(roomName string, now time.Time) error {
	if !registry.enabled {
		return nil
	}
	registry.mu.Lock()
	entry := registry.rooms[roomName]
	registry.mu.Unlock()
	if entry == nil {
		return ErrRoomOwnerMissing
	}
	<-entry.ready
	if entry.err != nil {
		return entry.err
	}
	return entry.guard.AssertCurrent(now)
}

func (registry *Registry) Close(
	ctx context.Context,
	roomName string,
) error {
	if !registry.enabled {
		return nil
	}
	registry.mu.Lock()
	entry := registry.rooms[roomName]
	if entry != nil {
		delete(registry.rooms, roomName)
	}
	registry.mu.Unlock()
	if entry == nil {
		return nil
	}
	<-entry.ready
	if entry.err != nil {
		return entry.err
	}
	return entry.guard.Close(ctx)
}

func (registry *Registry) RefreshAll(
	ctx context.Context,
	now time.Time,
) RefreshReport {
	if !registry.enabled {
		return RefreshReport{}
	}
	entries := registry.readyEntries()
	report := RefreshReport{}
	for start := 0; start < len(entries); start += 64 {
		end := min(start+64, len(entries))
		registry.refreshBatch(ctx, now, entries[start:end], &report)
	}
	return report
}

func (registry *Registry) Run(
	ctx context.Context,
	onLost func(roomName string, err error),
) {
	if !registry.enabled {
		<-ctx.Done()
		return
	}
	ticker := time.NewTicker(registry.refreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			report := registry.RefreshAll(ctx, now)
			if onLost != nil {
				for _, failure := range report.Lost {
					onLost(failure.RoomName, failure.Err)
				}
			}
		}
	}
}

func (registry *Registry) Start(
	onLost func(roomName string, err error),
) error {
	if !registry.enabled {
		return nil
	}
	registry.runMu.Lock()
	defer registry.runMu.Unlock()
	if registry.runCancel != nil {
		return errors.New("livekitowner: refresh loop already started")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	registry.runCancel = cancel
	registry.runDone = done
	go func() {
		defer close(done)
		registry.Run(ctx, onLost)
	}()
	return nil
}

func (registry *Registry) Stop() {
	registry.runMu.Lock()
	cancel := registry.runCancel
	done := registry.runDone
	registry.runCancel = nil
	registry.runDone = nil
	registry.runMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
}

func (registry *Registry) readyEntries() []namedRoomOwner {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entries := make([]namedRoomOwner, 0, len(registry.rooms))
	for roomName, entry := range registry.rooms {
		select {
		case <-entry.ready:
			if entry.err == nil {
				snapshot, err := entry.guard.Snapshot()
				if err == nil && !snapshot.Closed {
					entries = append(entries, namedRoomOwner{
						roomName: roomName,
						entry:    entry,
						snapshot: snapshot,
					})
				}
			}
		default:
		}
	}
	sort.Slice(entries, func(left, right int) bool {
		return entries[left].roomName < entries[right].roomName
	})
	return entries
}

type namedRoomOwner struct {
	roomName string
	entry    *roomOwner
	snapshot componenthook.GuardSnapshot
}

func (registry *Registry) refreshBatch(
	ctx context.Context,
	now time.Time,
	entries []namedRoomOwner,
	report *RefreshReport,
) {
	requests := make([]componenthook.AuthorizationRequest, 0, len(entries))
	for _, value := range entries {
		requests = append(requests, componenthook.AuthorizationRequest{
			Request:   value.snapshot.Request,
			Operation: componenthook.OperationMutate,
		})
	}
	results, err := registry.batchAuthorizer.AuthorizeBatch(ctx, requests)
	if err != nil {
		for _, value := range entries {
			if currentErr := value.entry.guard.AssertCurrent(now); currentErr != nil {
				registry.lose(value, currentErr, report)
			} else {
				report.Deferred++
			}
		}
		return
	}
	if len(results) != len(entries) {
		err = errors.New("livekitowner: incomplete batch authorization")
		for _, value := range entries {
			registry.lose(value, err, report)
		}
		return
	}
	for index, result := range results {
		value := entries[index]
		if result.Request != requests[index] {
			registry.lose(
				value,
				errors.New("livekitowner: reordered batch authorization"),
				report,
			)
			continue
		}
		if result.Error != nil {
			if result.Error.Retryable &&
				value.entry.guard.AssertCurrent(now) == nil {
				report.Deferred++
			} else {
				registry.lose(value, result.Error, report)
			}
			continue
		}
		if err := value.entry.guard.ApplyRefresh(
			result.Authorization,
			now,
		); err != nil {
			registry.lose(value, err, report)
			continue
		}
		report.Refreshed++
	}
}

func (registry *Registry) lose(
	value namedRoomOwner,
	err error,
	report *RefreshReport,
) {
	value.entry.guard.Fence()
	report.Lost = append(report.Lost, RefreshFailure{
		RoomName: value.roomName,
		Err:      err,
	})
}

func parsePlacement(raw string) (placementIdentity, error) {
	if len(raw) == 0 || len(raw) > 65_536 {
		return placementIdentity{}, ErrPlacementMetadataInvalid
	}
	var metadata struct {
		Placement struct {
			InteractionID string `json:"interaction_id"`
			ReservationID string `json:"reservation_id"`
			OwnerNodeID   string `json:"owner_node_id"`
			OwnerEpoch    string `json:"owner_epoch"`
		} `json:"placement"`
	}
	if err := json.Unmarshal([]byte(raw), &metadata); err != nil {
		return placementIdentity{}, ErrPlacementMetadataInvalid
	}
	placement := placementIdentity{
		InteractionID: metadata.Placement.InteractionID,
		ReservationID: metadata.Placement.ReservationID,
		OwnerNodeID:   metadata.Placement.OwnerNodeID,
		OwnerEpoch:    metadata.Placement.OwnerEpoch,
	}
	if !validIdentifier(placement.InteractionID) ||
		!validIdentifier(placement.ReservationID) ||
		!validIdentifier(placement.OwnerNodeID) ||
		!validOwnerEpoch(placement.OwnerEpoch) {
		return placementIdentity{}, ErrPlacementMetadataInvalid
	}
	return placement, nil
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

func validRoomName(value string) bool {
	return value != "" && len(value) <= 255 &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func validOwnerEpoch(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && parsed > 0 && value == strconv.FormatUint(parsed, 10)
}

func boolValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, fmt.Errorf("livekitowner: invalid boolean")
	}
}

func durationMilliseconds(
	value string,
	fallback time.Duration,
	minimum time.Duration,
	maximum time.Duration,
) (time.Duration, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("livekitowner: invalid duration")
	}
	result := time.Duration(parsed) * time.Millisecond
	if result < minimum || result > maximum {
		return 0, fmt.Errorf("livekitowner: duration out of range")
	}
	return result, nil
}
