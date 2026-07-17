package tinodeowner

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	componenthook "ivekit.local/componenthook"
)

const maximumRequestBytes = 65_536

var (
	ErrPlacementMetadataInvalid = errors.New("ivekit tinode placement metadata invalid")
	ErrTopicOwnerMismatch       = errors.New("ivekit tinode topic owner mismatch")
	ErrTopicOwnerMissing        = errors.New("ivekit tinode topic owner missing")
)

type BatchAuthorizer interface {
	AuthorizeBatch(
		context.Context,
		[]componenthook.AuthorizationRequest,
	) ([]componenthook.BatchAuthorizationResult, error)
}

type Placement struct {
	InteractionID string `json:"interaction_id"`
	ReservationID string `json:"reservation_id"`
	OwnerNodeID   string `json:"owner_node_id"`
	OwnerEpoch    string `json:"owner_epoch"`
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

	mu     sync.Mutex
	topics map[string]*topicOwner

	runMu     sync.Mutex
	runCancel context.CancelFunc
	runDone   chan struct{}
}

type topicOwner struct {
	ready     chan struct{}
	placement Placement
	guard     *componenthook.Guard
	err       error
}

type RefreshFailure struct {
	TopicName string
	Err       error
}

type RefreshReport struct {
	Refreshed int
	Deferred  int
	Lost      []RefreshFailure
}

func NewRegistry(config Config) (*Registry, error) {
	if !config.Enabled {
		if config.Required {
			return nil, fmt.Errorf("tinodeowner: required registry is disabled")
		}
		return &Registry{topics: make(map[string]*topicOwner)}, nil
	}
	if !validIdentifier(config.NodeID) ||
		config.Authorizer == nil || config.BatchAuthorizer == nil {
		return nil, fmt.Errorf("tinodeowner: incomplete registry configuration")
	}
	interval := config.RefreshInterval
	if interval == 0 {
		interval = 3 * time.Second
	}
	if interval < 100*time.Millisecond || interval > time.Minute {
		return nil, fmt.Errorf("tinodeowner: invalid refresh interval")
	}
	return &Registry{
		enabled:         true,
		nodeID:          config.NodeID,
		authorizer:      config.Authorizer,
		batchAuthorizer: config.BatchAuthorizer,
		refreshInterval: interval,
		topics:          make(map[string]*topicOwner),
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
	timeout, err := durationMilliseconds(
		os.Getenv("IVEKIT_OWNER_REFRESH_TIMEOUT_MS"),
		time.Second,
		100*time.Millisecond,
		30*time.Second,
	)
	if err != nil {
		return nil, err
	}
	interval, err := durationMilliseconds(
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
			Timeout:      timeout,
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
		RefreshInterval: interval,
	})
}

func (registry *Registry) OpenOrAssert(
	ctx context.Context,
	topicName string,
	trusted any,
	now time.Time,
) (bool, error) {
	if !registry.enabled {
		return false, nil
	}
	placement, hasPlacement, err := ParseTrustedPlacement(trusted)
	if err != nil {
		return false, err
	}
	if !hasPlacement {
		if !registry.IsManaged(topicName) {
			return false, nil
		}
		return false, registry.Assert(topicName, now)
	}

	registry.mu.Lock()
	existing := registry.topics[topicName]
	registry.mu.Unlock()
	if existing != nil {
		<-existing.ready
		if existing.err != nil {
			return false, existing.err
		}
		if existing.placement != placement {
			if !sameInteractionNewerOwner(existing.placement, placement) {
				return false, ErrTopicOwnerMismatch
			}
		}
		return false, existing.guard.AssertCurrent(now)
	}
	return registry.Prepare(ctx, topicName, placement, now)
}

func (registry *Registry) Prepare(
	ctx context.Context,
	topicName string,
	placement Placement,
	now time.Time,
) (bool, error) {
	if !registry.enabled {
		return false, nil
	}
	if !validTopicName(topicName) || validatePlacement(placement) != nil {
		return false, ErrPlacementMetadataInvalid
	}
	if placement.OwnerNodeID != registry.nodeID {
		return false, ErrTopicOwnerMismatch
	}

	registry.mu.Lock()
	existing := registry.topics[topicName]
	if existing != nil {
		registry.mu.Unlock()
		<-existing.ready
		if existing.err != nil {
			return false, existing.err
		}
		if existing.placement != placement {
			return false, ErrTopicOwnerMismatch
		}
		return false, existing.guard.AssertMutation(placement.OwnerEpoch, now)
	}
	entry := &topicOwner{
		ready:     make(chan struct{}),
		placement: placement,
	}
	registry.topics[topicName] = entry
	registry.mu.Unlock()

	guard := componenthook.NewGuard(registry.authorizer)
	err := guard.Open(ctx, componenthook.Request{
		ReservationID: placement.ReservationID,
		InteractionID: placement.InteractionID,
		OwnerEpoch:    placement.OwnerEpoch,
	}, now)
	if err == nil {
		var snapshot componenthook.GuardSnapshot
		snapshot, err = guard.Snapshot()
		if err == nil &&
			(snapshot.Component != "tinode" ||
				snapshot.NodeID != registry.nodeID) {
			err = ErrTopicOwnerMismatch
		}
	}

	registry.mu.Lock()
	entry.guard = guard
	entry.err = err
	if err != nil && registry.topics[topicName] == entry {
		delete(registry.topics, topicName)
	}
	close(entry.ready)
	registry.mu.Unlock()
	return err == nil, err
}

func (registry *Registry) IsManaged(topicName string) bool {
	if !registry.enabled {
		return false
	}
	registry.mu.Lock()
	_, ok := registry.topics[topicName]
	registry.mu.Unlock()
	return ok
}

func (registry *Registry) Assert(topicName string, now time.Time) error {
	if !registry.enabled {
		return nil
	}
	registry.mu.Lock()
	entry := registry.topics[topicName]
	registry.mu.Unlock()
	if entry == nil {
		return ErrTopicOwnerMissing
	}
	<-entry.ready
	if entry.err != nil {
		return entry.err
	}
	return entry.guard.AssertCurrent(now)
}

func (registry *Registry) Close(ctx context.Context, topicName string) error {
	if !registry.enabled {
		return nil
	}
	registry.mu.Lock()
	entry := registry.topics[topicName]
	if entry != nil {
		delete(registry.topics, topicName)
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

func (registry *Registry) Start(
	onLost func(topicName string, err error),
) error {
	if !registry.enabled {
		return nil
	}
	registry.runMu.Lock()
	defer registry.runMu.Unlock()
	if registry.runCancel != nil {
		return errors.New("tinodeowner: refresh loop already started")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	registry.runCancel = cancel
	registry.runDone = done
	go func() {
		defer close(done)
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
						onLost(failure.TopicName, failure.Err)
					}
				}
			}
		}
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

type namedTopicOwner struct {
	topicName string
	entry     *topicOwner
	snapshot  componenthook.GuardSnapshot
}

func (registry *Registry) readyEntries() []namedTopicOwner {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entries := make([]namedTopicOwner, 0, len(registry.topics))
	for topicName, entry := range registry.topics {
		select {
		case <-entry.ready:
			if entry.err == nil {
				snapshot, err := entry.guard.Snapshot()
				if err == nil && !snapshot.Closed {
					entries = append(entries, namedTopicOwner{
						topicName: topicName,
						entry:     entry,
						snapshot:  snapshot,
					})
				}
			}
		default:
		}
	}
	sort.Slice(entries, func(left, right int) bool {
		return entries[left].topicName < entries[right].topicName
	})
	return entries
}

func (registry *Registry) refreshBatch(
	ctx context.Context,
	now time.Time,
	entries []namedTopicOwner,
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
		err = errors.New("tinodeowner: incomplete batch authorization")
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
				errors.New("tinodeowner: reordered batch authorization"),
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
	value namedTopicOwner,
	err error,
	report *RefreshReport,
) {
	value.entry.guard.Fence()
	report.Lost = append(report.Lost, RefreshFailure{
		TopicName: value.topicName,
		Err:       err,
	})
}

func ParseTrustedPlacement(trusted any) (Placement, bool, error) {
	if trusted == nil {
		return Placement{}, false, nil
	}
	raw, err := json.Marshal(trusted)
	if err != nil || len(raw) == 0 || len(raw) > maximumRequestBytes {
		return Placement{}, false, ErrPlacementMetadataInvalid
	}
	var metadata struct {
		Placement *Placement `json:"ivekit_placement"`
	}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return Placement{}, false, ErrPlacementMetadataInvalid
	}
	if metadata.Placement == nil {
		return Placement{}, false, nil
	}
	if err := validatePlacement(*metadata.Placement); err != nil {
		return Placement{}, false, err
	}
	return *metadata.Placement, true, nil
}

func NewHTTPHandler(registry *Registry, serviceToken string) (http.Handler, error) {
	if registry == nil {
		return nil, errors.New("tinodeowner: registry is required")
	}
	token := strings.TrimSpace(serviceToken)
	if len(token) < 24 || len(token) > 512 ||
		strings.ContainsAny(token, "\x00\r\n") {
		return nil, errors.New("tinodeowner: invalid owner API token")
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		if !validBearer(request.Header.Get("Authorization"), token) {
			writeError(writer, http.StatusUnauthorized, "unauthorized")
			return
		}
		if request.ContentLength > maximumRequestBytes {
			writeError(writer, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(
			request.Body,
			maximumRequestBytes+1,
		))
		if err != nil || len(raw) > maximumRequestBytes {
			writeError(writer, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		var input struct {
			TopicName string    `json:"topic_name"`
			Placement Placement `json:"placement"`
		}
		if json.Unmarshal(raw, &input) != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		opened, err := registry.Prepare(
			request.Context(),
			input.TopicName,
			input.Placement,
			time.Now(),
		)
		if err != nil {
			writeError(writer, http.StatusConflict, "owner_rejected")
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"data": map[string]any{
				"topic_name": input.TopicName,
				"opened":     opened,
			},
		})
	}), nil
}

func NewHTTPHandlerFromEnv(registry *Registry) (http.Handler, error) {
	token := strings.TrimSpace(os.Getenv("IVEKIT_TINODE_OWNER_API_TOKEN"))
	if token == "" {
		return nil, nil
	}
	return NewHTTPHandler(registry, token)
}

func validatePlacement(placement Placement) error {
	if !validIdentifier(placement.InteractionID) ||
		!validIdentifier(placement.ReservationID) ||
		!validIdentifier(placement.OwnerNodeID) ||
		!validOwnerEpoch(placement.OwnerEpoch) {
		return ErrPlacementMetadataInvalid
	}
	return nil
}

func sameInteractionNewerOwner(current, persisted Placement) bool {
	currentEpoch, currentErr := strconv.ParseUint(current.OwnerEpoch, 10, 64)
	persistedEpoch, persistedErr := strconv.ParseUint(persisted.OwnerEpoch, 10, 64)
	return currentErr == nil && persistedErr == nil &&
		current.InteractionID == persisted.InteractionID &&
		currentEpoch > persistedEpoch
}

func validBearer(header, expected string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	actual := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if len(actual) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"error": map[string]any{"code": code},
	})
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

func validTopicName(value string) bool {
	return strings.HasPrefix(value, "grp") && len(value) <= 255 &&
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
		return false, fmt.Errorf("tinodeowner: invalid boolean")
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
		return 0, fmt.Errorf("tinodeowner: invalid duration")
	}
	result := time.Duration(parsed) * time.Millisecond
	if result < minimum || result > maximum {
		return 0, fmt.Errorf("tinodeowner: duration out of range")
	}
	return result, nil
}
